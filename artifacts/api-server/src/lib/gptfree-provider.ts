/**
 * GPTFree Provider (gptfree.com)
 *
 * Endpoint : POST https://us-central1-gptfree-2.cloudfunctions.net/agent_stream
 * Auth     : Firebase anonymous auth — no account required
 *            Token obtained via: POST https://identitytoolkit.googleapis.com/v1/accounts:signUp
 *            Tokens expire after 3600 s; auto-refreshed on expiry.
 * Models   : gptfree (default), gptfree-pro
 *
 * Request  : { message: string, images: [], history: [{type, content}] }
 * Response : SSE stream — event:keepalive (heartbeat) + event:result (final)
 *            Final payload: { response: string, timestamp: number }
 *
 * Rate limit: Unknown; Firebase enforces per-UID limits.
 *             We rotate tokens by creating a new anonymous user when a token expires.
 */

import { execSync } from "child_process";
import { logger } from "./logger";

const FIREBASE_API_KEY  = "AIzaSyBdU-Np8RSh1tPSsPOWg3qIm6PnVK5PQb4";
const FIREBASE_SIGNUP   = `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_API_KEY}`;
const AGENT_STREAM      = "https://us-central1-gptfree-2.cloudfunctions.net/agent_stream";
const TOKEN_TTL_MS      = 55 * 60 * 1000; // refresh 5 min before actual 60-min expiry

// ── Model definitions ─────────────────────────────────────────────────────────

export const GPTFREE_MODELS = [
  { id: "gptfree",     object: "model", created: 1748736000, owned_by: "gptfree" },
  { id: "gptfree-pro", object: "model", created: 1748736000, owned_by: "gptfree" },
];

const GPTFREE_MODEL_IDS = new Set(GPTFREE_MODELS.map(m => m.id));

export function isGptfreeModel(model: string): boolean {
  return GPTFREE_MODEL_IDS.has(model);
}

// ── Firebase anonymous token management ───────────────────────────────────────

interface FirebaseToken {
  idToken: string;
  expiresAt: number;
}

let _token: FirebaseToken | null = null;
let _tokenLock: Promise<FirebaseToken> | null = null;

async function fetchFirebaseToken(): Promise<FirebaseToken> {
  logger.debug("gptfree: fetching new Firebase anonymous token");

  const escapedUrl = FIREBASE_SIGNUP.replace(/'/g, "'\\''");
  const raw = execSync(
    `curl -s -X POST '${escapedUrl}' \
      -H 'Content-Type: application/json' \
      -d '{"returnSecureToken":true}' \
      --max-time 15`,
    { maxBuffer: 1024 * 1024 },
  ).toString();

  let parsed: { idToken?: string; error?: { message?: string } };
  try { parsed = JSON.parse(raw); }
  catch { throw new Error(`gptfree: Firebase signup parse failed: ${raw.slice(0, 200)}`); }

  if (parsed.error) {
    throw new Error(`gptfree: Firebase signup error: ${parsed.error.message ?? JSON.stringify(parsed.error)}`);
  }
  if (!parsed.idToken) {
    throw new Error(`gptfree: Firebase signup returned no idToken: ${raw.slice(0, 200)}`);
  }

  return { idToken: parsed.idToken, expiresAt: Date.now() + TOKEN_TTL_MS };
}

async function getToken(): Promise<string> {
  if (_token && Date.now() < _token.expiresAt) return _token.idToken;

  if (!_tokenLock) {
    _tokenLock = fetchFirebaseToken().then(t => {
      _token = t;
      _tokenLock = null;
      return t;
    }).catch(err => {
      _tokenLock = null;
      throw err;
    });
  }
  const tok = await _tokenLock;
  return tok.idToken;
}

// ── Message helpers ───────────────────────────────────────────────────────────

export interface ChatMessage {
  role: string;
  content: string;
}

interface GptfreeHistoryItem {
  type: "user" | "assistant" | "tool_execution" | "tool_result";
  content: string;
  tool_name?: string;
}

/**
 * Convert OpenAI-format messages to gptfree history format.
 * The last user message is sent as `message`, the rest as `history`.
 */
function buildPayload(messages: ChatMessage[]): {
  message: string;
  history: GptfreeHistoryItem[];
} {
  if (messages.length === 0) return { message: "", history: [] };

  const history: GptfreeHistoryItem[] = [];

  // Collapse system prompt into the first user message
  let systemPrompt = "";
  const filtered: ChatMessage[] = [];
  for (const m of messages) {
    if (m.role === "system") { systemPrompt += (systemPrompt ? "\n\n" : "") + m.content; }
    else filtered.push(m);
  }

  // Pop the last user message to use as `message`
  const lastUser = filtered.length > 0 ? filtered[filtered.length - 1] : null;
  const prior = lastUser ? filtered.slice(0, -1) : filtered;

  // Build history from prior messages
  for (const m of prior) {
    const type = m.role === "assistant" ? "assistant" : "user";
    history.push({ type, content: m.content });
  }

  let message = lastUser?.content ?? "";
  if (systemPrompt) {
    message = `${systemPrompt}\n\n${message}`;
  }

  return { message, history };
}

// ── SSE parser ────────────────────────────────────────────────────────────────

interface GptfreeResultData {
  response?: string;
  error?: string;
  timestamp?: number;
}

/**
 * Parse gptfree SSE response.
 * Events: "keepalive" (heartbeat) + "result" (final answer).
 * We only care about the "result" event.
 */
function parseGptfreeSSE(raw: string): string {
  const lines = raw.split("\n");
  let currentEvent = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith("event:")) {
      currentEvent = line.slice(6).trim();
    } else if (line.startsWith("data:") && currentEvent === "result") {
      const jsonStr = line.slice(5).trim();
      if (!jsonStr || jsonStr === "{}") continue;
      try {
        const d = JSON.parse(jsonStr) as GptfreeResultData;
        if (d.error) throw new Error(`gptfree upstream error: ${d.error}`);
        if (d.response) return d.response;
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("gptfree")) throw err;
      }
    } else if (line === "") {
      currentEvent = "";
    }
  }

  return "";
}

// ── Core request ──────────────────────────────────────────────────────────────

function callGptfree(messages: ChatMessage[]): string {
  const { message, history } = buildPayload(messages);
  const body = JSON.stringify({ message, images: [], history });
  const escapedBody = body.replace(/'/g, "'\\''");

  // Token obtained synchronously via a pre-fetched value
  // (we use a cached token; callers must ensure token is fresh via getToken())
  const idToken = _token?.idToken ?? "";

  const raw = execSync(
    `curl -sN -X POST '${AGENT_STREAM}' \
      -H 'Content-Type: application/json' \
      -H 'Authorization: Bearer ${idToken}' \
      -H 'Origin: https://gptfree.com' \
      -H 'Referer: https://gptfree.com/en/' \
      --max-time 60 \
      -d '${escapedBody}'`,
    { maxBuffer: 20 * 1024 * 1024 },
  ).toString();

  return raw;
}

// ── Public streaming API ──────────────────────────────────────────────────────

export async function* gptfreeStream(
  messages: ChatMessage[],
  _model = "gptfree",
): AsyncGenerator<string> {
  await getToken();

  logger.debug({ msgCount: messages.length }, "gptfree: sending request");

  let raw: string;
  try {
    raw = callGptfree(messages);
  } catch (err) {
    logger.error({ err: String(err) }, "gptfree: curl failed");
    throw new Error("GPTFree request failed");
  }

  const content = parseGptfreeSSE(raw);
  if (!content) {
    const snippet = raw.slice(0, 300);
    logger.warn({ snippet }, "gptfree: empty response");
    throw new Error("GPTFree returned empty response");
  }

  // Yield in word-sized chunks to simulate streaming
  const words = content.match(/\S+\s*/g) ?? [content];
  for (const word of words) {
    yield word;
  }
}

// ── Non-streaming ─────────────────────────────────────────────────────────────

export async function gptfreeChat(
  messages: ChatMessage[],
  model = "gptfree",
): Promise<{ content: string; inputTokens: number; outputTokens: number }> {
  let content = "";
  for await (const token of gptfreeStream(messages, model)) {
    content += token;
  }
  const inputEst  = Math.round(messages.map(m => m.content).join(" ").length / 4);
  const outputEst = Math.round(content.length / 4);
  return { content: content.trim(), inputTokens: inputEst, outputTokens: outputEst };
}
