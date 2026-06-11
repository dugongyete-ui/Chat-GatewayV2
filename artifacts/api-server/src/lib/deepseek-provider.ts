/**
 * DeepSeek Provider — web scraping via chat.deepseek.com
 *
 * Auth    : Bearer token dari session chat.deepseek.com → env DEEPSEEK_TOKEN
 * PoW     : SHA3 WASM solver (sha3_wasm.wasm, bundled di dist/)
 * Flow    : createSession → getPowResponse → POST /api/v0/chat/completion
 * Format  : JSON Patch SSE — parse p/o/v fields, yield hanya content chunks
 *
 * Models:
 *   deepseek-chat     → thinking_enabled:false, search_enabled:false  (V3)
 *   deepseek-reasoner → thinking_enabled:true,  search_enabled:false  (R1)
 *   deepseek-search   → thinking_enabled:false, search_enabled:true   (V3 + Search)
 */

import { readFileSync } from "fs";
import { join } from "path";
import { logger } from "./logger";

// ── Constants ──────────────────────────────────────────────────────────────────

const DEEPSEEK_ORIGIN = "https://chat.deepseek.com";
const DEEPSEEK_BASE   = `${DEEPSEEK_ORIGIN}/api/v0`;

const BASE_HEADERS: Record<string, string> = {
  "User-Agent":              "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36",
  "x-app-version":           "2.0.0",
  "x-client-version":        "2.0.0",
  "x-client-platform":       "web",
  "x-client-locale":         "id",
  "x-client-timezone-offset":"25200",
  "sec-ch-ua-platform":      '"Android"',
  "Origin":                  DEEPSEEK_ORIGIN,
  "Referer":                 `${DEEPSEEK_ORIGIN}/`,
  "Accept":                  "*/*",
};

function getToken(): string {
  const t = process.env.DEEPSEEK_TOKEN ?? "";
  if (!t) throw new Error("DEEPSEEK_TOKEN env var is not set");
  return t;
}

function authHeaders(): Record<string, string> {
  return { ...BASE_HEADERS, Authorization: `Bearer ${getToken()}` };
}

// ── WASM PoW Solver ───────────────────────────────────────────────────────────

let wasmInst: WebAssembly.Instance | null = null;
const enc = new TextEncoder();

async function getWasm(): Promise<WebAssembly.Instance> {
  if (wasmInst) return wasmInst;
  const wasmPath = join(__dirname, "sha3_wasm.wasm");
  const buf = readFileSync(wasmPath);
  const { instance } = await WebAssembly.instantiate(buf, { wbg: {} });
  wasmInst = instance;
  logger.info("deepseek: WASM PoW solver loaded");
  return instance;
}

let cachedMem: Uint8Array | null = null;
let cachedDV: DataView | null = null;

function getMem(ex: WebAssembly.Exports): Uint8Array {
  const buf = (ex.memory as WebAssembly.Memory).buffer;
  if (!cachedMem || cachedMem.buffer !== buf) cachedMem = new Uint8Array(buf);
  return cachedMem;
}
function getDV(ex: WebAssembly.Exports): DataView {
  const buf = (ex.memory as WebAssembly.Memory).buffer;
  if (!cachedDV || cachedDV.buffer !== buf) cachedDV = new DataView(buf);
  return cachedDV;
}

let lastLen = 0;
function writeStr(ex: WebAssembly.Exports, str: string): number {
  const bytes = enc.encode(str);
  const alloc = ex.__wbindgen_export_0 as CallableFunction;
  const ptr   = (alloc(bytes.length, 1) as number) >>> 0;
  getMem(ex).subarray(ptr, ptr + bytes.length).set(bytes);
  lastLen = bytes.length;
  return ptr;
}

async function solvePow(
  challenge: string,
  salt: string,
  difficulty: number,
  expireAt: number,
): Promise<number> {
  const inst = await getWasm();
  const ex   = inst.exports;
  const stackFn = ex.__wbindgen_add_to_stack_pointer as CallableFunction;
  const solveFn = ex.wasm_solve as CallableFunction;
  const prefix  = `${salt}_${expireAt}_`;

  const retPtr = (stackFn(-16) as number) >>> 0;
  const chPtr  = writeStr(ex, challenge); const chLen = lastLen;
  const pfPtr  = writeStr(ex, prefix);    const pfLen = lastLen;

  solveFn(retPtr, chPtr, chLen, pfPtr, pfLen, difficulty);

  const found  = getDV(ex).getInt32(retPtr, true);
  const answer = getDV(ex).getFloat64(retPtr + 8, true);
  stackFn(16);

  if (!found) throw new Error("deepseek: PoW solver found no answer");
  return answer;
}

// ── Session & PoW ─────────────────────────────────────────────────────────────

async function createSession(): Promise<string> {
  const res = await fetch(`${DEEPSEEK_BASE}/chat_session/create`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ character_id: null }),
  });
  const data = await res.json() as {
    data?: { biz_data?: { id?: string; chat_session?: { id?: string } } };
  };
  const bd = data?.data?.biz_data;
  // DeepSeek returns either biz_data.id or biz_data.chat_session.id
  const id = bd?.id ?? bd?.chat_session?.id;
  if (!id) throw new Error(`deepseek: createSession failed: ${JSON.stringify(data).slice(0, 200)}`);
  return id;
}

interface PowChallenge {
  algorithm: string; challenge: string; salt: string;
  difficulty: number; expire_at: number; signature: string; target_path: string;
}

async function getPowResponse(): Promise<string> {
  const res = await fetch(`${DEEPSEEK_BASE}/chat/create_pow_challenge`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ target_path: "/api/v0/chat/completion" }),
  });
  const data = await res.json() as { data?: { biz_data?: { challenge?: PowChallenge } } };
  const ch = data?.data?.biz_data?.challenge;
  if (!ch) throw new Error(`deepseek: getPowChallenge failed: ${JSON.stringify(data).slice(0, 200)}`);

  const t0 = Date.now();
  const answer = await solvePow(ch.challenge, ch.salt, ch.difficulty, ch.expire_at);
  logger.debug({ difficulty: ch.difficulty, answer, ms: Date.now() - t0 }, "deepseek: PoW solved");

  return Buffer.from(JSON.stringify({
    algorithm:   ch.algorithm,
    challenge:   ch.challenge,
    salt:        ch.salt,
    answer,
    signature:   ch.signature,
    target_path: ch.target_path,
  })).toString("base64");
}

// ── Messages → DeepSeek prompt ────────────────────────────────────────────────

export interface DeepseekMessage { role: string; content: string; }

function buildPrompt(messages: DeepseekMessage[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      parts.push(`System: ${m.content}`);
    } else if (m.role === "assistant") {
      parts.push(`Assistant: ${m.content}`);
    } else if (m.role === "tool") {
      parts.push(`Tool result: ${m.content}`);
    } else {
      parts.push(`User: ${m.content}`);
    }
  }
  parts.push("Assistant:");
  return parts.join("\n\n");
}

// ── Model definitions ─────────────────────────────────────────────────────────

interface ModelCfg { thinking_enabled: boolean; search_enabled: boolean; }

const MODEL_CFG: Record<string, ModelCfg> = {
  "deepseek-chat":     { thinking_enabled: false, search_enabled: false },
  "deepseek-reasoner": { thinking_enabled: true,  search_enabled: false },
  "deepseek-search":   { thinking_enabled: false, search_enabled: true  },
};

export const DEEPSEEK_MODELS = Object.keys(MODEL_CFG).map(id => ({
  id, object: "model", created: 1748736000, owned_by: "deepseek",
}));

export function isDeepseekModel(model: string): boolean {
  return model in MODEL_CFG;
}

// ── Streaming generator ───────────────────────────────────────────────────────

export async function* deepseekStream(
  messages: DeepseekMessage[],
  model = "deepseek-chat",
): AsyncGenerator<string> {
  const cfg = MODEL_CFG[model] ?? MODEL_CFG["deepseek-chat"];

  const [sessionId, powResponse] = await Promise.all([
    createSession(),
    getPowResponse(),
  ]);

  const prompt = buildPrompt(messages);
  logger.debug({ sessionId, model, promptLen: prompt.length }, "deepseek: sending chat request");

  const resp = await fetch(`${DEEPSEEK_BASE}/chat/completion`, {
    method: "POST",
    headers: {
      ...authHeaders(),
      "Content-Type":      "application/json",
      "x-ds-pow-response": powResponse,
    },
    body: JSON.stringify({
      chat_session_id:    sessionId,
      parent_message_id:  null,
      model_type:         "default",
      prompt,
      ref_file_ids:       [],
      thinking_enabled:   cfg.thinking_enabled,
      search_enabled:     cfg.search_enabled,
      action:             null,
      preempt:            false,
    }),
  });

  logger.debug({ status: resp.status, sessionId }, "deepseek: chat response");
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`deepseek: chat ${resp.status}: ${err.slice(0, 300)}`);
  }
  if (!resp.body) throw new Error("deepseek: no response body");

  // DeepSeek SSE uses JSON-Patch style. Multiple formats observed:
  //
  // FORMAT A — full content in initial state blob (fast/cached responses):
  //   data: {"v":{"response":{"fragments":[{"content":"answer..."},...]},...}}}
  //   data: {"p":"response","o":"BATCH","v":[{"p":"accumulated_token_usage","v":N},...]}
  //
  // FORMAT B — streaming individual patches:
  //   data: {"v":{"response":{...empty fragments...}}}   ← initial state
  //   data: {"p":"response/content","o":"APPEND","v":"tok"}
  //   data: {"v":" next"}                               ← subsequent (no p field)
  //
  // FORMAT C — streaming with fragments path:
  //   data: {"v":{"response":{...}}}
  //   data: {"p":"response/fragments/-1/content","o":"APPEND","v":"tok"}
  //   data: {"p":"response/fragments/-1/content","o":"APPEND","v":" next"}
  //
  // FORMAT D — BATCH with nested content patches:
  //   data: {"p":"response","o":"BATCH","v":[{"p":"fragments/-1/content","o":"APPEND","v":"tok"},...]}

  interface RawPatch { p?: string; o?: string; v?: unknown; }
  interface Fragment { id?: string; content?: string; thinking_content?: string; }
  interface InitialResponse { fragments?: Fragment[]; content?: string; }

  function isContentPath(p: string): boolean {
    return p === "response/content" || /^response\/fragments\/[-\d]+\/content$/.test(p);
  }

  function* extractFromBatch(base: string, patches: RawPatch[]): Generator<string> {
    for (const sub of patches) {
      if (!sub.p) continue;
      const fullPath = `${base}/${sub.p}`;
      if (sub.o === "APPEND" && typeof sub.v === "string" && isContentPath(fullPath)) {
        if (sub.v) yield sub.v;
      }
    }
  }

  const reader = (resp.body as unknown as { getReader(): ReadableStreamDefaultReader<Uint8Array> }).getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let inContent = false;
  let totalChunks = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data) continue;
        totalChunks++;

        try {
          const chunk = JSON.parse(data) as RawPatch;

          // ── FORMAT A: initial state blob with pre-populated fragments ──────
          if (!chunk.p && chunk.v && typeof chunk.v === "object") {
            const v = chunk.v as { response?: InitialResponse };
            if (v.response) {
              const r = v.response;
              // Fragments array (new format)
              if (Array.isArray(r.fragments)) {
                for (const frag of r.fragments) {
                  if (typeof frag?.content === "string" && frag.content) {
                    inContent = true;
                    yield frag.content;
                  }
                }
              }
              // Plain content field (old format initial state)
              if (typeof r.content === "string" && r.content) {
                inContent = true;
                yield r.content;
              }
            }
            continue;
          }

          if (!chunk.p) {
            // Subsequent streaming tokens (FORMAT B — no p field)
            if (typeof chunk.v === "string" && chunk.v) yield chunk.v;
            continue;
          }

          const p = chunk.p;

          // ── FORMAT D: BATCH with nested patches ───────────────────────────
          if (chunk.o === "BATCH" && Array.isArray(chunk.v)) {
            for (const tok of extractFromBatch(p, chunk.v as RawPatch[])) {
              inContent = true;
              yield tok;
            }
            continue;
          }

          // ── FORMAT B/C: individual APPEND patches ─────────────────────────
          if (chunk.o === "APPEND" && typeof chunk.v === "string") {
            if (isContentPath(p)) {
              inContent = true;
              if (chunk.v) yield chunk.v;
            }
            // thinking_content, search_results etc → skip
            continue;
          }

          // All other patches (SET, status, usage) → skip
        } catch { /* skip malformed */ }
      }
    }
  } finally {
    reader.releaseLock();
  }

  logger.debug({ model, sessionId, totalChunks, inContent }, "deepseek: stream complete");
}

// ── Non-streaming ─────────────────────────────────────────────────────────────

export async function deepseekChat(
  messages: DeepseekMessage[],
  model = "deepseek-chat",
): Promise<{ content: string; inputTokens: number; outputTokens: number }> {
  let content = "";
  for await (const tok of deepseekStream(messages, model)) content += tok;
  const trimmed = content.trim();
  return {
    content:      trimmed,
    inputTokens:  Math.round(messages.map(m => m.content).join("").length / 4),
    outputTokens: Math.round(trimmed.length / 4),
  };
}
