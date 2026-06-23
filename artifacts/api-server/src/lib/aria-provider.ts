import { randomBytes } from "crypto";
import { spawn } from "child_process";
import { logger } from "./logger";

export interface ChatMessage { role: string; content: string; }

const UA_BROWSER = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Mobile Safari/537.36 OPR/89.0.0.0";

const TOKEN_EP  = "https://oauth2.opera-api.com/oauth2/v1/token/";
const SIGNUP_EP = "https://auth.opera.com/account/v2/external/anonymous/signup";
const CHAT_EP   = "https://composer.opera-api.com/api/v2/a-chat";

// ── curl helper ─────────────────────────────────────────────────────────────

interface CurlResult {
  json?: unknown;
  raw?: string;
  childProcess?: ReturnType<typeof spawn>;
}

function curlPost(
  url: string,
  headers: Record<string, string>,
  body: string,
  options: { stream?: boolean; timeoutSecs?: number } = {},
): Promise<CurlResult> {
  return new Promise((resolve, reject) => {
    const timeout = options.timeoutSecs ?? 25;
    const args: string[] = ["-s", "-X", "POST", url, "--max-time", String(timeout)];

    for (const [k, v] of Object.entries(headers)) {
      args.push("-H", `${k}: ${v}`);
    }
    args.push("--data-binary", body);
    if (options.stream) args.push("-N");

    const proc = spawn("curl", args, { stdio: ["ignore", "pipe", "pipe"] });

    if (options.stream) {
      resolve({ childProcess: proc });
      return;
    }

    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    proc.stdout.on("data", (c: Buffer) => chunks.push(c));
    proc.stderr.on("data", (c: Buffer) => errChunks.push(c));
    proc.on("close", (code) => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (code !== 0) {
        const msg = Buffer.concat(errChunks).toString("utf8");
        return reject(new Error(`curl exited ${code}: ${msg.slice(0, 200)}`));
      }
      try { resolve({ json: JSON.parse(raw), raw }); }
      catch { resolve({ raw }); }
    });
    proc.on("error", reject);
  });
}

// ── Session management with mutex ──────────────────────────────────────────

interface AriaSession {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

let _session: AriaSession | null = null;
let _sessionLock: Promise<AriaSession> | null = null;

async function createSession(): Promise<AriaSession> {
  const r1 = await curlPost(TOKEN_EP, {
    "Content-Type": "application/x-www-form-urlencoded",
    "User-Agent": UA_BROWSER,
  }, "client_id=ofa-client&client_secret=N9OscfA3KxlJASuIe29PGZ5RpWaMTBoy&grant_type=client_credentials&scope=anonymous_account");
  const d1 = r1.json as { access_token?: string };
  if (!d1?.access_token) throw new Error(`Aria step1 failed: ${r1.raw?.slice(0, 200)}`);

  const r2 = await curlPost(SIGNUP_EP, {
    "Authorization": `Bearer ${d1.access_token}`,
    "Accept": "application/json",
    "Content-Type": "application/json",
  }, JSON.stringify({ client_id: "ofa", service: "aria" }));
  const d2 = r2.json as { token?: string };
  if (!d2?.token) throw new Error(`Aria step2 failed: ${r2.raw?.slice(0, 200)}`);

  const r3 = await curlPost(TOKEN_EP, {
    "Content-Type": "application/x-www-form-urlencoded",
    "User-Agent": UA_BROWSER,
  }, `auth_token=${encodeURIComponent(d2.token)}&client_id=ofa&device_name=GPT4FREE&grant_type=auth_token&scope=ALL`);
  const d3 = r3.json as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!d3?.refresh_token) throw new Error(`Aria step3 failed: ${r3.raw?.slice(0, 200)}`);

  return {
    accessToken: d3.access_token!,
    refreshToken: d3.refresh_token,
    expiresAt: Date.now() + ((d3.expires_in ?? 3600) - 120) * 1000,
  };
}

async function refreshSession(session: AriaSession): Promise<AriaSession> {
  const r = await curlPost(TOKEN_EP, {
    "Content-Type": "application/x-www-form-urlencoded",
    "User-Agent": UA_BROWSER,
  }, `client_id=ofa&grant_type=refresh_token&refresh_token=${encodeURIComponent(session.refreshToken)}&scope=shodan:aria+user:read`);
  const d = r.json as { access_token?: string; expires_in?: number };
  if (!d?.access_token) throw new Error(`Aria refresh failed: ${r.raw?.slice(0, 200)}`);
  return {
    accessToken: d.access_token,
    refreshToken: session.refreshToken,
    expiresAt: Date.now() + ((d.expires_in ?? 3600) - 120) * 1000,
  };
}

async function getSession(): Promise<AriaSession> {
  if (_session && Date.now() < _session.expiresAt) return _session;
  if (_sessionLock) return _sessionLock;

  _sessionLock = (async () => {
    try {
      if (_session && Date.now() < _session.expiresAt) return _session;
      if (_session) {
        try {
          logger.info("Aria: refreshing expired session");
          _session = await refreshSession(_session);
          return _session;
        } catch {
          logger.warn("Aria: refresh failed, creating new session");
          _session = null;
        }
      }
      logger.info("Aria: creating new anonymous session");
      _session = await createSession();
      return _session;
    } finally {
      _sessionLock = null;
    }
  })();

  return _sessionLock;
}

function invalidateSession(): void {
  _session = null;
  _sessionLock = null;
}

// ── Chat helpers ─────────────────────────────────────────────────────────────

function buildQuery(messages: ChatMessage[]): string {
  return messages.map(m => {
    if (m.role === "system") return `System: ${m.content}`;
    if (m.role === "assistant") return `Assistant: ${m.content}`;
    return m.content;
  }).join("\n\n");
}

function buildChatBody(query: string, encKey: string): string {
  return JSON.stringify({
    query,
    stream: true,
    linkify: false,
    linkify_version: 3,
    sia: false,
    media_attachments: [],
    encryption: { key: encKey },
  });
}

function chatHeaders(token: string): Record<string, string> {
  return {
    "Accept": "text/event-stream",
    "Authorization": `Bearer ${token}`,
    "Content-Type": "application/json",
    "Origin": "opera-aria://ui",
    "User-Agent": UA_BROWSER,
    "X-Opera-Timezone": "+07:00",
    "X-Opera-UI-Language": "en",
  };
}

function parseAriaSSELine(line: string): string | null {
  if (!line.startsWith("data: ")) return null;
  const raw = line.slice(6).trim();
  if (raw === "[DONE]") return null;
  try {
    const j = JSON.parse(raw) as { message?: string };
    return j.message ?? null;
  } catch {
    return null;
  }
}

function parseAriaSSEBody(raw: string): { content: string; inputTokens: number; outputTokens: number } {
  let content = "";
  let inputTokens = 0;
  let outputTokens = 0;
  for (const line of raw.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const chunk = line.slice(6).trim();
    if (chunk === "[DONE]") break;
    try {
      const j = JSON.parse(chunk) as { message?: string; usage?: { prompt_tokens?: number; completion_tokens?: number } };
      if (j.message) content += j.message;
      if (j.usage) {
        inputTokens = j.usage.prompt_tokens ?? 0;
        outputTokens = j.usage.completion_tokens ?? 0;
      }
    } catch { /* ignore malformed lines */ }
  }
  return { content, inputTokens, outputTokens };
}

// ── Public API ────────────────────────────────────────────────────────────────

export const ARIA_MODELS = [
  { id: "aria", object: "model", created: 1700000000, owned_by: "opera" },
];

export function isAriaModel(model: string): boolean {
  return ARIA_MODELS.some(m => m.id === model);
}

/** Streaming: AsyncGenerator that yields text tokens from Aria's SSE stream. */
export async function* ariaStream(
  messages: ChatMessage[],
  _model = "aria",
): AsyncGenerator<string> {
  const query = buildQuery(messages);
  const session = await getSession();
  const encKey = randomBytes(32).toString("base64");
  const { childProcess: proc } = await curlPost(
    CHAT_EP, chatHeaders(session.accessToken), buildChatBody(query, encKey),
    { stream: true, timeoutSecs: 90 },
  );

  let buf = "";
  for await (const raw of proc!.stdout!) {
    buf += (raw as Buffer).toString("utf8");
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const text = parseAriaSSELine(line);
      if (text) yield text;
    }
  }
  // flush remaining buffer
  for (const line of buf.split("\n")) {
    const text = parseAriaSSELine(line);
    if (text) yield text;
  }
}

/** Non-streaming: collect full response with automatic 401 retry. */
export async function ariaChat(
  messages: ChatMessage[],
  _model = "aria",
): Promise<{ content: string; inputTokens: number; outputTokens: number }> {
  const query = buildQuery(messages);
  const encKey = randomBytes(32).toString("base64");

  async function attempt(retried = false): Promise<{ content: string; inputTokens: number; outputTokens: number }> {
    const session = await getSession();
    const r = await curlPost(CHAT_EP, chatHeaders(session.accessToken), buildChatBody(query, encKey));
    const raw = r.raw ?? "";

    const is401 = raw.includes('"error"') &&
      (raw.includes("401") || raw.toLowerCase().includes("unauthorized") || raw.toLowerCase().includes("invalid_token"));

    if (is401 && !retried) {
      logger.warn("Aria: 401 on non-streaming, re-authenticating");
      invalidateSession();
      return attempt(true);
    }

    return parseAriaSSEBody(raw);
  }

  return attempt();
}
