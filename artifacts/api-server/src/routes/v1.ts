import { Router } from "express";
import { randomUUID, createHmac } from "crypto";
import { requireApiKey } from "../middleware/requireApiKey";
import { logger } from "../lib/logger";
import { recordRequest } from "../lib/stats";
import { ariaChat, ariaStream, isAriaModel, ARIA_MODELS } from "../lib/aria-provider";
import { yqcloudChat, yqcloudStream, isYqcloudModel, YQCLOUD_MODELS } from "../lib/yqcloud-provider";
import { cohereChat, cohereStream, isCohereModel, resolveCohereModel, COHERE_MODELS } from "../lib/cohere-provider";
import { gptfreeChat, gptfreeStream, isGptfreeModel, GPTFREE_MODELS } from "../lib/gptfree-provider";
import { algochatChat, algochatStream, isAlgochatModel, ALGOCHAT_MODELS } from "../lib/algochat-provider";
import { kimiChat, kimiStream, isKimiModel, KIMI_MODELS, cleanKimiOutput } from "../lib/kimi-provider";

const router = Router();

const MODELS: ModelEntry[] = [
  // Opera Aria — keyless, anonymous auth, powered by OpenAI + Google
  ...ARIA_MODELS.map(m => ({ ...m, capabilities: { vision: false, tools: true, json_mode: false, streaming: true } })),
  // Yqcloud — GPT-4 proxy, userId pool rotation
  ...YQCLOUD_MODELS.map(m => ({ ...m, capabilities: { vision: false, tools: true, json_mode: false, streaming: true } })),
  // Cohere — command-a/r/r+ via HuggingFace Space
  ...COHERE_MODELS.map(m => ({ ...m, capabilities: { vision: false, tools: true, json_mode: false, streaming: true } })),
  // GPTFree — Firebase anonymous auth, no account required
  ...GPTFREE_MODELS.map(m => ({ ...m, capabilities: { vision: false, tools: true, json_mode: false, streaming: true } })),
  // AlgoChat — Gemini 3 Flash Preview via algochat.app guest session
  ...ALGOCHAT_MODELS.map(m => ({ ...m, capabilities: { vision: false, tools: true, json_mode: false, streaming: true }, context_window: 1048576 })),
  // Kimi — Moonshot AI Kimi-K2 via Connect RPC (requires KIMI_TOKEN)
  ...KIMI_MODELS.map(m => ({ ...m, capabilities: { vision: false, tools: true, json_mode: false, streaming: true }, context_window: 131072 })),
];

const MODEL_ALIASES: Record<string, string> = {
}

function resolveModel(m: string): string {
  return MODEL_ALIASES[m] ?? m;
}

// ── Type definitions ─────────────────────────────────────────────────────────

interface ToolFunction {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}
interface Tool { type: "function"; function: ToolFunction }

interface DetectedToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface TextContentPart {
  type: "text";
  text: string;
}

interface ImageUrlContentPart {
  type: "image_url";
  image_url: { url: string; detail?: "low" | "high" | "auto" };
}

type ContentPart = TextContentPart | ImageUrlContentPart;

interface Message {
  role: string;
  content?: string | ContentPart[] | null;
  tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
  name?: string;
}

interface ModelEntry {
  id: string;
  object: string;
  created: number;
  owned_by: string;
  capabilities?: {
    vision?: boolean;
    tools?: boolean;
    json_mode?: boolean;
    streaming?: boolean;
  };
  context_window?: number;
}

// ── Content helpers ───────────────────────────────────────────────────────────

/** Extract plain text from a message content (string or multipart array). */
function getMessageText(content: string | ContentPart[] | null | undefined): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  return content
    .filter((p): p is TextContentPart => p.type === "text")
    .map(p => p.text)
    .join("\n");
}

/** Extract image URLs from a message content array. */
function getMessageImages(content: string | ContentPart[] | null | undefined): string[] {
  if (!content || typeof content === "string") return [];
  return content
    .filter((p): p is ImageUrlContentPart => p.type === "image_url")
    .map(p => p.image_url?.url)
    .filter((u): u is string => Boolean(u));
}

/** Build a multipart content array from text + image URLs. */
function buildMultipartContent(text: string, images: string[]): ContentPart[] {
  const parts: ContentPart[] = [];
  if (text) parts.push({ type: "text", text });
  for (const url of images) {
    parts.push({ type: "image_url", image_url: { url } });
  }
  return parts;
}

/** Collect all image URLs from all messages in a conversation. */
function collectAllImages(messages: Message[]): string[] {
  return messages.flatMap(m => getMessageImages(m.content));
}

/**
 * Flatten vision messages for text-only providers.
 * Strips image_url parts and adds a note that images were attached.
 */
async function flattenVisionMessages(messages: Message[]): Promise<Message[]> {
  return messages.map(m => {
    const images = getMessageImages(m.content);
    if (images.length === 0) return m;
    const text = getMessageText(m.content);
    const note = `\n[${images.length} image${images.length > 1 ? "s" : ""} attached — image understanding not available for this model]`;
    return { ...m, content: text + note };
  });
}

// ── Tool-call helpers ─────────────────────────────────────────────────────────

function buildToolDefs(tools: Tool[]): string {
  return tools.map(t => {
    const f = t.function;
    const params = f.parameters ? JSON.stringify(f.parameters) : "{}";
    return `- ${f.name}: ${f.description ?? "(no description)"} | params: ${params}`;
  }).join("\n");
}

function injectToolPrompt(
  messages: Message[],
  tools: Tool[],
  toolChoice: string | { type: string; function?: { name: string } } | undefined,
): Message[] {
  const defs = buildToolDefs(tools);
  const forcedTool =
    typeof toolChoice === "object" && toolChoice?.type === "function"
      ? toolChoice.function?.name
      : toolChoice === "required"
        ? tools[0]?.function?.name
        : null;

  const systemBlock = `You have access to external tools listed below. You do NOT have real-time internet access, so whenever the user asks for live data (weather, prices, time, news, calculations, etc.) you MUST call the appropriate tool instead of saying you cannot.

AVAILABLE TOOLS:
${defs}

STRICT RESPONSE RULES:
1. When calling tools: output ONLY a single raw JSON object — no markdown, no explanation, no surrounding text:
   {"tool_calls":[{"name":"TOOL_NAME","arguments":{...}}]}
2. To call MULTIPLE tools at once, put ALL of them in the SAME array in ONE single JSON object:
   {"tool_calls":[{"name":"TOOL_A","arguments":{...}},{"name":"TOOL_B","arguments":{...}}]}
3. NEVER output multiple separate JSON blocks. ONE response = ONE JSON object with all tool calls.
4. When NOT calling a tool, respond normally in plain text with NO JSON.
5. Your entire response must be EITHER the JSON object OR plain text — never both.`;

  let result: Array<{ role: string; content?: string | ContentPart[] | null }>;
  const first = messages[0];
  if (first?.role === "system") {
    result = [
      { role: "system", content: `${getMessageText(first.content)}\n\n${systemBlock}` },
      ...messages.slice(1),
    ];
  } else {
    result = [{ role: "system", content: systemBlock }, ...messages];
  }

  const lastIdx = result.length - 1;
  const last = result[lastIdx];
  if (last?.role === "user") {
    const reminder = forcedTool
      ? `\n\n[SYSTEM: You MUST call the tool "${forcedTool}" to answer this. Output only the JSON tool_calls object.]`
      : `\n\n[SYSTEM: If this request needs live data or an action you cannot do internally, call the appropriate tool. Output ONLY the JSON object {"tool_calls":[...]} with no other text.]`;
    const lastText = getMessageText(last.content);
    const lastImages = getMessageImages(last.content);
    result = [
      ...result.slice(0, lastIdx),
      {
        role: "user",
        content: lastImages.length > 0
          ? buildMultipartContent(lastText + reminder, lastImages)
          : `${lastText}${reminder}`,
      },
    ];
  }
  return result;
}

function injectJsonMode(messages: Message[]): Message[] {
  const jsonInstruction =
    "You MUST respond with a valid JSON object only. Do not include any explanation, markdown, or text outside the JSON structure.";
  const first = messages[0];
  if (first?.role === "system") {
    return [
      { role: "system", content: `${getMessageText(first.content)}\n\n${jsonInstruction}` },
      ...messages.slice(1),
    ];
  }
  return [{ role: "system", content: jsonInstruction }, ...messages];
}

function detectToolCalls(raw: string): DetectedToolCall[] | null {
  const cleaned = raw.trim().replace(/\`\`\`(?:json)?/gi, "").trim();
  const allCalls: DetectedToolCall[] = [];
  let callIndex = 0;

  // Strategy 1: top-level {"tool_calls":[...]}
  const topMatch = cleaned.match(/^\{[\s\S]*"tool_calls"\s*:\s*(\[[\s\S]*\])/);
  if (topMatch) {
    try {
      const arr = JSON.parse(topMatch[1]) as Array<{ name?: string; function?: { name?: string }; arguments?: unknown; id?: string }>;
      for (const item of arr) {
        const name = item.name ?? item.function?.name;
        if (!name) continue;
        const args = item.arguments;
        allCalls.push({
          id: `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
          type: "function",
          function: {
            name,
            arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}),
          },
        });
        callIndex++;
      }
      if (allCalls.length > 0) return allCalls;
    } catch { /* fall through */ }
  }

  // Strategy 2: scan for multiple {"name":...,"arguments":...} blocks
  const singleRe = /\{\s*"name"\s*:\s*"([^"]+)"\s*,\s*"arguments"\s*:\s*(\{[\s\S]*?\})\s*\}/g;
  let m: RegExpExecArray | null;
  while ((m = singleRe.exec(cleaned)) !== null) {
    try {
      const parsedArgs = JSON.parse(m[2]);
      allCalls.push({
        id: `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
        type: "function",
        function: { name: m[1], arguments: JSON.stringify(parsedArgs) },
      });
      callIndex++;
    } catch { /* skip malformed */ }
  }
  if (allCalls.length > 0) return allCalls;

  return null;
}

function looksLikeToolCallJson(text: string): boolean {
  const t = text.trim().replace(/\`\`\`(?:json)?/gi, "").trim();
  return /^\{[\s\S]*"tool_calls"\s*:\s*\[/.test(t) ||
    /^\{[\s\S]*"name"\s*:\s*"[^"]+"[\s\S]*"arguments"/.test(t);
}

// ── Prompt / token helpers ────────────────────────────────────────────────────

function messagesToPrompt(messages: Message[], suppressImageNotes = false): string {
  return messages.map(m => {
    const text = getMessageText(m.content);
    const images = getMessageImages(m.content);
    const imageNote = (!suppressImageNotes && images.length > 0)
      ? `\n[${images.length} image${images.length > 1 ? "s" : ""} attached]`
      : "";
    if (m.role === "system") return `System: ${text}${imageNote}`;
    if (m.role === "assistant") {
      if (m.tool_calls && m.tool_calls.length > 0) {
        const calls = m.tool_calls.map(tc => ({
          id: tc.id, name: tc.function.name,
          arguments: (() => { try { return JSON.parse(tc.function.arguments); } catch { return tc.function.arguments; } })(),
        }));
        const toolJson = JSON.stringify({ tool_calls: calls });
        const extra = text ? `${text}\n` : "";
        return `Assistant: ${extra}${toolJson}`;
      }
      return `Assistant: ${text}${imageNote}`;
    }
    if (m.role === "tool") {
      const toolName = m.name ? ` (${m.name})` : "";
      return `Tool Result${toolName} [id=${m.tool_call_id ?? "?"}]: ${text}`;
    }
    return `User: ${text}${imageNote}`;
  }).join("\n");
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.round(text.length / 4));
}

function applyStop(
  content: string,
  stop: string | string[] | null | undefined,
): { content: string; truncated: boolean } {
  if (!stop) return { content, truncated: false };
  const stops = Array.isArray(stop) ? stop : [stop];
  let earliest = content.length;
  for (const s of stops) {
    if (!s) continue;
    const idx = content.indexOf(s);
    if (idx !== -1 && idx < earliest) earliest = idx;
  }
  return earliest < content.length
    ? { content: content.slice(0, earliest), truncated: true }
    : { content, truncated: false };
}

function applyMaxTokens(
  content: string,
  maxTokens: number | null | undefined,
): { content: string; truncated: boolean } {
  if (!maxTokens || maxTokens <= 0) return { content, truncated: false };
  const maxChars = maxTokens * 4;
  return content.length > maxChars
    ? { content: content.slice(0, maxChars), truncated: true }
    : { content, truncated: false };
}


// ── POST /v1/chat/completions ────────────────────────────────────────────────

router.post("/chat/completions", requireApiKey, async (req, res) => {
  const reqStart = Date.now();
  const reqId = `v1-${randomUUID().replace(/-/g, "").slice(0, 20)}`;

  const {
    model: _rawModel = "command-a",
    messages,
    tools,
    tool_choice: _toolChoice,
    temperature: _temp,
    max_tokens: _maxTokens,
    max_completion_tokens: _maxCompletionTokens,
    stream = false,
    stream_options,
    response_format,
    stop: _stop,
    n: _n,
    top_p: _topP,
    presence_penalty: _pp,
    frequency_penalty: _fp,
    seed: _seed,
    logprobs: _logprobs,
    top_logprobs: _topLogprobs,
    parallel_tool_calls: _parallelToolCalls,
    user: _user,
    metadata: _metadata,
    store: _store,
  } = req.body as {
    model?: string;
    messages?: Message[];
    tools?: Tool[];
    tool_choice?: "none" | "auto" | "required" | { type: string; function?: { name: string } };
    temperature?: number;
    max_tokens?: number;
    max_completion_tokens?: number;
    stream?: boolean;
    stream_options?: { include_usage?: boolean };
    response_format?: { type?: "text" | "json_object" | "json_schema"; json_schema?: unknown };
    stop?: string | string[] | null;
    n?: number;
    top_p?: number;
    presence_penalty?: number;
    frequency_penalty?: number;
    seed?: number;
    logprobs?: boolean | null;
    top_logprobs?: number | null;
    parallel_tool_calls?: boolean;
    user?: string;
    metadata?: Record<string, string>;
    store?: boolean;
  };

  // max_completion_tokens is the newer OpenAI API name for max_tokens — support both
  const _max = _maxCompletionTokens ?? _maxTokens;
  // json_schema response format — treat as json_object (best-effort)
  const effectiveJsonMode = response_format?.type === "json_object" || response_format?.type === "json_schema";

  const model = resolveModel(_rawModel);

  const temperature = typeof _temp === "number"
    ? Math.max(0, Math.min(2, _temp))
    : 0.7;

  const includeUsage = stream_options?.include_usage === true;


  res.on("finish", () => {
    recordRequest({
      id: reqId,
      success: res.statusCode < 400,
      statusCode: res.statusCode,
      requestedAt: new Date(reqStart).toISOString(),
      responseTime: Date.now() - reqStart,
      endpoint: "v1/chat/completions",
      method: "POST",
      model,
      requestPayload: { model, messages: messages?.slice(0, 3) },
      responseBody: null,
      responseHeaders: {},
      error: res.statusCode >= 400 ? `HTTP ${res.statusCode}` : null,
    });
  });

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({
      error: {
        message: "messages is required and must be a non-empty array",
        type: "invalid_request_error",
        param: "messages",
        code: "missing_messages",
      },
    });
    return;
  }

  if (typeof _n === "number" && _n > 1) {
    res.status(400).json({
      error: {
        message: `This gateway does not support n > 1. Got n=${_n}.`,
        type: "invalid_request_error",
        param: "n",
        code: "unsupported_value",
      },
    });
    return;
  }

  // Detect images across all messages
  const allImageUrls = collectAllImages(messages);
  const hasImages = allImageUrls.length > 0;

  const effectiveModel = model;

  const hasTools = Array.isArray(tools) && tools.length > 0 && _toolChoice !== "none";

  let effectiveMessages = messages;
  if (hasTools) effectiveMessages = injectToolPrompt(effectiveMessages, tools!, _toolChoice);
  if (effectiveJsonMode && !hasTools) effectiveMessages = injectJsonMode(effectiveMessages);

  const id = `chatcmpl-${randomUUID().replace(/-/g, "").slice(0, 29)}`;
  const created = Math.floor(Date.now() / 1000);

  // ── SSE helpers ─────────────────────────────────────────────────────────
  function sseChunk(delta: Record<string, unknown>, finishReason: string | null = null): string {
    const payload = {
      id,
      object: "chat.completion.chunk",
      created,
      model: _rawModel,
      service_tier: "default",
      system_fingerprint: "fp_gateway",
      choices: [{ index: 0, delta, logprobs: null, finish_reason: finishReason }],
    };
    return `data: ${JSON.stringify(payload)}\n\n`;
  }

  function sseUsageChunk(inputTokens: number, outputTokens: number): string {
    const payload = {
      id,
      object: "chat.completion.chunk",
      created,
      model: _rawModel,
      service_tier: "default",
      system_fingerprint: "fp_gateway",
      choices: [],
      usage: {
        prompt_tokens: inputTokens,
        completion_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
        prompt_tokens_details: { cached_tokens: 0, audio_tokens: 0 },
        completion_tokens_details: { reasoning_tokens: 0, audio_tokens: 0, accepted_prediction_tokens: 0, rejected_prediction_tokens: 0 },
      },
    };
    return `data: ${JSON.stringify(payload)}\n\n`;
  }

  function startSSE() {
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
  }

  try {
    // ── ARIA provider path ───────────────────────────────────────────────────
    if (isAriaModel(model)) {
      const ariaEffective = hasImages ? await flattenVisionMessages(effectiveMessages) : effectiveMessages;
      const ariaMessages = ariaEffective.map(m => ({
        role: m.role,
        content: typeof m.content === "string" ? m.content : getMessageText(m.content),
      }));

      if (stream) {
        startSSE();

        let ariaCollected = "";
        try {
          for await (const token of ariaStream(ariaMessages, model)) {
            if (token) ariaCollected += token;
          }
        } catch (err: unknown) {
          logger.warn({ err }, "aria: stream error");
        }

        const ariaSsMt = applyMaxTokens(ariaCollected, _max);
        const ariaSsSt = applyStop(ariaSsMt.content, _stop);
        const ariaFinalText = ariaSsSt.content;
        const ariaStreamFinish = (ariaSsMt.truncated || ariaSsSt.truncated) ? "length" : "stop";
        const ariaPromptEst = Math.round(ariaMessages.map(m => m.content).join("").length / 4);
        const ariaOutEst = Math.round(ariaFinalText.length / 4);

        if (hasTools) {
          const ariaStreamToolCalls = detectToolCalls(ariaFinalText);
          if (ariaStreamToolCalls) {
            res.write(sseChunk({ role: "assistant", content: null }));
            for (let i = 0; i < ariaStreamToolCalls.length; i++) {
              const tc = ariaStreamToolCalls[i];
              res.write(sseChunk({ tool_calls: [{ index: i, id: tc.id, type: "function", function: { name: tc.function.name, arguments: "" } }] }));
              const args = tc.function.arguments;
              for (let j = 0; j < args.length; j += 20) {
                res.write(sseChunk({ tool_calls: [{ index: i, function: { arguments: args.slice(j, j + 20) } }] }));
              }
            }
            if (includeUsage) res.write(sseUsageChunk(ariaPromptEst, ariaOutEst));
            res.write(sseChunk({}, "tool_calls"));
            res.write("data: [DONE]\n\n");
            res.end();
            return;
          }
        }

        res.write(sseChunk({ role: "assistant", content: "" }));
        for (const w of ariaFinalText.split(/(\s+)/)) {
          if (w) res.write(sseChunk({ content: w }));
        }
        if (includeUsage) res.write(sseUsageChunk(ariaPromptEst, ariaOutEst));
        res.write(sseChunk({}, ariaStreamFinish));
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }

      const { content: ariaRaw, inputTokens, outputTokens } = await ariaChat(ariaMessages, model);
      if (!ariaRaw) {
        res.status(502).json({
          error: { message: "No response from Aria", type: "upstream_error", code: "empty_response" },
        });
        return;
      }
      const ariaMt = applyMaxTokens(ariaRaw, _max);
      const ariaSt = applyStop(ariaMt.content, _stop);
      const ariaContent = ariaSt.content;
      const ariaFinalFinish = (ariaMt.truncated || ariaSt.truncated) ? "length" : "stop";
      const ariaUsage = {
        prompt_tokens: inputTokens,
        completion_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
        prompt_tokens_details: { cached_tokens: 0, audio_tokens: 0 },
        completion_tokens_details: { reasoning_tokens: 0, audio_tokens: 0, accepted_prediction_tokens: 0, rejected_prediction_tokens: 0 },
      };

      const ariaToolCalls = hasTools ? detectToolCalls(ariaContent) : null;
      if (ariaToolCalls) {
        res.json({ id, object: "chat.completion", created, model: _rawModel, service_tier: "default",
          system_fingerprint: "fp_aria_gateway",
          choices: [{ index: 0, message: { role: "assistant", refusal: null, content: null, tool_calls: ariaToolCalls }, logprobs: null, finish_reason: "tool_calls" }],
          usage: ariaUsage });
        return;
      }
      res.json({ id, object: "chat.completion", created, model: _rawModel, service_tier: "default",
        system_fingerprint: "fp_aria_gateway",
        choices: [{ index: 0, message: { role: "assistant", refusal: null, content: ariaContent }, logprobs: null, finish_reason: ariaFinalFinish }],
        usage: ariaUsage });
      return;
    }

    // ── Yqcloud provider path ────────────────────────────────────────────────
    if (isYqcloudModel(model)) {
      const yqEffective = hasImages ? await flattenVisionMessages(effectiveMessages) : effectiveMessages;
      const yqMessages = yqEffective.map(m => ({
        role: m.role,
        content: typeof m.content === "string" ? m.content : getMessageText(m.content),
      }));

      if (stream) {
        startSSE();

        let yqCollected = "";
        try {
          for await (const token of yqcloudStream(yqMessages, model)) {
            if (token) yqCollected += token;
          }
        } catch (err: unknown) {
          logger.warn({ err }, "yqcloud: stream error");
        }

        const yqSsMt = applyMaxTokens(yqCollected, _max);
        const yqSsSt = applyStop(yqSsMt.content, _stop);
        const yqFinalText = yqSsSt.content;
        const yqStreamFinish = (yqSsMt.truncated || yqSsSt.truncated) ? "length" : "stop";
        const yqPromptEst = estimateTokens(messagesToPrompt(yqMessages));
        const yqOutEst = Math.round(yqFinalText.length / 4);

        if (hasTools) {
          const yqStreamToolCalls = detectToolCalls(yqFinalText);
          if (yqStreamToolCalls) {
            res.write(sseChunk({ role: "assistant", content: null }));
            for (let i = 0; i < yqStreamToolCalls.length; i++) {
              const tc = yqStreamToolCalls[i];
              res.write(sseChunk({ tool_calls: [{ index: i, id: tc.id, type: "function", function: { name: tc.function.name, arguments: "" } }] }));
              const args = tc.function.arguments;
              for (let j = 0; j < args.length; j += 20) {
                res.write(sseChunk({ tool_calls: [{ index: i, function: { arguments: args.slice(j, j + 20) } }] }));
              }
            }
            if (includeUsage) res.write(sseUsageChunk(yqPromptEst, yqOutEst));
            res.write(sseChunk({}, "tool_calls"));
            res.write("data: [DONE]\n\n");
            res.end();
            return;
          }
        }

        res.write(sseChunk({ role: "assistant", content: "" }));
        for (const w of yqFinalText.split(/(\s+)/)) {
          if (w) res.write(sseChunk({ content: w }));
        }
        if (includeUsage) res.write(sseUsageChunk(yqPromptEst, yqOutEst));
        res.write(sseChunk({}, yqStreamFinish));
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }

      const { content: yqRaw, inputTokens: yqInTokens, outputTokens: yqOutTokens } = await yqcloudChat(yqMessages, model);
      if (!yqRaw) {
        res.status(502).json({ error: { message: "No response from Yqcloud", type: "upstream_error", code: "empty_response" } });
        return;
      }
      const yqMt = applyMaxTokens(yqRaw, _max);
      const yqSt = applyStop(yqMt.content, _stop);
      const yqContent = yqSt.content;
      const yqFinish = (yqMt.truncated || yqSt.truncated) ? "length" : "stop";
      const yqUsage = { prompt_tokens: yqInTokens, completion_tokens: yqOutTokens, total_tokens: yqInTokens + yqOutTokens, prompt_tokens_details: { cached_tokens: 0, audio_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0, audio_tokens: 0, accepted_prediction_tokens: 0, rejected_prediction_tokens: 0 } };
      const toolCalls = hasTools ? detectToolCalls(yqContent) : null;
      if (toolCalls) {
        res.json({ id, object: "chat.completion", created, model: _rawModel, service_tier: "default", system_fingerprint: "fp_yqcloud_gateway",
          choices: [{ index: 0, message: { role: "assistant", refusal: null, content: null, tool_calls: toolCalls }, logprobs: null, finish_reason: "tool_calls" }],
          usage: yqUsage });
        return;
      }
      res.json({ id, object: "chat.completion", created, model: _rawModel, service_tier: "default", system_fingerprint: "fp_yqcloud_gateway",
        choices: [{ index: 0, message: { role: "assistant", refusal: null, content: yqContent }, logprobs: null, finish_reason: yqFinish }],
        usage: yqUsage });
      return;
    }

    // ── Cohere provider path ─────────────────────────────────────────────────
    if (isCohereModel(model)) {
      const cohereModel = resolveCohereModel(model);
      const coEffective = hasImages ? await flattenVisionMessages(effectiveMessages) : effectiveMessages;
      const cohereMessages = coEffective.map(m => ({
        role: m.role,
        content: typeof m.content === "string" ? m.content : getMessageText(m.content),
      }));

      if (stream) {
        startSSE();

        // Collect full response for tool detection, stop sequences, max_tokens
        let coCollected = "";
        try {
          for await (const token of cohereStream(cohereMessages, cohereModel)) {
            if (token) coCollected += token;
          }
        } catch (err: unknown) {
          logger.warn({ err }, "cohere: stream error");
        }

        const coSsMt = applyMaxTokens(coCollected, _max);
        const coSsSt = applyStop(coSsMt.content, _stop);
        const coFinalText = coSsSt.content;
        const coStreamFinish = (coSsMt.truncated || coSsSt.truncated) ? "length" : "stop";
        const coPromptEst = estimateTokens(messagesToPrompt(cohereMessages));
        const coOutEst = Math.round(coFinalText.length / 4);

        if (hasTools) {
          const coStreamToolCalls = detectToolCalls(coFinalText);
          if (coStreamToolCalls) {
            res.write(sseChunk({ role: "assistant", content: null }));
            for (let i = 0; i < coStreamToolCalls.length; i++) {
              const tc = coStreamToolCalls[i];
              res.write(sseChunk({ tool_calls: [{ index: i, id: tc.id, type: "function", function: { name: tc.function.name, arguments: "" } }] }));
              const args = tc.function.arguments;
              for (let j = 0; j < args.length; j += 20) {
                res.write(sseChunk({ tool_calls: [{ index: i, function: { arguments: args.slice(j, j + 20) } }] }));
              }
            }
            if (includeUsage) res.write(sseUsageChunk(coPromptEst, coOutEst));
            res.write(sseChunk({}, "tool_calls"));
            res.write("data: [DONE]\n\n");
            res.end();
            return;
          }
        }

        res.write(sseChunk({ role: "assistant", content: "" }));
        for (const w of coFinalText.split(/(\s+)/)) {
          if (w) res.write(sseChunk({ content: w }));
        }
        if (includeUsage) res.write(sseUsageChunk(coPromptEst, coOutEst));
        res.write(sseChunk({}, coStreamFinish));
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }

      const { content: coRaw, inputTokens: coIn, outputTokens: coOut } = await cohereChat(cohereMessages, cohereModel);
      if (!coRaw) {
        res.status(502).json({ error: { message: "No response from Cohere", type: "upstream_error", code: "empty_response" } });
        return;
      }
      const coMt = applyMaxTokens(coRaw, _max);
      const coSt = applyStop(coMt.content, _stop);
      const coContent = coSt.content;
      const coFinish = (coMt.truncated || coSt.truncated) ? "length" : "stop";
      const coUsage = { prompt_tokens: coIn, completion_tokens: coOut, total_tokens: coIn + coOut, prompt_tokens_details: { cached_tokens: 0, audio_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0, audio_tokens: 0, accepted_prediction_tokens: 0, rejected_prediction_tokens: 0 } };
      const toolCalls = hasTools ? detectToolCalls(coContent) : null;
      if (toolCalls) {
        res.json({ id, object: "chat.completion", created, model: _rawModel, service_tier: "default", system_fingerprint: "fp_cohere_gateway",
          choices: [{ index: 0, message: { role: "assistant", refusal: null, content: null, tool_calls: toolCalls }, logprobs: null, finish_reason: "tool_calls" }],
          usage: coUsage });
        return;
      }
      res.json({ id, object: "chat.completion", created, model: _rawModel, service_tier: "default", system_fingerprint: "fp_cohere_gateway",
        choices: [{ index: 0, message: { role: "assistant", refusal: null, content: coContent }, logprobs: null, finish_reason: coFinish }],
        usage: coUsage });
      return;
    }

    // ── AlgoChat provider path ───────────────────────────────────────────────
    if (isAlgochatModel(model)) {
      const acEffective = hasImages ? await flattenVisionMessages(effectiveMessages) : effectiveMessages;
      const acMessages = acEffective.map(m => ({
        role: m.role,
        content: typeof m.content === "string" ? m.content : getMessageText(m.content),
      }));

      if (stream) {
        startSSE();

        let acCollected = "";
        try {
          for await (const token of algochatStream(acMessages, model)) {
            if (token) acCollected += token;
          }
        } catch (err: unknown) {
          logger.warn({ err }, "algochat: stream error");
        }

        const acSsMt = applyMaxTokens(acCollected, _max);
        const acSsSt = applyStop(acSsMt.content, _stop);
        const acFinalText = acSsSt.content;
        const acStreamFinish = (acSsMt.truncated || acSsSt.truncated) ? "length" : "stop";
        const acPromptEst = estimateTokens(messagesToPrompt(acMessages));
        const acOutEst = Math.round(acFinalText.length / 4);

        if (hasTools) {
          const acStreamToolCalls = detectToolCalls(acFinalText);
          if (acStreamToolCalls) {
            res.write(sseChunk({ role: "assistant", content: null }));
            for (let i = 0; i < acStreamToolCalls.length; i++) {
              const tc = acStreamToolCalls[i];
              res.write(sseChunk({ tool_calls: [{ index: i, id: tc.id, type: "function", function: { name: tc.function.name, arguments: "" } }] }));
              const args = tc.function.arguments;
              for (let j = 0; j < args.length; j += 20) {
                res.write(sseChunk({ tool_calls: [{ index: i, function: { arguments: args.slice(j, j + 20) } }] }));
              }
            }
            if (includeUsage) res.write(sseUsageChunk(acPromptEst, acOutEst));
            res.write(sseChunk({}, "tool_calls"));
            res.write("data: [DONE]\n\n");
            res.end();
            return;
          }
        }

        res.write(sseChunk({ role: "assistant", content: "" }));
        for (const w of acFinalText.split(/(\s+)/)) {
          if (w) res.write(sseChunk({ content: w }));
        }
        if (includeUsage) res.write(sseUsageChunk(acPromptEst, acOutEst));
        res.write(sseChunk({}, acStreamFinish));
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }

      const { content: acRaw, inputTokens: acIn, outputTokens: acOut } = await algochatChat(acMessages, model);
      if (!acRaw) {
        res.status(502).json({ error: { message: "No response from AlgoChat", type: "upstream_error", code: "empty_response" } });
        return;
      }
      const acMt = applyMaxTokens(acRaw, _max);
      const acSt = applyStop(acMt.content, _stop);
      const acContent = acSt.content;
      const acFinish = (acMt.truncated || acSt.truncated) ? "length" : "stop";
      const acUsage = { prompt_tokens: acIn, completion_tokens: acOut, total_tokens: acIn + acOut, prompt_tokens_details: { cached_tokens: 0, audio_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0, audio_tokens: 0, accepted_prediction_tokens: 0, rejected_prediction_tokens: 0 } };
      const acToolCalls = hasTools ? detectToolCalls(acContent) : null;
      if (acToolCalls) {
        res.json({ id, object: "chat.completion", created, model: _rawModel, service_tier: "default", system_fingerprint: "fp_algochat_gateway",
          choices: [{ index: 0, message: { role: "assistant", refusal: null, content: null, tool_calls: acToolCalls }, logprobs: null, finish_reason: "tool_calls" }],
          usage: acUsage });
        return;
      }
      res.json({ id, object: "chat.completion", created, model: _rawModel, service_tier: "default", system_fingerprint: "fp_algochat_gateway",
        choices: [{ index: 0, message: { role: "assistant", refusal: null, content: acContent }, logprobs: null, finish_reason: acFinish }],
        usage: acUsage });
      return;
    }

    // ── Kimi provider path (Moonshot AI Kimi-K2 via Connect RPC) ────────────
    if (isKimiModel(model)) {
      const kmEffective = hasImages ? await flattenVisionMessages(effectiveMessages) : effectiveMessages;
      const kmMessages = kmEffective.map(m => ({
        role: m.role,
        content: typeof m.content === "string" ? m.content : getMessageText(m.content),
      }));

      if (stream) {
        startSSE();

        let kmCollected = "";
        try {
          for await (const token of kimiStream(kmMessages, model)) {
            if (token) kmCollected += token;
          }
        } catch (err: unknown) {
          logger.warn({ err }, "kimi: stream error");
        }
        kmCollected = cleanKimiOutput(kmCollected);

        const kmSsMt = applyMaxTokens(kmCollected, _max);
        const kmSsSt = applyStop(kmSsMt.content, _stop);
        const kmFinalText = kmSsSt.content;
        const kmStreamFinish = (kmSsMt.truncated || kmSsSt.truncated) ? "length" : "stop";
        const kmPromptEst = estimateTokens(messagesToPrompt(kmMessages));
        const kmOutEst = Math.round(kmFinalText.length / 4);

        if (hasTools) {
          const kmStreamToolCalls = detectToolCalls(kmFinalText);
          if (kmStreamToolCalls) {
            res.write(sseChunk({ role: "assistant", content: null }));
            for (let i = 0; i < kmStreamToolCalls.length; i++) {
              const tc = kmStreamToolCalls[i];
              res.write(sseChunk({ tool_calls: [{ index: i, id: tc.id, type: "function", function: { name: tc.function.name, arguments: "" } }] }));
              const args = tc.function.arguments;
              for (let j = 0; j < args.length; j += 20) {
                res.write(sseChunk({ tool_calls: [{ index: i, function: { arguments: args.slice(j, j + 20) } }] }));
              }
            }
            if (includeUsage) res.write(sseUsageChunk(kmPromptEst, kmOutEst));
            res.write(sseChunk({}, "tool_calls"));
            res.write("data: [DONE]\n\n");
            res.end();
            return;
          }
        }

        res.write(sseChunk({ role: "assistant", content: "" }));
        for (const w of kmFinalText.split(/(\s+)/)) {
          if (w) res.write(sseChunk({ content: w }));
        }
        if (includeUsage) res.write(sseUsageChunk(kmPromptEst, kmOutEst));
        res.write(sseChunk({}, kmStreamFinish));
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }

      let kmResult: { content: string; inputTokens: number; outputTokens: number };
      try {
        kmResult = await kimiChat(kmMessages, model);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Kimi upstream error";
        res.status(502).json({ error: { message: msg, type: "upstream_error", code: "provider_error" } });
        return;
      }
      const { content: kmRaw, inputTokens: kmIn, outputTokens: kmOut } = kmResult;
      if (!kmRaw) {
        res.status(502).json({ error: { message: "No response from Kimi", type: "upstream_error", code: "empty_response" } });
        return;
      }
      const kmMt = applyMaxTokens(kmRaw, _max);
      const kmSt = applyStop(kmMt.content, _stop);
      const kmContent = kmSt.content;
      const kmFinish = (kmMt.truncated || kmSt.truncated) ? "length" : "stop";
      const kmUsage = { prompt_tokens: kmIn, completion_tokens: kmOut, total_tokens: kmIn + kmOut, prompt_tokens_details: { cached_tokens: 0, audio_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0, audio_tokens: 0, accepted_prediction_tokens: 0, rejected_prediction_tokens: 0 } };
      const kmToolCalls = hasTools ? detectToolCalls(kmContent) : null;
      if (kmToolCalls) {
        res.json({ id, object: "chat.completion", created, model: _rawModel, service_tier: "default", system_fingerprint: "fp_kimi_gateway",
          choices: [{ index: 0, message: { role: "assistant", refusal: null, content: null, tool_calls: kmToolCalls }, logprobs: null, finish_reason: "tool_calls" }],
          usage: kmUsage });
        return;
      }
      res.json({ id, object: "chat.completion", created, model: _rawModel, service_tier: "default", system_fingerprint: "fp_kimi_gateway",
        choices: [{ index: 0, message: { role: "assistant", refusal: null, content: kmContent }, logprobs: null, finish_reason: kmFinish }],
        usage: kmUsage });
      return;
    }

    // ── GPTFree provider path ────────────────────────────────────────────────
    if (isGptfreeModel(model)) {
      const gfEffective = hasImages ? await flattenVisionMessages(effectiveMessages) : effectiveMessages;
      const gfMessages = gfEffective.map(m => ({
        role: m.role,
        content: typeof m.content === "string" ? m.content : getMessageText(m.content),
      }));

      if (stream) {
        startSSE();

        // Collect full response for tool detection, stop sequences, max_tokens
        let gfCollected = "";
        try {
          for await (const token of gptfreeStream(gfMessages, model)) {
            if (token) gfCollected += token;
          }
        } catch (err: unknown) {
          logger.warn({ err }, "gptfree: stream error");
        }

        const gfSsMt = applyMaxTokens(gfCollected, _max);
        const gfSsSt = applyStop(gfSsMt.content, _stop);
        const gfFinalText = gfSsSt.content;
        const gfStreamFinish = (gfSsMt.truncated || gfSsSt.truncated) ? "length" : "stop";
        const gfPromptEst = estimateTokens(messagesToPrompt(gfMessages));
        const gfOutEst = Math.round(gfFinalText.length / 4);

        if (hasTools) {
          const gfStreamToolCalls = detectToolCalls(gfFinalText);
          if (gfStreamToolCalls) {
            res.write(sseChunk({ role: "assistant", content: null }));
            for (let i = 0; i < gfStreamToolCalls.length; i++) {
              const tc = gfStreamToolCalls[i];
              res.write(sseChunk({ tool_calls: [{ index: i, id: tc.id, type: "function", function: { name: tc.function.name, arguments: "" } }] }));
              const args = tc.function.arguments;
              for (let j = 0; j < args.length; j += 20) {
                res.write(sseChunk({ tool_calls: [{ index: i, function: { arguments: args.slice(j, j + 20) } }] }));
              }
            }
            if (includeUsage) res.write(sseUsageChunk(gfPromptEst, gfOutEst));
            res.write(sseChunk({}, "tool_calls"));
            res.write("data: [DONE]\n\n");
            res.end();
            return;
          }
        }

        res.write(sseChunk({ role: "assistant", content: "" }));
        for (const w of gfFinalText.split(/(\s+)/)) {
          if (w) res.write(sseChunk({ content: w }));
        }
        if (includeUsage) res.write(sseUsageChunk(gfPromptEst, gfOutEst));
        res.write(sseChunk({}, gfStreamFinish));
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }

      const { content: gfRaw, inputTokens: gfIn, outputTokens: gfOut } = await gptfreeChat(gfMessages, model);
      if (!gfRaw) {
        res.status(502).json({ error: { message: "No response from GPTFree", type: "upstream_error", code: "empty_response" } });
        return;
      }
      const gfMt = applyMaxTokens(gfRaw, _max);
      const gfSt = applyStop(gfMt.content, _stop);
      const gfContent = gfSt.content;
      const gfFinish = (gfMt.truncated || gfSt.truncated) ? "length" : "stop";
      const gfUsage = { prompt_tokens: gfIn, completion_tokens: gfOut, total_tokens: gfIn + gfOut, prompt_tokens_details: { cached_tokens: 0, audio_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0, audio_tokens: 0, accepted_prediction_tokens: 0, rejected_prediction_tokens: 0 } };
      const gfToolCalls = hasTools ? detectToolCalls(gfContent) : null;
      if (gfToolCalls) {
        res.json({ id, object: "chat.completion", created, model: _rawModel, service_tier: "default", system_fingerprint: "fp_gptfree_gateway",
          choices: [{ index: 0, message: { role: "assistant", refusal: null, content: null, tool_calls: gfToolCalls }, logprobs: null, finish_reason: "tool_calls" }],
          usage: gfUsage });
        return;
      }
      res.json({ id, object: "chat.completion", created, model: _rawModel, service_tier: "default", system_fingerprint: "fp_gptfree_gateway",
        choices: [{ index: 0, message: { role: "assistant", refusal: null, content: gfContent }, logprobs: null, finish_reason: gfFinish }],
        usage: gfUsage });
      return;
    }

    // ── Unknown model fallback ───────────────────────────────────────────────
    res.status(400).json({
      error: {
        message: `The model '${_rawModel}' does not exist or is not supported.`,
        type: "invalid_request_error",
        param: "model",
        code: "model_not_found",
      },
    });
    return;
  } catch (err) {
    logger.error({ err }, "v1/chat/completions error");
    const errMsg = err instanceof Error ? err.message : "Internal server error";
    // Pass through meaningful provider errors instead of swallowing them
    const isProvider = errMsg.startsWith("Perplexity") || errMsg.startsWith("AlgoChat")
                    || errMsg.startsWith("Kimi") || errMsg.startsWith("GPTFree")
                    || errMsg.startsWith("Opera") || errMsg.includes("authwall")
                    || errMsg.includes("rate limit") || errMsg.includes("rate limited")
                    || errMsg.includes("upstream");
    const expose  = isProvider;
    const message = expose ? errMsg : "Internal server error";
    const type    = isProvider ? "upstream_error" : "server_error";
    const code    = isProvider ? "provider_error"  : "internal_error";
    if (!res.headersSent) {
      res.status(500).json({ error: { message, type, code } });
    } else {
      res.write(`data: ${JSON.stringify({ error: message })}\n\ndata: [DONE]\n\n`);
      res.end();
    }
  }
});

// ── GET /v1/models ───────────────────────────────────────────────────────────

router.get("/models", requireApiKey, (_req, res) => {
  res.json({ object: "list", data: MODELS });
});

// ── GET /v1/models/:model ────────────────────────────────────────────────────

router.get("/models/:model", requireApiKey, (req, res) => {
  const paramModel = String(req.params.model);
  const resolvedId = resolveModel(paramModel);
  const found = MODELS.find(m => m.id === resolvedId || m.id === paramModel);
  if (!found) {
    res.status(404).json({
      error: {
        message: `The model '${req.params.model}' does not exist`,
        type: "invalid_request_error",
        param: "model",
        code: "model_not_found",
      },
    });
    return;
  }
  res.json(found);
});

// ── POST /v1/completions (legacy text completions — not supported) ──────────

router.post("/completions", requireApiKey, (_req, res) => {
  res.status(501).json({
    error: {
      message: "Legacy text completions endpoint is not supported. Use /v1/chat/completions.",
      type: "invalid_request_error",
      param: null,
      code: "unsupported_endpoint",
    },
  });
});


// ── POST /v1/embeddings ───────────────────────────────────────────────────────

router.post("/embeddings", requireApiKey, (_req, res) => {
  res.status(400).json({
    error: {
      message: "Embeddings are not supported by this gateway. Use a dedicated embeddings provider.",
      type: "invalid_request_error",
      param: null,
      code: "unsupported_endpoint",
    },
  });
});

// ── POST /v1/images/generations ─────────────────────────────────────────────

router.post("/images/generations", requireApiKey, (_req, res) => {
  res.status(501).json({
    error: {
      message: "Image generation is not supported by this gateway.",
      type: "invalid_request_error",
      param: null,
      code: "unsupported_endpoint",
    },
  });
});


export default router;
