import { Router } from "express";
import { randomUUID } from "crypto";
import { logger } from "../lib/logger";
import { recordRequest, getHistory, clearHistory, getStats } from "../lib/stats";
import { getPooledMidtoken, getPoolStatus } from "../lib/umid-pool";

const router = Router();

// ── Keyless Qwen config ──────────────────────────────────────────────────────
const QWEN_ORIGIN = "https://chat.qwen.ai";
const QWEN_BASE = `${QWEN_ORIGIN}/api/v2`;

// Delegates to shared rotating pool — 8 tokens, round-robin per request
async function getMidtoken(): Promise<string> {
  return getPooledMidtoken();
}

function qwenHeaders(midtoken: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/138.0.0.0 Safari/537.36",
    Accept: "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    Origin: QWEN_ORIGIN,
    Referer: `${QWEN_ORIGIN}/`,
    "X-Requested-With": "XMLHttpRequest",
    "X-Source": "web",
    "bx-v": "2.5.31",
    ...(midtoken ? { "bx-umidtoken": midtoken } : {}),
  };
}

async function createQwenChat(headers: Record<string, string>, model: string): Promise<string> {
  const res = await fetch(`${QWEN_BASE}/chats/new`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      title: "New Chat",
      models: [model],
      chat_mode: "normal",
      chat_type: "t2t",
      timestamp: Date.now(),
    }),
  });
  const data = await res.json() as { success: boolean; data?: { id: string } };
  if (!data.success || !data.data?.id) throw new Error(`Failed to create Qwen chat: ${JSON.stringify(data)}`);
  return data.data.id;
}

function parseQwenSSE(body: string): string {
  let answer = "";
  let fallback = "";
  for (const line of body.split("\n")) {
    if (!line.startsWith("data:")) continue;
    try {
      const chunk = JSON.parse(line.slice(5).trim()) as {
        choices?: Array<{ delta?: { content?: string; extra?: { output_schema?: string } } }>;
      };
      const delta = chunk.choices?.[0]?.delta;
      const content = delta?.content ?? "";
      if (!content) continue;
      const phase = delta?.extra?.output_schema ?? "";
      if (phase === "answer") {
        answer += content;
      } else {
        fallback += content;
      }
    } catch {
      // skip malformed chunks
    }
  }
  return answer || fallback;
}

// Build a single prompt string from OpenAI-style messages array
function messagesToPrompt(messages: Array<{ role: string; content?: string | null }>): string {
  return messages
    .map((m) => {
      const role = m.role === "assistant" ? "Assistant" : m.role === "system" ? "System" : "User";
      return `${role}: ${m.content ?? ""}`;
    })
    .join("\n");
}


// ── Routes ───────────────────────────────────────────────────────────────────

// POST /api/gateway/chat  — keyless Qwen chat (main endpoint)
router.post("/gateway/chat", async (req, res) => {
  const {
    model = "qwen3-235b-a22b",
    messages,
    prompt,
    stream: _stream = false,
  } = req.body as {
    model?: string;
    messages?: Array<{ role: string; content?: string | null }>;
    prompt?: string;
    stream?: boolean;
  };

  if (!messages && !prompt) {
    res.status(400).json({ error: "messages or prompt is required" });
    return;
  }

  const id = randomUUID();
  const requestedAt = new Date().toISOString();
  const start = Date.now();

  const userPrompt = prompt ?? messagesToPrompt(messages ?? []);

  let success = false;
  let statusCode = 0;
  let responseBody: unknown = null;
  let error: string | null = null;
  const responseHeaders: Record<string, string> = {};

  try {
    const midtoken = await getMidtoken();
    const headers = qwenHeaders(midtoken);

    // Step 1: create chat session
    const chatId = await createQwenChat(headers, model);
    req.log.info({ model, chatId }, "Qwen chat created");

    // Step 2: send message
    const msgId = randomUUID();
    const r2 = await fetch(`${QWEN_BASE}/chat/completions?chat_id=${chatId}`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        stream: true,
        incremental_output: true,
        chat_id: chatId,
        chat_mode: "normal",
        model,
        parent_id: null,
        messages: [{
          fid: msgId,
          parentId: null,
          childrenIds: [],
          role: "user",
          content: userPrompt,
          user_action: "chat",
          files: [],
          models: [model],
          chat_type: "t2t",
          feature_config: { thinking_enabled: false, output_schema: "phase", thinking_budget: 81920 },
          sub_chat_type: "t2t",
        }],
      }),
    });

    r2.headers.forEach((v, k) => { responseHeaders[k] = v; });
    const actualCode = r2.headers.get("x-actual-status-code");
    statusCode = actualCode ? parseInt(actualCode, 10) : r2.status;

    const body = await r2.text();
    const answer = parseQwenSSE(body);

    if (statusCode !== 200 && !answer) {
      // try to parse as JSON error
      try {
        const errJson = JSON.parse(body) as { data?: { details?: string; code?: string } };
        error = errJson.data?.details ?? errJson.data?.code ?? "Unknown error";
      } catch {
        error = body.slice(0, 200);
      }
      success = false;
      responseBody = { error, raw: body.slice(0, 500) };
    } else {
      success = true;
      statusCode = 200;
      // Return in OpenAI-compatible format
      responseBody = {
        id: `chatcmpl-${id}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{
          index: 0,
          message: { role: "assistant", content: answer },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    error = msg;
    statusCode = 0;
    responseBody = { error: msg };
    logger.error({ err }, "Qwen keyless request failed");
  }

  const responseTime = Date.now() - start;
  const entry: HistoryEntry = {
    id, success, statusCode, requestedAt, responseTime,
    endpoint: "chat/completions",
    method: "POST",
    model: model,
    requestPayload: { model, messages, prompt },
    responseBody,
    responseHeaders,
    error,
  };
  await recordRequest(entry);

  res.json({ id, success, statusCode, requestedAt, responseTime,
    endpoint: "chat/completions", method: "POST",
    requestPayload: { model, messages, prompt },
    responseBody, responseHeaders, error });
});

// POST /api/gateway/proxy  — raw proxy (for advanced use, still supports token)
router.post("/gateway/proxy", async (req, res) => {
  const { token, endpoint, method, payload, extraHeaders } = req.body as {
    token?: string;
    endpoint: string;
    method: string;
    payload?: unknown;
    extraHeaders?: Record<string, string>;
  };

  if (!endpoint || !method) {
    res.status(400).json({ error: "endpoint and method are required" });
    return;
  }

  const url = `https://chat.qwen.ai/api/v2/${endpoint.replace(/^\//, "")}`;
  const start = Date.now();
  const requestedAt = new Date().toISOString();
  const id = randomUUID();

  // Build headers — token optional; if missing use bx-umidtoken approach
  let statusCode = 0;
  let responseBody: unknown = null;
  let responseHeaders: Record<string, string> = {};
  let success = false;
  let error: string | null = null;

  try {
    let fetchHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0 Chrome/138.0.0.0 Safari/537.36",
      Accept: "application/json",
      ...extraHeaders,
    };

    if (token) {
      fetchHeaders["Authorization"] = `Bearer ${token}`;
    } else {
      const midtoken = await getMidtoken();
      fetchHeaders = { ...qwenHeaders(midtoken), ...fetchHeaders };
    }

    const fetchOpts: RequestInit = { method: method.toUpperCase(), headers: fetchHeaders };
    if (payload && ["POST", "PUT", "PATCH"].includes(method.toUpperCase())) {
      fetchOpts.body = JSON.stringify(payload);
    }

    req.log.info({ url, method, endpoint }, "Proxying raw request");
    const r = await fetch(url, fetchOpts);
    statusCode = r.status;
    r.headers.forEach((v, k) => { responseHeaders[k] = v; });

    const ct = r.headers.get("content-type") ?? "";
    const text = await r.text();
    try { responseBody = JSON.parse(text); } catch { responseBody = { _raw: text }; }
    success = r.ok;
    if (!success && responseBody && typeof responseBody === "object") {
      const b = responseBody as Record<string, unknown>;
      const d = b.data as Record<string, unknown> | undefined;
      error = (d?.details as string) ?? (d?.code as string) ?? null;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    error = msg; statusCode = 0; responseBody = { error: msg };
    logger.error({ err, url }, "Proxy fetch failed");
  }

  const responseTime = Date.now() - start;
  const entry: HistoryEntry = {
    id, success, statusCode, requestedAt, responseTime,
    endpoint, method: method.toUpperCase(), model: "",
    requestPayload: payload ?? null, responseBody, responseHeaders, error,
  };
  await recordRequest(entry);

  res.json({ id, success, statusCode, requestedAt, responseTime,
    endpoint, method: method.toUpperCase(),
    requestPayload: payload ?? null, responseBody, responseHeaders, error });
});

// GET /api/gateway/history
router.get("/gateway/history", async (req, res) => {
  const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
  res.json(await getHistory(limit));
});

// DELETE /api/gateway/history
router.delete("/gateway/history", async (_req, res) => {
  res.json({ cleared: await clearHistory() });
});

// GET /api/gateway/stats
router.get("/gateway/stats", async (_req, res) => {
  res.json(await getStats());
});

// GET /api/gateway/token-pool — status of the rotating bx-umidtoken pool
router.get("/gateway/token-pool", (_req, res) => {
  res.json(getPoolStatus());
});

export default router;
