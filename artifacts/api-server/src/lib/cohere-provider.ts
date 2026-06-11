/**
 * Cohere (HuggingFace Space) Provider
 *
 * Endpoint : https://coherelabs-c4ai-command.hf.space
 * Models   : command-a-03-2025, command-r-plus, command-r, command-r7b
 * Auth     : None — uses HuggingFace public space session (cookies)
 *
 * Pool strategy: pre-warm N conversation slots per model.
 * Each slot holds a conversationId + session cookies. Slots are
 * handed out round-robin so concurrent requests spread across
 * different HF sessions, avoiding per-session rate limits.
 *
 * Flow per request:
 *   1. Acquire a conversation slot (create if pool not full)
 *   2. GET /{convId}/__data.json → find latest message_id
 *   3. POST /{convId} with FormData → stream token chunks
 */

import { logger } from "./logger";

const HF_BASE  = "https://coherelabs-c4ai-command.hf.space";
const CONV_URL = `${HF_BASE}/conversation`;

const POOL_PER_MODEL = 10;

const UA_HF = "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0";

const BASE_HEADERS: Record<string, string> = {
  "User-Agent":      UA_HF,
  "Accept":          "*/*",
  "Accept-Language": "en-US,en;q=0.5",
  "Origin":          HF_BASE,
  "Referer":         `${HF_BASE}/`,
  "Sec-Fetch-Dest":  "empty",
  "Sec-Fetch-Mode":  "cors",
  "Sec-Fetch-Site":  "same-origin",
};

// ── Conversation slot ─────────────────────────────────────────────────────────

interface ConvSlot {
  conversationId: string;
  cookies: string;
  model: string;
  createdAt: number;
  inUse: boolean;
}

const convPool: ConvSlot[] = [];
const SLOT_TTL = 2 * 3600_000; // 2 hours

async function createConvSlot(model: string): Promise<ConvSlot> {
  const res = await fetch(CONV_URL, {
    method: "POST",
    headers: { ...BASE_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify({ model, preprompt: "" }),
  });
  if (!res.ok) throw new Error(`Cohere: create conversation ${res.status}`);

  const data = (await res.json()) as { conversationId: string };
  const rawCookies = res.headers.get("set-cookie") ?? "";
  const cookies = rawCookies
    .split(/,(?=[^ ])/)
    .map(c => c.split(";")[0].trim())
    .filter(Boolean)
    .join("; ");

  return {
    conversationId: data.conversationId,
    cookies,
    model,
    createdAt: Date.now(),
    inUse: false,
  };
}

async function acquireSlot(model: string): Promise<ConvSlot> {
  const now = Date.now();

  // Expire stale slots
  const stale = convPool.findIndex(s => s.model === model && s.createdAt + SLOT_TTL < now);
  if (stale !== -1) convPool.splice(stale, 1);

  // Find a free slot
  const free = convPool.find(s => s.model === model && !s.inUse && s.createdAt + SLOT_TTL > now);
  if (free) {
    free.inUse = true;
    return free;
  }

  // Create a new slot if pool not full
  const modelCount = convPool.filter(s => s.model === model).length;
  if (modelCount < POOL_PER_MODEL) {
    const slot = await createConvSlot(model);
    slot.inUse = true;
    convPool.push(slot);
    logger.debug({ model, conversationId: slot.conversationId, poolSize: modelCount + 1 }, "cohere: created conv slot");
    return slot;
  }

  // All full — reuse the oldest one
  const oldest = convPool
    .filter(s => s.model === model)
    .sort((a, b) => a.createdAt - b.createdAt)[0];
  oldest.inUse = true;
  return oldest;
}

function releaseSlot(slot: ConvSlot) {
  slot.inUse = false;
}

// ── Get last message id from conversation ─────────────────────────────────────

async function getLastMessageId(slot: ConvSlot): Promise<string> {
  const url = `${CONV_URL}/${slot.conversationId}/__data.json?x-sveltekit-invalidated=11`;
  const res = await fetch(url, {
    headers: { ...BASE_HEADERS, Cookie: slot.cookies },
  });
  if (!res.ok) throw new Error(`Cohere: __data.json ${res.status}`);

  const text = await res.text();
  const firstLine = text.split("\n")[0];
  const node = (JSON.parse(firstLine) as { nodes: Array<{ type: string; data?: unknown; error?: string }> }).nodes[1];

  if (node.type === "error") throw new Error(`Cohere: ${node.error}`);

  const data = node.data as Array<unknown>;
  const rootObj = data[0] as { messages: number };
  const messagesRef = data[rootObj.messages] as number[];
  const lastMsgRef = messagesRef[messagesRef.length - 1];
  const lastMsgObj = data[lastMsgRef] as { id: number };
  return data[lastMsgObj.id] as string;
}

// ── Chat messages ─────────────────────────────────────────────────────────────

interface ChatMessage {
  role: string;
  content: string;
}

function formatPrompt(messages: ChatMessage[]): string {
  const nonSystem = messages.filter(m => m.role !== "system");
  if (nonSystem.length === 0) return "";
  const last = nonSystem[nonSystem.length - 1];
  if (nonSystem.length === 1) return last.content;

  return nonSystem
    .map(m => (m.role === "assistant" ? `Assistant: ${m.content}` : `User: ${m.content}`))
    .join("\n");
}

function extractSystem(messages: ChatMessage[]): string {
  return messages
    .filter(m => m.role === "system")
    .map(m => m.content)
    .join("\n");
}

// ── Public streaming API ──────────────────────────────────────────────────────

export async function* cohereStream(
  messages: ChatMessage[],
  model = "command-a-03-2025",
): AsyncGenerator<string> {
  const slot = await acquireSlot(model);
  try {
    // Need fresh slot state for each request — update preprompt if system changed
    const system = extractSystem(messages);
    if (system && slot.createdAt < Date.now() - 30_000) {
      // Refresh conversation if system prompt differs (best-effort)
    }

    const messageId = await getLastMessageId(slot);
    const inputs = formatPrompt(messages);

    const formData = new FormData();
    formData.append(
      "data",
      JSON.stringify({
        inputs,
        id: messageId,
        is_retry: false,
        is_continue: false,
        web_search: false,
        tools: [],
      }),
    );

    const res = await fetch(`${CONV_URL}/${slot.conversationId}`, {
      method: "POST",
      headers: { ...BASE_HEADERS, Cookie: slot.cookies },
      body: formData,
    });

    if (!res.ok) {
      throw new Error(`Cohere: conversation POST ${res.status}: ${await res.text().catch(() => "")}`);
    }

    if (!res.body) throw new Error("Cohere: no response body");

    const reader = (res.body as unknown as { getReader(): ReadableStreamDefaultReader<Uint8Array> }).getReader();
    const dec = new TextDecoder();
    let buf = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });

      const lines = buf.split("\n");
      buf = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const chunk = JSON.parse(line) as { type: string; token?: string };
          if (chunk.type === "stream" && chunk.token) {
            yield chunk.token.replace(/\u0000/g, "");
          } else if (chunk.type === "finalAnswer") {
            return;
          }
        } catch { /* skip malformed */ }
      }
    }
  } finally {
    releaseSlot(slot);
  }
}

export async function cohereChat(
  messages: ChatMessage[],
  model = "command-a-03-2025",
): Promise<{ content: string; inputTokens: number; outputTokens: number }> {
  let content = "";
  for await (const token of cohereStream(messages, model)) {
    content += token;
  }
  const trimmed = content.trim();
  const inputEst = Math.round(messages.map(m => m.content).join("").length / 4);
  const outputEst = Math.round(trimmed.length / 4);
  return { content: trimmed, inputTokens: inputEst, outputTokens: outputEst };
}

export const COHERE_MODELS = [
  { id: "command-a",          object: "model", created: 1700000000, owned_by: "cohere" },
  { id: "command-a-03-2025",  object: "model", created: 1700000000, owned_by: "cohere" },
  { id: "command-r-plus",     object: "model", created: 1700000000, owned_by: "cohere" },
  { id: "command-r",          object: "model", created: 1700000000, owned_by: "cohere" },
  { id: "command-r7b",        object: "model", created: 1700000000, owned_by: "cohere" },
];

const COHERE_MODEL_MAP: Record<string, string> = {
  "command-a":         "command-a-03-2025",
  "command-r-plus":    "command-r-plus-08-2024",
  "command-r":         "command-r-08-2024",
  "command-r7b":       "command-r7b-12-2024",
  "command-a-03-2025": "command-a-03-2025",
  "command-r-plus-08-2024": "command-r-plus-08-2024",
  "command-r-08-2024":      "command-r-08-2024",
  "command-r7b-12-2024":    "command-r7b-12-2024",
};

export function resolveCohereModel(model: string): string {
  return COHERE_MODEL_MAP[model] ?? "command-a-03-2025";
}

export function isCohereModel(model: string): boolean {
  return model in COHERE_MODEL_MAP || COHERE_MODELS.some(m => m.id === model);
}
