import { execSync } from "child_process";
import { logger } from "./logger";

export interface ChatMessage { role: string; content: string; }

const SESSION_COOKIE_FILE = "/tmp/algochat_session_cookies.txt";
const SESSION_META_FILE = "/tmp/algochat_session_meta.json";
const SESSION_TTL_MS = 4 * 60 * 60 * 1000; // 4 jam

interface SessionMeta { sessionId: string; userId: string; createdAt: number; }

function readSessionMeta(): SessionMeta | null {
  try {
    const raw = require("fs").readFileSync(SESSION_META_FILE, "utf8");
    const meta: SessionMeta = JSON.parse(raw);
    if (Date.now() - meta.createdAt < SESSION_TTL_MS) return meta;
  } catch { /* miss */ }
  return null;
}

function saveSessionMeta(meta: SessionMeta): void {
  try { require("fs").writeFileSync(SESSION_META_FILE, JSON.stringify(meta)); } catch { /* ignore */ }
}

async function ensureSession(): Promise<void> {
  if (readSessionMeta()) return; // still valid

  const resp = execSync(
    `curl -sc "${SESSION_COOKIE_FILE}" -sX POST "https://algochat.app/api/session" ` +
    `-H "Content-Type: application/json" ` +
    `-H "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/138.0.0.0 Safari/537.36" ` +
    `-H "Origin: https://algochat.app" ` +
    `-H "Referer: https://algochat.app/" ` +
    `--tlsv1.2 --max-time 15 ` +
    `-d '{"platform":"web","metadata":{"platform":"web"}}'`,
    { maxBuffer: 1 * 1024 * 1024 }
  ).toString().trim();

  try {
    const data = JSON.parse(resp);
    if (!data.sessionId) throw new Error("No sessionId in response");
    const cookieRaw = execSync(`grep algochat_user "${SESSION_COOKIE_FILE}" | awk '{print $7}'`).toString().trim();
    saveSessionMeta({ sessionId: data.sessionId, userId: cookieRaw, createdAt: Date.now() });
  } catch (e) {
    logger.warn({ e, resp }, "algochat: session creation failed");
    throw new Error("AlgoChat session creation failed");
  }
}

async function createChatId(): Promise<string> {
  const resp = execSync(
    `curl -sb "${SESSION_COOKIE_FILE}" -sX POST "https://algochat.app/api/create-chat" ` +
    `-H "Content-Type: application/json" ` +
    `-H "User-Agent: Mozilla/5.0 Chrome/138.0.0.0" ` +
    `-H "Origin: https://algochat.app" ` +
    `--tlsv1.2 --max-time 10 ` +
    `-d '{"model":"google/gemini-3-flash-preview"}'`,
    { maxBuffer: 1 * 1024 * 1024 }
  ).toString().trim();

  try {
    const data = JSON.parse(resp);
    if (!data.chat?.id) throw new Error("No chat id in response");
    return data.chat.id;
  } catch (e) {
    logger.warn({ e, resp }, "algochat: create-chat failed");
    throw new Error("AlgoChat create-chat failed");
  }
}

function buildPayload(messages: ChatMessage[], chatId: string): string {
  const payload = {
    messages: messages.map((m, i) => ({
      id: `msg-${i}`,
      role: m.role,
      content: m.content,
      parts: [{ type: "text", text: m.content }],
    })),
    chatId,
    model: "google/gemini-3-flash-preview",
    webSearchEnabled: false,
  };
  return JSON.stringify(payload).replace(/'/g, "'\\''");
}

function parseDataStream(raw: string): string {
  const lines = raw.split("\n");
  const parts: string[] = [];
  for (const line of lines) {
    if (!line.startsWith("data: ")) continue;
    const data = line.slice(6).trim();
    if (data === "[DONE]") break;
    try {
      const ev = JSON.parse(data);
      if (ev.type === "text-delta" && ev.delta) {
        parts.push(ev.delta);
      }
    } catch { /* skip malformed */ }
  }
  return parts.join("");
}

// ── Streaming ────────────────────────────────────────────────────────────────
export async function* algochatStream(
  messages: ChatMessage[],
  _model = "algochat",
): AsyncGenerator<string> {
  await ensureSession();
  const chatId = await createChatId();
  const payload = buildPayload(messages, chatId);

  let raw = "";
  try {
    raw = execSync(
      `curl -sb "${SESSION_COOKIE_FILE}" -sNX POST "https://algochat.app/api/chat" ` +
      `-H "Content-Type: application/json" ` +
      `-H "Accept: text/event-stream" ` +
      `-H "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/138.0.0.0 Safari/537.36" ` +
      `-H "Origin: https://algochat.app" ` +
      `-H "Referer: https://algochat.app/chat/${chatId}" ` +
      `--tlsv1.2 --max-time 120 ` +
      `-d '${payload}'`,
      { maxBuffer: 20 * 1024 * 1024 }
    ).toString();
  } catch (err: unknown) {
    logger.warn({ err }, "algochat: stream curl error");
    return;
  }

  const content = parseDataStream(raw);
  if (content) yield content;
}

// ── Non-streaming ────────────────────────────────────────────────────────────
export async function algochatChat(
  messages: ChatMessage[],
  model = "algochat",
): Promise<{ content: string; inputTokens: number; outputTokens: number }> {
  let content = "";
  for await (const chunk of algochatStream(messages, model)) {
    content += chunk;
  }
  const inputEst = Math.round(messages.map(m => m.content).join("").length / 4);
  const outputEst = Math.round(content.length / 4);
  return { content: content.trim(), inputTokens: inputEst, outputTokens: outputEst };
}

// ── Models ───────────────────────────────────────────────────────────────────
export const ALGOCHAT_MODELS = [
  { id: "algochat", object: "model", created: 1748476800, owned_by: "google" },
  { id: "gemini-3-flash-preview", object: "model", created: 1748476800, owned_by: "google" },
];

export function isAlgochatModel(model: string): boolean {
  return ALGOCHAT_MODELS.some(m => m.id === model);
}
