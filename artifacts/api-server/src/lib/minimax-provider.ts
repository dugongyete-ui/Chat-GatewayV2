import { createHash } from "crypto";
import { execSync } from "child_process";
import { logger } from "./logger";

export interface ChatMessage { role: string; content: string; }

const BASE_SESSION = "https://agent.minimax.io";
const BASE_STREAM  = "https://agent-stream.minimax.io";
const ARCHON = "/archon/api/v1";
const SIGN_SALT = "I*7Cf%WZ#S&%1RlZJ&C2";

// Default agent ID (Mavis — the built-in MiniMax assistant)
const DEFAULT_AGENT = "405559239626914";

// Fixed device fingerprint validated by server
const DEVICE = {
  uuid: "c451c3b9-3de8-4545-9ba9-72bbb241054f",
  device_id: "99665887",
  user_id: "518879131345821696",
  timezone_offset: "25200",
  browser_language: "id-ID",
};

interface ModelInfo { model_id: string; variant?: string; }

export const MINIMAX_MODELS: Record<string, ModelInfo> = {
  "minimax-m3":             { model_id: "MiniMax-M3",             variant: "thinking" },
  "minimax-m3-thinking":    { model_id: "MiniMax-M3",             variant: "thinking" },
  "minimax-m2.7":           { model_id: "MiniMax-M2.7",           variant: "" },
  "minimax-m2.7-highspeed": { model_id: "MiniMax-M2.7-highspeed", variant: "" },
};

export function isMinimaxModel(model: string): boolean {
  return model.toLowerCase().startsWith("minimax-");
}

function md5(s: string): string {
  return createHash("md5").update(s).digest("hex");
}

function resolveModel(model: string): ModelInfo {
  return MINIMAX_MODELS[model.toLowerCase()] ?? { model_id: "MiniMax-M3", variant: "thinking" };
}

function buildQS(tsSec: number, token: string): string {
  return new URLSearchParams([
    ["device_platform", "web"],
    ["biz_id", "3"],
    ["app_id", "3001"],
    ["version_code", "22201"],
    ["unix", String(tsSec * 1000)],
    ["timezone_offset", DEVICE.timezone_offset],
    ["sys_language", "en"],
    ["lang", "en"],
    ["uuid", DEVICE.uuid],
    ["device_id", DEVICE.device_id],
    ["os_name", "Linux"],
    ["browser_name", "Chrome"],
    ["device_memory", "8"],
    ["cpu_core_num", "8"],
    ["browser_language", DEVICE.browser_language],
    ["browser_platform", "Linux armv81"],
    ["user_id", DEVICE.user_id],
    ["screen_width", "599"],
    ["screen_height", "1332"],
    ["token", token],
    ["client", "web"],
    ["region", "en"],
  ]).toString();
}

function commonHeaders(tsSec: number, body: string, token: string, accept = "application/json"): string {
  const sig = md5(`${tsSec}${SIGN_SALT}${body}`);
  return [
    `-H "token: ${token}"`,
    `-H "x-signature: ${sig}"`,
    `-H "x-timestamp: ${tsSec}"`,
    `-H "Content-Type: application/json"`,
    `-H "Accept: ${accept}"`,
    `-H "Origin: ${BASE_SESSION}"`,
    `-H "Referer: ${BASE_SESSION}/"`,
    `-H "User-Agent: Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36"`,
  ].join(" ");
}

function buildPrompt(messages: ChatMessage[]): string {
  if (messages.length === 1) return messages[0].content;
  return messages
    .map(m => {
      const role =
        m.role === "assistant" ? "Assistant" :
        m.role === "system"    ? "System"    :
        m.role === "tool"      ? "Tool Result" :
                                  "User";
      return `${role}: ${m.content}`;
    })
    .join("\n\n");
}

function getToken(): string {
  const t = process.env.MINIMAX_TOKEN;
  if (!t) throw new Error("MINIMAX_TOKEN env var not set");
  return t;
}

function getAgentName(): string {
  return process.env.MINIMAX_AGENT_NAME ?? DEFAULT_AGENT;
}

/** Create a fresh session and return its ID. */
function createSession(token: string): string {
  const tsSec = Math.floor(Date.now() / 1000);
  const body = "{}";
  const agentName = getAgentName();
  const qs = buildQS(tsSec, token);
  const url = `${BASE_SESSION}${ARCHON}/agent/${agentName}/session?${qs}`;
  const headers = commonHeaders(tsSec, body, token);

  const raw = execSync(
    `curl -s -X POST "${url}" ${headers} --max-time 15 -d '${body}'`,
    { maxBuffer: 1 * 1024 * 1024 },
  ).toString();

  try {
    const data = JSON.parse(raw) as { session_id?: string; base_resp?: { status_code: number } };
    if (data.base_resp?.status_code !== 0 || !data.session_id) {
      throw new Error(`createSession failed: ${raw.slice(0, 200)}`);
    }
    return data.session_id;
  } catch (e) {
    throw new Error(`MiniMax createSession parse error: ${raw.slice(0, 200)}`);
  }
}

/** Send a message to a session and return the full SSE response. */
function sendMessage(sessionId: string, bodyStr: string, token: string): string {
  const tsSec = Math.floor(Date.now() / 1000);
  const qs = buildQS(tsSec, token);
  const url = `${BASE_STREAM}${ARCHON}/session/${sessionId}/message?${qs}`;
  const headers = commonHeaders(tsSec, bodyStr, token, "text/event-stream");
  const safeBody = bodyStr.replace(/'/g, "'\\''");

  return execSync(
    `curl -sN -X POST "${url}" ${headers} --max-time 60 -d '${safeBody}'`,
    { maxBuffer: 20 * 1024 * 1024 },
  ).toString();
}

interface MinimaxChunk {
  type: number;
  agent_message_chunk?: {
    msg_content?: string;
    thinking_content?: string;
    finish?: boolean;
    usage?: { input_tokens: number; output_tokens: number };
  };
  agent_message?: {
    role?: string;
    msg_content?: string;
    usage?: { input_tokens: number; output_tokens: number };
  };
}

function parseSSE(raw: string): { content: string; inputTokens: number; outputTokens: number } {
  let content = "";
  let inputTokens = 0;
  let outputTokens = 0;

  for (const line of raw.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data) continue;
    try {
      const chunk = JSON.parse(data) as MinimaxChunk;
      if (chunk.type === 6 && chunk.agent_message_chunk?.msg_content) {
        content += chunk.agent_message_chunk.msg_content;
      }
      if (chunk.type === 2 && chunk.agent_message?.role === "assistant" && chunk.agent_message.usage) {
        inputTokens = chunk.agent_message.usage.input_tokens ?? 0;
        outputTokens = chunk.agent_message.usage.output_tokens ?? 0;
        if (!content && chunk.agent_message.msg_content) {
          content = chunk.agent_message.msg_content;
        }
      }
    } catch { /* skip */ }
  }

  return { content, inputTokens, outputTokens };
}

export async function minimaxChat(
  messages: ChatMessage[],
  model = "minimax-m3",
): Promise<{ content: string; inputTokens: number; outputTokens: number }> {
  const token = getToken();

  // Create a fresh session per request (like Qwen creates a new chat)
  const sessionId = createSession(token);
  logger.info({ sessionId, model }, "minimax: created fresh session");

  const prompt = buildPrompt(messages);
  const minimaxModel = resolveModel(model);
  const bodyStr = JSON.stringify({ content: prompt, model: minimaxModel });

  const raw = sendMessage(sessionId, bodyStr, token);
  const result = parseSSE(raw);

  if (!result.content) {
    logger.warn({ sessionId, rawSnippet: raw.slice(0, 300) }, "minimax: empty content");
    throw new Error("No content in MiniMax response");
  }

  logger.info({ sessionId, inputTokens: result.inputTokens, outputTokens: result.outputTokens }, "minimax: done");
  return result;
}

export async function* minimaxStream(
  messages: ChatMessage[],
  model = "minimax-m3",
): AsyncGenerator<string> {
  const result = await minimaxChat(messages, model);
  if (result.content) yield result.content;
}
