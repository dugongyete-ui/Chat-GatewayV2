/**
 * Yqcloud Provider
 *
 * Endpoint : POST https://api.binjie.fun/api/generateStream
 * Model    : GPT-4 (proxied, no auth required)
 * Pool     : 200 pre-generated userIds, rotated round-robin to spread
 *            per-session rate-limit pressure — same pattern as Qwen umid-pool.
 */

import { randomUUID } from "crypto";
import { logger } from "./logger";

const API_URL = "https://api.binjie.fun/api/generateStream";
const ORIGIN  = "https://chat9.yqcloud.top";
const POOL_SIZE = 200;

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";

// ── userId pool ───────────────────────────────────────────────────────────────

const userIdPool: string[] = Array.from({ length: POOL_SIZE }, () =>
  randomUUID().replace(/-/g, "").slice(0, 20),
);
let poolCursor = 0;

function nextUserId(): string {
  const id = userIdPool[poolCursor % POOL_SIZE];
  poolCursor = (poolCursor + 1) % POOL_SIZE;
  return id;
}

// ── Message helpers ───────────────────────────────────────────────────────────

export interface ChatMessage {
  role: string;
  content: string;
}

function buildPrompt(messages: ChatMessage[]): string {
  return messages
    .filter(m => m.role !== "system")
    .map(m => (m.role === "assistant" ? `Assistant: ${m.content}` : `User: ${m.content}`))
    .join("\n") + "\nAssistant:";
}

function extractSystem(messages: ChatMessage[]): string {
  return messages
    .filter(m => m.role === "system")
    .map(m => m.content)
    .join("\n");
}

// ── Models ────────────────────────────────────────────────────────────────────

export const YQCLOUD_MODELS = [
  { id: "yqcloud",      object: "model", created: 1700000000, owned_by: "yqcloud" },
  { id: "yqcloud-gpt4", object: "model", created: 1700000000, owned_by: "yqcloud" },
];

export function isYqcloudModel(model: string): boolean {
  return model === "yqcloud" || model === "yqcloud-gpt4";
}

// ── Streaming (AsyncGenerator) ────────────────────────────────────────────────

export async function* yqcloudStream(
  messages: ChatMessage[],
  _model = "yqcloud",
): AsyncGenerator<string> {
  const userId = nextUserId();
  const prompt = buildPrompt(messages);
  const system = extractSystem(messages);

  const body = JSON.stringify({
    prompt,
    userId,
    network: true,
    system,
    withoutContext: false,
    stream: true,
  });

  logger.debug({ userId }, "yqcloud: sending request");

  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "accept": "application/json, text/plain, */*",
      "accept-language": "en-US,en;q=0.9",
      "content-type": "application/json",
      "origin": ORIGIN,
      "referer": `${ORIGIN}/`,
      "user-agent": UA,
    },
    body,
  });

  if (!res.ok) {
    throw new Error(`Yqcloud HTTP ${res.status}: ${await res.text().catch(() => "")}`);
  }

  if (!res.body) throw new Error("Yqcloud: no response body");

  const reader = (res.body as unknown as { getReader(): ReadableStreamDefaultReader<Uint8Array> }).getReader();
  const dec = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      const chunk = dec.decode(value, { stream: true });
      if (chunk) yield chunk;
    }
  }
}

// ── Non-streaming ─────────────────────────────────────────────────────────────

export async function yqcloudChat(
  messages: ChatMessage[],
  model = "yqcloud",
): Promise<{ content: string; inputTokens: number; outputTokens: number }> {
  let content = "";
  for await (const token of yqcloudStream(messages, model)) {
    content += token;
  }
  const trimmed = content.trim();
  const inputEst = Math.round(messages.map(m => m.content).join("").length / 4);
  const outputEst = Math.round(trimmed.length / 4);
  return { content: trimmed, inputTokens: inputEst, outputTokens: outputEst };
}
