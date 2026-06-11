import { logger } from "./logger";

export interface ChatMessage { role: string; content: string; }

const BASE_URL = "https://www.kimi.com";
const CHAT_PATH = "/apiv2/kimi.gateway.chat.v1.ChatService/Chat";

function encodeConnectFrame(data: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(data), "utf-8");
  const frame = Buffer.allocUnsafe(5 + json.length);
  frame.writeUInt8(0x00, 0);
  frame.writeUInt32BE(json.length, 1);
  json.copy(frame, 5);
  return frame;
}

function parseJwtField(token: string): { userId: string; deviceId: string; sessionId: string } {
  try {
    const raw = token.split(".")[1];
    const p = JSON.parse(Buffer.from(raw, "base64").toString("utf-8"));
    return { userId: p.sub ?? "", deviceId: p.device_id ?? "", sessionId: p.ssid ?? "" };
  } catch {
    return { userId: "", deviceId: "", sessionId: "" };
  }
}

function buildPrompt(messages: ChatMessage[]): string {
  if (messages.length === 1) return messages[0].content;
  return messages
    .map(m => {
      const role =
        m.role === "assistant" ? "assistant" :
        m.role === "system"    ? "system"    :
        m.role === "tool"      ? "tool"      :
        "user";
      return `${role}:${m.content}`;
    })
    .join("\n");
}

function kimiHeaders(token: string): Record<string, string> {
  const { userId, deviceId, sessionId } = parseJwtField(token);
  return {
    "Authorization": `Bearer ${token}`,
    "Content-Type": "application/connect+json",
    "Connect-Protocol-Version": "1",
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "X-Language": "en-US",
    "X-Msh-Platform": "web",
    "X-Msh-Version": "1.0.0",
    "R-Timezone": "Asia/Jakarta",
    "User-Agent": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 Chrome/137.0.0.0 Mobile Safari/537.36",
    "Origin": BASE_URL,
    "Referer": `${BASE_URL}/`,
    ...(deviceId ? { "X-Msh-Device-Id": deviceId } : {}),
    ...(userId   ? { "X-Traffic-Id": userId }       : {}),
    ...(sessionId ? { "X-Msh-Session-Id": sessionId } : {}),
  };
}

function resolveScenario(model: string): string {
  if (model.includes("search"))   return "SCENARIO_SEARCH";
  if (model.includes("research")) return "SCENARIO_RESEARCH";
  if (model.includes("k1"))       return "SCENARIO_K1";
  return "SCENARIO_K2";
}

function resolveToken(): string {
  const t = process.env.KIMI_TOKEN ?? "";
  if (!t) throw new Error("KIMI_TOKEN env var is not set");
  return t;
}

async function fetchKimiStream(
  prompt: string,
  model: string,
  token: string,
): Promise<Response> {
  const scenario = resolveScenario(model);
  const body = {
    scenario,
    message: {
      role: "user",
      blocks: [{ message_id: "", text: { content: prompt } }],
      scenario,
    },
    options: { thinking: model.includes("thinking") },
  };

  const frame = encodeConnectFrame(body);

  const res = await fetch(`${BASE_URL}${CHAT_PATH}`, {
    method: "POST",
    headers: kimiHeaders(token),
    body: frame,
  });

  if (!res.ok || !res.body) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Kimi HTTP ${res.status}: ${errText.slice(0, 200)}`);
  }
  return res;
}

/**
 * Strip Kimi-internal XML tags that appear in output when search/research
 * scenarios are used but execute server-side (not visible via Connect RPC).
 * e.g. <search>...</search>, <search_quality_reflection>...</search_quality_reflection>
 */
export function cleanKimiOutput(text: string): string {
  return text
    // Block tags (multi-line)
    .replace(/<search>[\s\S]*?<\/search>/gi, "")
    .replace(/<search_quality_reflection>[\s\S]*?<\/search_quality_reflection>/gi, "")
    .replace(/<search_quality_score>[\s\S]*?<\/search_quality_score>/gi, "")
    .replace(/<references>[\s\S]*?<\/references>/gi, "")
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "")
    .replace(/<tool_response>[\s\S]*?<\/tool_response>/gi, "")
    // Inline tags Kimi emits for search/tool (various malformed formats)
    // e.g. <<tool>web_search</tool>, <<query>..., <query>...
    .replace(/<<tool>[^<]*<\/tool>\s*/gi, "")
    .replace(/<<query>[^\n]*\n?/gi, "")
    .replace(/<query>[^\n]*\n?/gi, "")
    .replace(/<tool>[^<]*<\/tool>\s*/gi, "")
    // Strip any remaining lone XML-style internal tags on their own line
    .replace(/^<\/?(?:search|query|tool|references|search_quality\w*)[^>]*>\s*$/gim, "")
    // Clean up excess blank lines left behind
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+/, "")
    .trim();
}

// ── Streaming — proper AsyncGenerator<string>, yields tokens as they arrive ──
export async function* kimiStream(
  messages: ChatMessage[],
  model = "kimi-k2",
): AsyncGenerator<string> {
  const token = resolveToken();
  const prompt = buildPrompt(messages);
  const res = await fetchKimiStream(prompt, model, token);

  const reader = res.body!.getReader();
  let buf = Buffer.alloc(0);

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf = Buffer.concat([buf, Buffer.from(value)]);

    let offset = 0;
    while (offset + 5 <= buf.length) {
      const length = buf.readUInt32BE(offset + 1);
      if (offset + 5 + length > buf.length) break;
      const payload = buf.slice(offset + 5, offset + 5 + length);
      offset += 5 + length;

      try {
        const msg = JSON.parse(payload.toString("utf-8")) as {
          op?: string;
          block?: { text?: { content?: string } };
          done?: unknown;
          error?: { code?: string; details?: Array<{ debug?: { reason?: string } }> };
        };
        if (msg.error) {
          const reason = msg.error.details?.[0]?.debug?.reason ?? msg.error.code ?? "unknown";
          throw new Error(`Kimi API error: ${reason}`);
        }
        const text = msg.block?.text?.content;
        if (text && (msg.op === "set" || msg.op === "append")) {
          yield text;
        }
        if (msg.done !== undefined) {
          buf = buf.slice(offset);
          return;
        }
      } catch (e: unknown) {
        const err = e as Error;
        if (err.message?.startsWith("Kimi API error")) throw e;
      }
    }
    buf = buf.slice(offset);
  }
}

// ── Non-streaming — uses kimiStream internally ────────────────────────────────
export async function kimiChat(
  messages: ChatMessage[],
  model = "kimi-k2",
): Promise<{ content: string; inputTokens: number; outputTokens: number }> {
  let content = "";
  for await (const token of kimiStream(messages, model)) {
    content += token;
  }
  const trimmed = cleanKimiOutput(content);
  const inputEst = Math.round(messages.map(m => m.content).join("").length / 4);
  const outputEst = Math.round(trimmed.length / 4);
  logger.info({ model, chars: trimmed.length }, "kimi: chat complete");
  return { content: trimmed, inputTokens: inputEst, outputTokens: outputEst };
}

export const KIMI_MODELS = [
  { id: "kimi-k2",       object: "model", created: 1748476800, owned_by: "moonshot" },
  { id: "kimi-search",   object: "model", created: 1748476800, owned_by: "moonshot" },
  { id: "kimi-research", object: "model", created: 1748476800, owned_by: "moonshot" },
];

export function isKimiModel(model: string): boolean {
  return model.startsWith("kimi-") || model === "kimi";
}
