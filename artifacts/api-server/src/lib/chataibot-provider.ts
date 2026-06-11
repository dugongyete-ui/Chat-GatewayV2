import { execSync } from "child_process";
import { logger } from "./logger";

export interface ChatMessage { role: string; content: string; }

const CHAT_EP = "https://chataibot.pro/api/promo-chat/messages";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";

export const CHATAIBOT_MODELS = [
  { id: "chataibot-claude-haiku",  object: "model", created: 1748736000, owned_by: "anthropic" },
  { id: "chataibot-claude-sonnet", object: "model", created: 1748736000, owned_by: "anthropic" },
  { id: "chataibot-deepseek-r1",   object: "model", created: 1748736000, owned_by: "deepseek"  },
  { id: "chataibot-gpt4-nano",     object: "model", created: 1748736000, owned_by: "openai"    },
];

const MODEL_MAP: Record<string, string> = {
  "chataibot-claude-haiku":  "claude-haiku-4-5",
  "chataibot-claude-sonnet": "claude-sonnet-4-5",
  "chataibot-deepseek-r1":   "deepseek-r1",
  "chataibot-gpt4-nano":     "gpt-4.1-nano",
};

export function isChataibot(model: string): boolean {
  return model in MODEL_MAP;
}

export async function chataibotFetch(
  messages: ChatMessage[],
  model: string,
): Promise<string> {
  const upstreamModel = MODEL_MAP[model] ?? "claude-haiku-4-5";
  const payloadRaw = JSON.stringify({
    messages: messages.map(m => ({ role: m.role, content: m.content })),
    model: upstreamModel,
  });
  const payload = payloadRaw.replace(/'/g, "'\\''");

  let raw: string;
  try {
    raw = execSync(
      `curl -sX POST "${CHAT_EP}" ` +
      `-H "Content-Type: application/json" ` +
      `-H "Accept: application/json" ` +
      `-H "User-Agent: ${UA}" ` +
      `-H "Referer: https://chataibot.pro/app/free-chat?variant=new" ` +
      `-H "Origin: https://chataibot.pro" ` +
      `-H "x-distribution-channel: web" ` +
      `--max-time 60 ` +
      `-d '${payload}'`,
      { maxBuffer: 10 * 1024 * 1024 },
    ).toString().trim();
  } catch (err: unknown) {
    logger.warn({ err }, "chataibot: curl error");
    throw new Error("ChatAIBot request failed");
  }

  let data: { answer?: string; message?: string; type?: string };
  try {
    data = JSON.parse(raw);
  } catch {
    logger.warn({ raw: raw.slice(0, 200) }, "chataibot: invalid JSON response");
    throw new Error("ChatAIBot returned non-JSON response");
  }

  if (data.type === "PromoChatLimitReachedError") {
    throw new Error("ChatAIBot rate limit reached (5 req/IP). Try again later.");
  }

  const content = (data.answer ?? "").trim();
  if (!content) {
    logger.warn({ raw: raw.slice(0, 300) }, "chataibot: empty answer field");
    throw new Error("ChatAIBot returned empty response");
  }

  return content;
}

export async function chataibot(
  messages: ChatMessage[],
  model = "chataibot-claude-haiku",
): Promise<{ content: string; inputTokens: number; outputTokens: number }> {
  const content = await chataibotFetch(messages, model);
  const inputEst = Math.round(messages.map(m => m.content).join("").length / 4);
  const outputEst = Math.round(content.length / 4);
  return { content, inputTokens: inputEst, outputTokens: outputEst };
}

export async function* chataibotStream(
  messages: ChatMessage[],
  model = "chataibot-claude-haiku",
): AsyncGenerator<string> {
  const content = await chataibotFetch(messages, model);
  if (content) yield content;
}
