/**
 * Perplexity AI Provider
 *
 * Endpoint : POST https://www.perplexity.ai/rest/sse/perplexity_ask
 * Auth     : None — IP-based, no login required
 * Models   : perplexity (turbo), perplexity-sonar, perplexity-r1, perplexity-pro
 *
 * Rate limit: ~5 req/min per IP. Resets at 12:00 AM UTC daily for heavy usage.
 * From datacenter IPs the limit is much more lenient in practice.
 *
 * Response format: SSE stream of JSON blobs.
 *   - Text tokens arrive in: blocks[].markdown_block.chunks[] when text_completed=true
 *   - Target intended_usage: "ask_text_0_markdown"
 *   - End signal: message contains final=true
 */

import { execSync } from "child_process";
import { randomUUID } from "crypto";
import { logger } from "./logger";

const ENDPOINT = "https://www.perplexity.ai/rest/sse/perplexity_ask";

const CHROME_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

// ── Model map ─────────────────────────────────────────────────────────────────
// Only "turbo" and "default" work without a Perplexity account.
// sonar/r1/pro return INVALID_MODEL_SELECTION for guest requests.

const MODEL_PREFERENCE_MAP: Record<string, string> = {
  "perplexity":       "turbo",
  "perplexity-turbo": "turbo",
  "perplexity-pro":   "default",
};

export const PERPLEXITY_MODELS = [
  { id: "perplexity",       object: "model", created: 1700000000, owned_by: "perplexity" },
  { id: "perplexity-turbo", object: "model", created: 1700000000, owned_by: "perplexity" },
  { id: "perplexity-pro",   object: "model", created: 1700000000, owned_by: "perplexity" },
];

export function isPerplexityModel(model: string): boolean {
  return model in MODEL_PREFERENCE_MAP;
}

// ── Message helpers ───────────────────────────────────────────────────────────

export interface ChatMessage {
  role: string;
  content: string;
}

/**
 * Collapse messages into a single query string.
 * Perplexity has no multi-turn API — the whole conversation becomes one prompt.
 */
function buildQuery(messages: ChatMessage[]): string {
  if (messages.length === 0) return "";
  if (messages.length === 1) return messages[0].content;

  return messages
    .map(m => {
      if (m.role === "system") return `[System]: ${m.content}`;
      if (m.role === "assistant") return `[Assistant]: ${m.content}`;
      return `[User]: ${m.content}`;
    })
    .join("\n\n");
}

// ── SSE response parser ───────────────────────────────────────────────────────

interface PerplexityBlock {
  intended_usage?: string;
  markdown_block?: {
    progress?: string;
    chunks?: string[];
    chunk_starting_offset?: number;
  };
}

interface PerplexitySSEMessage {
  text_completed?: boolean;
  final?: boolean;
  final_sse_message?: boolean;
  blocks?: PerplexityBlock[];
  status?: string;
}

/**
 * Parse Perplexity SSE response and extract text tokens in order.
 * Uses first-seen-wins per offset to avoid duplicate overwrites.
 * Throws on known Perplexity error codes.
 */
function parsePerplexitySSE(raw: string): string {
  let result = "";
  const seenOffsets = new Set<number>();

  for (const line of raw.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const jsonStr = line.slice(6).trim();
    if (!jsonStr || jsonStr === "{}") continue;

    try {
      const msg = JSON.parse(jsonStr) as PerplexitySSEMessage & {
        error_code?: string;
        text?: string;
        status?: string;
      };

      // Surface Perplexity error codes as explicit errors
      if (msg.error_code) {
        const errText = msg.text ?? msg.error_code;
        if (msg.error_code === "INVALID_MODEL_SELECTION") {
          throw new Error(`Perplexity: model not available for guest requests (${msg.error_code})`);
        }
        if (msg.status === "failed" || msg.error_code.includes("RATE") || msg.error_code.includes("LIMIT")) {
          throw new Error(`Perplexity rate limited: ${errText}`);
        }
        throw new Error(`Perplexity error: ${errText}`);
      }

      if (!msg.blocks) continue;

      for (const block of msg.blocks) {
        // Only take the primary text block (ask_text mirrors it — skip to avoid dups)
        if (block.intended_usage !== "ask_text_0_markdown") continue;
        if (!block.markdown_block?.chunks?.length) continue;

        const offset = block.markdown_block.chunk_starting_offset ?? 0;
        if (seenOffsets.has(offset)) continue; // first-seen-wins: ignore re-sent chunks
        seenOffsets.add(offset);

        result += block.markdown_block.chunks.join("");
      }
    } catch (err) {
      // Re-throw Perplexity errors, skip parse errors
      if (err instanceof Error && err.message.startsWith("Perplexity")) throw err;
    }
  }

  return result;
}

// ── Core request ──────────────────────────────────────────────────────────────

function buildRequestBody(query: string, modelPreference: string): string {
  const frontendUuid = randomUUID();
  const contextUuid  = randomUUID();
  const requestId    = randomUUID();

  return JSON.stringify({
    params: {
      attachments: [],
      language: "en-US",
      timezone: "America/Los_Angeles",
      search_focus: "internet",
      sources: ["web"],
      frontend_uuid: frontendUuid,
      mode: "copilot",
      model_preference: modelPreference,
      is_related_query: false,
      frontend_context_uuid: contextUuid,
      prompt_source: "user",
      query_source: "home",
      use_schematized_api: true,
      send_back_text_in_streaming_api: false,
      dsl_query: query,
      version: "2.18",
    },
    query_str: query,
    _request_id: requestId,
  });
}

function callPerplexity(query: string, model: string): string {
  const modelPreference = MODEL_PREFERENCE_MAP[model] ?? "turbo";
  const body = buildRequestBody(query, modelPreference);
  const requestId = randomUUID();

  // Use curl to bypass Cloudflare TLS fingerprint
  const escapedBody = body.replace(/'/g, "'\\''");

  const raw = execSync(
    `curl -sN -X POST "${ENDPOINT}" \
      --tlsv1.3 \
      -H "accept: text/event-stream" \
      -H "accept-language: en-US,en;q=0.9" \
      -H "content-type: application/json" \
      -H "origin: https://www.perplexity.ai" \
      -H "referer: https://www.perplexity.ai/" \
      -H "user-agent: ${CHROME_UA}" \
      -H "x-perplexity-request-reason: perplexity-query-state-provider" \
      -H "x-request-id: ${requestId}" \
      --max-time 60 \
      -d '${escapedBody}'`,
    { maxBuffer: 20 * 1024 * 1024 },
  ).toString();

  return raw;
}

// ── Public streaming API ──────────────────────────────────────────────────────

export async function* perplexityStream(
  messages: ChatMessage[],
  model = "perplexity",
): AsyncGenerator<string> {
  const query = buildQuery(messages);
  if (!query) return;

  logger.debug({ model, queryLength: query.length }, "perplexity: sending request");

  let raw: string;
  try {
    raw = callPerplexity(query, model);
  } catch (err) {
    logger.error({ err: String(err) }, "perplexity: curl failed");
    throw new Error("Perplexity request failed");
  }

  const content = parsePerplexitySSE(raw);
  if (!content) {
    // Detect rate-limit pattern: valid SSE headers but no text blocks delivered
    const isRateLimit = raw.includes("backend_uuid") && !raw.includes("ask_text_0_markdown");
    const reason = isRateLimit
      ? "Perplexity IP rate limit reached — wait 1-2 min (light) or until 00:00 UTC (daily reset)"
      : "Perplexity returned empty response";
    logger.warn({ rawSnippet: raw.slice(0, 300), isRateLimit }, `perplexity: ${reason}`);
    throw new Error(reason);
  }

  // Yield in ~word-sized chunks to simulate streaming
  const words = content.match(/\S+\s*/g) ?? [content];
  for (const word of words) {
    yield word;
  }
}

// ── Non-streaming ─────────────────────────────────────────────────────────────

export async function perplexityChat(
  messages: ChatMessage[],
  model = "perplexity",
): Promise<{ content: string; inputTokens: number; outputTokens: number }> {
  let content = "";
  for await (const token of perplexityStream(messages, model)) {
    content += token;
  }
  const inputEst  = Math.round(messages.map(m => m.content).join(" ").length / 4);
  const outputEst = Math.round(content.length / 4);
  return { content: content.trim(), inputTokens: inputEst, outputTokens: outputEst };
}
