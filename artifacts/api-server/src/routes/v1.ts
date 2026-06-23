import { Router } from "express";
import { randomUUID, createHmac } from "crypto";
import { execSync, spawn } from "child_process";
import { join } from "path";
import { requireApiKey } from "../middleware/requireApiKey";
import { logger } from "../lib/logger";
import { recordRequest } from "../lib/stats";
import { getPooledMidtoken } from "../lib/umid-pool";
import { ariaChat, ariaStream, isAriaModel, ARIA_MODELS } from "../lib/aria-provider";
import { yqcloudChat, yqcloudStream, isYqcloudModel, YQCLOUD_MODELS } from "../lib/yqcloud-provider";
import { cohereChat, cohereStream, isCohereModel, resolveCohereModel, COHERE_MODELS } from "../lib/cohere-provider";
import { perplexityChat, perplexityStream, isPerplexityModel, PERPLEXITY_MODELS } from "../lib/perplexity-provider";
import { gptfreeChat, gptfreeStream, isGptfreeModel, GPTFREE_MODELS } from "../lib/gptfree-provider";
import { algochatChat, algochatStream, isAlgochatModel, ALGOCHAT_MODELS } from "../lib/algochat-provider";
import { chataibot, chataibotStream, isChataibot, CHATAIBOT_MODELS } from "../lib/chataibot-provider";
import { kimiChat, kimiStream, isKimiModel, KIMI_MODELS, cleanKimiOutput } from "../lib/kimi-provider";
import { minimaxChat, minimaxStream, isMinimaxModel, MINIMAX_MODELS } from "../lib/minimax-provider";
import { deepseekChat, deepseekStream, isDeepseekModel, DEEPSEEK_MODELS } from "../lib/deepseek-provider";

const router = Router();

const QWEN_ORIGIN = "https://chat.qwen.ai";
const QWEN_BASE = `${QWEN_ORIGIN}/api/v2`;

const QWEN_CFFI_PY = join(__dirname, "qwen_cffi.py");

function qwenPyCreate(token: string, model: string, midtoken?: string): string {
  const mid = midtoken ?? "";
  const out = execSync(
    `python3 "${QWEN_CFFI_PY}" create "${token}" "${model}" "${mid}"`,
    { timeout: 15000, encoding: "utf8" },
  );
  checkQwenWaf(out);
  const data = JSON.parse(out) as { success: boolean; data?: { id: string } };
  if (!data.success || !data.data?.id)
    throw new Error(`qwen: createChat failed: ${out.slice(0, 200)}`);
  return data.data.id;
}

function qwenPyBody(token: string, chatId: string, payload: unknown, midtoken?: string): Promise<string> {
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64");
  const args = [QWEN_CFFI_PY, "chat", token, chatId, payloadB64];
  if (midtoken) args.push(midtoken);
  return new Promise<string>((resolve, reject) => {
    const py = spawn("python3", args);
    const chunks: Buffer[] = [];
    py.stdout.on("data", (d: Buffer) => chunks.push(d));
    py.stderr.on("data", (d: Buffer) => logger.warn({ err: d.toString().trim() }, "qwen-cffi: stderr"));
    const timer = setTimeout(() => { py.kill(); reject(new Error("qwen-cffi: timeout")); }, 90000);
    py.on("close", (code) => {
      clearTimeout(timer);
      // exit 2 = risk-control; exit 3 = WAF blocked — Python already wrote error SSE to stdout.
      if (code !== 0 && code !== 2 && code !== 3) reject(new Error(`qwen-cffi: exit ${code}`));
      else resolve(Buffer.concat(chunks).toString("utf8"));
    });
    py.on("error", reject);
  });
}

async function getMidtoken(): Promise<string> {
  if (getQwenSessionToken()) return "";
  return getPooledMidtoken();
}

function getQwenSessionToken(): string | undefined {
  return process.env["QWEN_SESSION_TOKEN"] || undefined;
}

function qwenHeaders(midtoken: string): Record<string, string> {
  const sessionToken = getQwenSessionToken();
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
    ...(sessionToken ? { "Authorization": `Bearer ${sessionToken}` } : {}),
  };
}

function checkQwenWaf(text: string): void {
  if (text.trimStart().toLowerCase().startsWith("<!doctype")) {
    throw new Error(
      "Qwen API diblokir WAF Aliyun dari IP ini. " +
      "Set env var QWEN_SESSION_TOKEN dengan Bearer token dari akun Qwen Anda " +
      "(buka chat.qwen.ai → DevTools → Network → salin header Authorization)."
    );
  }
}

function qwenCompletionsUrl(chatId: string): string {
  return `${QWEN_BASE}/chat/completions?chat_id=${chatId}`;
}

async function createQwenChat(_headers: Record<string, string>, model: string, midtoken?: string): Promise<string> {
  const sessionToken = getQwenSessionToken();
  if (sessionToken) return qwenPyCreate(sessionToken, model);
  return qwenPyCreate("", model, midtoken);
}

function parseQwenSSE(body: string): { content: string; inputTokens: number; outputTokens: number; upstreamError?: { message: string; code?: string } } {
  let answer = ""; let fallback = "";
  let inputTokens = 0; let outputTokens = 0;
  for (const line of body.split("\n")) {
    if (!line.startsWith("data:")) continue;
    try {
      const chunk = JSON.parse(line.slice(5).trim()) as {
        error?: { message?: string; code?: string };
        choices?: Array<{ delta?: { content?: string; extra?: { output_schema?: string } } }>;
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      // Upstream error emitted by Python risk-control handler or Qwen itself
      if (chunk.error) {
        return { content: "", inputTokens: 0, outputTokens: 0, upstreamError: {
          message: chunk.error.message ?? "Upstream error",
          code: chunk.error.code,
        }};
      }
      if (chunk.usage) {
        inputTokens = chunk.usage.input_tokens ?? 0;
        outputTokens = chunk.usage.output_tokens ?? 0;
      }
      const delta = chunk.choices?.[0]?.delta;
      const content = delta?.content ?? "";
      if (!content) continue;
      if ((delta?.extra?.output_schema ?? "") === "answer") { answer += content; } else { fallback += content; }
    } catch { /* skip */ }
  }
  return { content: answer || fallback, inputTokens, outputTokens };
}

// ── Tool-calling types ──────────────────────────────────────────────────────

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
  // Strip markdown fences anywhere in the text
  const cleaned = raw.trim().replace(/```(?:json)?/gi, "").trim();

  const allCalls: DetectedToolCall[] = [];
  let callIndex = 0;

  // Walk the string finding every top-level JSON object that contains "tool_calls"
  let searchFrom = 0;
  while (searchFrom < cleaned.length) {
    const blockStart = cleaned.indexOf("{", searchFrom);
    if (blockStart === -1) break;

    // Match balanced braces to find the end of this JSON object
    let depth = 0;
    let blockEnd = -1;
    for (let i = blockStart; i < cleaned.length; i++) {
      if (cleaned[i] === "{") depth++;
      else if (cleaned[i] === "}") {
        depth--;
        if (depth === 0) { blockEnd = i; break; }
      }
    }

    if (blockEnd === -1) break;

    const candidate = cleaned.slice(blockStart, blockEnd + 1);
    if (candidate.includes('"tool_calls"')) {
      try {
        const parsed = JSON.parse(candidate) as { tool_calls?: Array<{ name: string; arguments: unknown }> };
        if (Array.isArray(parsed.tool_calls) && parsed.tool_calls.length > 0) {
          for (const tc of parsed.tool_calls) {
            if (!tc.name) continue;
            allCalls.push({
              id: `call_${randomUUID().replace(/-/g, "").slice(0, 20)}_${callIndex++}`,
              type: "function" as const,
              function: {
                name: tc.name,
                arguments: typeof tc.arguments === "string" ? tc.arguments : JSON.stringify(tc.arguments ?? {}),
              },
            });
          }
        }
      } catch { /* skip malformed block, continue searching */ }
    }

    searchFrom = blockEnd + 1;
  }

  return allCalls.length > 0 ? allCalls : null;
}

/** Returns true if the string looks like a raw tool-call JSON that failed to parse. */
function looksLikeToolCallJson(text: string): boolean {
  return text.includes('"tool_calls"') && text.includes('"name"') && text.includes('"arguments"');
}

// ── Vision / multipart content types ─────────────────────────────────────────

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

// ── Vision / image upload types & helpers ─────────────────────────────────────

interface QwenFileDescriptor {
  url: string;
  type: string;
  file_type: string;
  file_class: string;
  showType: string;
  status: string;
  name: string;
  id: string;
}

/** Fetch the acw_tc anti-bot cookie from chat.qwen.ai (needed for file uploads). */
async function getQwenCookies(midtoken: string): Promise<string> {
  const res = await fetch(QWEN_ORIGIN, {
    headers: {
      "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/138.0.0.0 Safari/537.36",
      "bx-umidtoken": midtoken,
    },
    redirect: "follow",
  });
  const setCookie = res.headers.get("set-cookie") || "";
  return setCookie.split(/,(?=[^ ])/).map((c: string) => c.split(";")[0].trim()).join("; ");
}

/** Detect MIME type from a URL or data URI string. */
function detectMimeType(url: string): string {
  if (url.startsWith("data:")) {
    const m = url.match(/^data:([^;,]+)/);
    return m?.[1] || "image/jpeg";
  }
  const lower = url.toLowerCase();
  if (lower.includes(".png")) return "image/png";
  if (lower.includes(".gif")) return "image/gif";
  if (lower.includes(".webp")) return "image/webp";
  return "image/jpeg";
}

/** Fetch image bytes using curl (bypasses hotlink protection, TLS fingerprint issues). */
function fetchImageBytesViaCurl(url: string): { buf: Buffer; mimeType: string; filename: string } {
  const result = execSync(
    `curl -sL --max-time 20 --max-filesize 20971520 \
      -H "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36" \
      -H "Accept: image/avif,image/webp,image/apng,image/*,*/*;q=0.8" \
      -H "Accept-Language: en-US,en;q=0.9" \
      -H "Referer: https://www.google.com/" \
      --tlsv1.2 \
      -w "\\n__CONTENT_TYPE__:%{content_type}__STATUS__:%{http_code}" \
      "${url.replace(/"/g, '\\"')}"`,
    { maxBuffer: 25 * 1024 * 1024, encoding: "buffer" },
  ) as unknown as Buffer;

  const raw = result.toString("latin1");
  const metaMatch = raw.match(/\n__CONTENT_TYPE__:([^_]*)__STATUS__:(\d+)$/);
  if (!metaMatch) throw new Error("curl: failed to parse metadata");

  const status = Number(metaMatch[2]);
  if (status < 200 || status >= 300) throw new Error(`curl: HTTP ${status} for ${url}`);

  const metaSuffix = `\n__CONTENT_TYPE__:${metaMatch[1]}__STATUS__:${metaMatch[2]}`;
  const bodyEnd = result.length - Buffer.byteLength(metaSuffix, "latin1");
  const buf = result.slice(0, bodyEnd);

  const ctRaw = metaMatch[1].split(";")[0].trim();
  const mimeType = ctRaw.startsWith("image/") ? ctRaw : detectMimeType(url);
  const ext = mimeType.split("/")[1]?.replace("jpeg", "jpg") || "jpg";
  const rawName = url.split("/").pop()?.split("?")[0] || `image.${ext}`;
  const filename = rawName.includes(".") ? rawName : `${rawName}.${ext}`;
  return { buf, mimeType, filename };
}

/** Fetch image bytes and MIME type from a URL or data URI. Falls back to curl for hotlink-protected URLs. */
async function fetchImageBytes(url: string): Promise<{ buf: Buffer; mimeType: string; filename: string }> {
  if (url.startsWith("data:")) {
    const m = url.match(/^data:([^;,]+);base64,(.+)$/);
    if (!m) throw new Error("Invalid data URI");
    const mimeType = m[1];
    const buf = Buffer.from(m[2], "base64");
    const ext = mimeType.split("/")[1]?.replace("jpeg", "jpg") || "jpg";
    return { buf, mimeType, filename: `image.${ext}` };
  }

  // Try Node.js fetch first
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
        "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        "Referer": "https://www.google.com/",
      },
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) {
      const buf = Buffer.from(await res.arrayBuffer());
      const ct = res.headers.get("content-type")?.split(";")[0].trim() || detectMimeType(url);
      const mimeType = ct.startsWith("image/") ? ct : detectMimeType(url);
      const ext = mimeType.split("/")[1]?.replace("jpeg", "jpg") || "jpg";
      const rawName = url.split("/").pop()?.split("?")[0] || `image.${ext}`;
      const filename = rawName.includes(".") ? rawName : `${rawName}.${ext}`;
      return { buf, mimeType, filename };
    }
    logger.debug({ status: res.status, url: url.slice(0, 80) }, "vision: fetch failed, retrying with curl");
  } catch (err) {
    logger.debug({ err: String(err), url: url.slice(0, 80) }, "vision: fetch error, retrying with curl");
  }

  // Fallback to curl (handles TLS fingerprint, hotlink protection, Cloudflare, etc.)
  return fetchImageBytesViaCurl(url);
}

/**
 * Upload a single image (URL or base64 data URI) to Qwen OSS and return
 * a QwenFileDescriptor ready for use in the files[] array.
 *
 * Flow: getstsToken → OSS PUT (HMAC-SHA1) → /files/parse → descriptor
 */
async function uploadImageToQwen(
  imageUrl: string,
  uploadHeaders: Record<string, string>,
): Promise<QwenFileDescriptor> {
  const { buf, mimeType, filename } = await fetchImageBytes(imageUrl);

  const stsRes = await fetch(`${QWEN_BASE}/files/getstsToken`, {
    method: "POST",
    headers: uploadHeaders,
    body: JSON.stringify({ filename, filesize: String(buf.length), filetype: "image" }),
  });
  const stsData = (await stsRes.json()) as { data: { file_id: string; file_url: string; file_path: string; bucketname: string; endpoint: string; access_key_id: string; access_key_secret: string; security_token: string } };
  const sts = stsData.data;

  const date = new Date().toUTCString();
  const stringToSign = `PUT\n\n${mimeType}\n${date}\nx-oss-security-token:${sts.security_token}\n/${sts.bucketname}/${sts.file_path}`;
  const sig = createHmac("sha1", sts.access_key_secret).update(stringToSign).digest("base64");

  const putRes = await fetch(`https://${sts.bucketname}.${sts.endpoint}/${sts.file_path}`, {
    method: "PUT",
    headers: {
      "Content-Type": mimeType,
      "Date": date,
      "Authorization": `OSS ${sts.access_key_id}:${sig}`,
      "x-oss-security-token": sts.security_token,
    },
    body: buf,
  });
  if (!putRes.ok) {
    const errText = await putRes.text().catch(() => "");
    throw new Error(`OSS PUT failed: ${putRes.status} ${errText.slice(0, 200)}`);
  }

  await fetch(`${QWEN_BASE}/files/parse`, {
    method: "POST",
    headers: uploadHeaders,
    body: JSON.stringify({ file_id: sts.file_id }),
  });

  return {
    url: sts.file_url,
    type: "image",
    file_type: mimeType,
    file_class: "vision",
    showType: "image",
    status: "uploaded",
    name: filename,
    id: sts.file_id,
  };
}

/**
 * Upload all image URLs to Qwen CDN (parallel). Returns QwenFileDescriptors.
 * Failures are logged and skipped so a bad image doesn't kill the whole request.
 */
async function resolveImageUrls(
  imageUrls: string[],
  uploadHeaders: Record<string, string>,
): Promise<QwenFileDescriptor[]> {
  const results = await Promise.all(
    imageUrls.map(u =>
      uploadImageToQwen(u, uploadHeaders).catch(err => {
        logger.warn({ err: String(err), url: u.slice(0, 80) }, "vision: image upload failed, skipping");
        return null;
      }),
    ),
  );
  return results.filter((r): r is QwenFileDescriptor => r !== null);
}

/**
 * Analyze all images in a message using Qwen vision and return a combined
 * text description. Used to give vision capability to text-only providers.
 */
async function describeImagesWithQwen(
  imageUrls: string[],
  userText: string,
): Promise<string> {
  try {
    const midtoken = await getMidtoken();
    const headers = qwenHeaders(midtoken);
    const cookie = await getQwenCookies(midtoken);
    const uploadHeaders = { ...headers, Cookie: cookie };

    const files = await resolveImageUrls(imageUrls, uploadHeaders);
    if (files.length === 0) return userText;

    const chatId = await createQwenChat(headers, "qwen3.7-max", midtoken);
    const prompt = userText
      ? `${userText}\n\n(Analyze the attached image(s) carefully and answer based on their content.)`
      : "Describe the attached image(s) in full detail.";

    const r = await fetch(qwenCompletionsUrl(chatId), {
      method: "POST",
      headers,
      body: JSON.stringify({
        stream: true, incremental_output: true, chat_id: chatId, chat_mode: "normal",
        model: "qwen3.7-max",
        temperature: 0.7,
        parent_id: null,
        messages: [{
          fid: randomUUID(), parentId: null, childrenIds: [], role: "user",
          content: prompt, user_action: "chat",
          files,
          models: ["qwen3.7-max"],
          chat_type: "t2t",
          feature_config: { thinking_enabled: false, output_schema: "phase", thinking_budget: 81920 },
          sub_chat_type: "t2t",
        }],
      }),
    });
    const body = await r.text();
    const { content } = parseQwenSSE(body);
    return content || userText;
  } catch (err) {
    logger.warn({ err: String(err) }, "vision-fallback: Qwen describe failed, using text-only");
    return userText;
  }
}

/**
 * For text-only providers: replace image_url content parts with Qwen-generated
 * text descriptions so the provider still "sees" the image contextually.
 */
async function flattenVisionMessages(messages: Message[]): Promise<Message[]> {
  const result: Message[] = [];
  for (const msg of messages) {
    const images = getMessageImages(msg.content);
    if (images.length === 0) {
      result.push({
        ...msg,
        content: typeof msg.content === "string" ? msg.content : getMessageText(msg.content),
      });
      continue;
    }
    const text = getMessageText(msg.content);
    const described = await describeImagesWithQwen(images, text);
    result.push({ ...msg, content: described });
  }
  return result;
}

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
          id: tc.id,
          name: tc.function.name,
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

// ── Parameter helpers ────────────────────────────────────────────────────────

/** Rough token estimate: ~4 chars per token */
function estimateTokens(text: string): number {
  return Math.max(1, Math.round(text.length / 4));
}

/** Truncate content at the first matching stop sequence. */
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

/** Truncate content to approximate max_tokens (4 chars/token). */
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

// ── Model registry ───────────────────────────────────────────────────────────

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

const MODELS: ModelEntry[] = [
  // Opera Aria — keyless, anonymous auth, powered by OpenAI + Google
  ...ARIA_MODELS.map(m => ({ ...m, capabilities: { vision: false, tools: true, json_mode: false, streaming: true } })),
  // Yqcloud — GPT-4 proxy, userId pool rotation
  ...YQCLOUD_MODELS.map(m => ({ ...m, capabilities: { vision: false, tools: true, json_mode: false, streaming: true } })),
  // Cohere — command-a/r/r+ via HuggingFace Space
  ...COHERE_MODELS.map(m => ({ ...m, capabilities: { vision: false, tools: true, json_mode: false, streaming: true } })),
  // Perplexity — web search + AI, no auth, IP-based rate limit
  ...PERPLEXITY_MODELS.map(m => ({ ...m, capabilities: { vision: false, tools: true, json_mode: false, streaming: true }, context_window: 127072 })),
  // GPTFree — Firebase anonymous auth, no account required
  ...GPTFREE_MODELS.map(m => ({ ...m, capabilities: { vision: false, tools: true, json_mode: false, streaming: true } })),
  // AlgoChat — Gemini 3 Flash Preview via algochat.app guest session
  ...ALGOCHAT_MODELS.map(m => ({ ...m, capabilities: { vision: false, tools: true, json_mode: false, streaming: true }, context_window: 1048576 })),
  // ChatAIBot — Claude/DeepSeek/GPT via chataibot.pro promo-chat (no auth, IP rate-limited)
  ...CHATAIBOT_MODELS.map(m => ({ ...m, capabilities: { vision: false, tools: true, json_mode: false, streaming: true }, context_window: 32768 })),
  // Kimi — Moonshot AI Kimi-K2 via Connect RPC (requires KIMI_TOKEN)
  ...KIMI_MODELS.map(m => ({ ...m, capabilities: { vision: false, tools: true, json_mode: false, streaming: true }, context_window: 131072 })),
  // MiniMax — MiniMax-M3/M2.7 via agent.minimax.io (requires MINIMAX_TOKEN + MINIMAX_SESSION_ID)
  ...Object.keys(MINIMAX_MODELS).map(id => ({ id, object: "model", created: 1748736000, owned_by: "minimax", capabilities: { vision: false, tools: true, json_mode: false, streaming: true }, context_window: id.startsWith("minimax-m3") ? 450000 : 200000 })),
  // DeepSeek — web scraping via chat.deepseek.com (requires DEEPSEEK_TOKEN)
  { id: "deepseek-chat",     object: "model", created: 1748736000, owned_by: "deepseek", context_window: 65536, capabilities: { vision: false, tools: true, json_mode: false, streaming: true } },
  { id: "deepseek-reasoner", object: "model", created: 1748736000, owned_by: "deepseek", context_window: 65536, capabilities: { vision: false, tools: false, json_mode: false, streaming: true } },
  { id: "deepseek-search",   object: "model", created: 1748736000, owned_by: "deepseek", context_window: 65536, capabilities: { vision: false, tools: false, json_mode: false, streaming: true } },
  // Qwen text + vision models — all support vision via OSS image upload
  { id: "qwen3.7-max",                 object: "model", created: 1748736000, owned_by: "qwen", context_window: 131072,
    capabilities: { vision: true, tools: true, json_mode: true, streaming: true } },
  { id: "qwen3.6-plus",                object: "model", created: 1748736000, owned_by: "qwen", context_window: 131072,
    capabilities: { vision: true, tools: true, json_mode: true, streaming: true } },
  { id: "qwen3.6-max-preview",         object: "model", created: 1748736000, owned_by: "qwen", context_window: 131072,
    capabilities: { vision: true, tools: true, json_mode: true, streaming: true } },
  { id: "qwen3.7-plus",                object: "model", created: 1748736000, owned_by: "qwen", context_window: 131072,
    capabilities: { vision: true, tools: true, json_mode: true, streaming: true } },
  { id: "qwen3.5-397b-a17b",           object: "model", created: 1748736000, owned_by: "qwen", context_window: 131072,
    capabilities: { vision: false, tools: true, json_mode: true, streaming: true } },
  { id: "qwen3.5-122b-a10b",           object: "model", created: 1748736000, owned_by: "qwen", context_window: 131072,
    capabilities: { vision: false, tools: true, json_mode: true, streaming: true } },
  { id: "qwen3-coder-plus",            object: "model", created: 1748736000, owned_by: "qwen", context_window: 131072,
    capabilities: { vision: false, tools: true, json_mode: true, streaming: true } },
  { id: "qwen3.5-plus",                object: "model", created: 1748736000, owned_by: "qwen", context_window: 131072,
    capabilities: { vision: false, tools: true, json_mode: true, streaming: true } },
  { id: "qwen3.6-35b-a3b",             object: "model", created: 1748736000, owned_by: "qwen", context_window: 131072,
    capabilities: { vision: false, tools: true, json_mode: true, streaming: true } },
  { id: "qwen3.6-27b",                 object: "model", created: 1748736000, owned_by: "qwen", context_window: 131072,
    capabilities: { vision: false, tools: true, json_mode: true, streaming: true } },
  { id: "qwen3.5-flash",               object: "model", created: 1748736000, owned_by: "qwen", context_window: 131072,
    capabilities: { vision: false, tools: true, json_mode: true, streaming: true } },
  { id: "qwen3-235b-a22b",             object: "model", created: 1746489600, owned_by: "qwen", context_window: 131072,
    capabilities: { vision: true, tools: true, json_mode: true, streaming: true } },
  { id: "qwen3-30b-a3b",               object: "model", created: 1746489600, owned_by: "qwen", context_window: 131072,
    capabilities: { vision: true, tools: true, json_mode: true, streaming: true } },
  // Dedicated vision model aliases
  { id: "qwen-vl-max-latest",          object: "model", created: 1748736000, owned_by: "qwen", context_window: 131072,
    capabilities: { vision: true, tools: true, json_mode: true, streaming: true } },
  { id: "qwen2.5-vl-72b-instruct",     object: "model", created: 1730419200, owned_by: "qwen", context_window: 131072,
    capabilities: { vision: true, tools: true, json_mode: true, streaming: true } },
];

const QWEN_API_MODEL_MAP: Record<string, string> = {
  "qwen3-235b-a22b":       "qwen-plus-2025-07-28",
  "qwen3-30b-a3b":         "qwen3.5-35b-a3b",
  "qwen2.5-vl-72b-instruct": "qwen3.7-max",
  "qwen2.5-vl-7b-instruct":  "qwen3.5-35b-a3b",
  "qwen-vl-max-latest":    "qwen3.7-max",
};

const MODEL_ALIASES: Record<string, string> = {
  // qwen-max family
  "qwen-max":              "qwen3.7-max",
  "qwen-max-latest":       "qwen3.7-max",
  "qwen-max-0919":         "qwen3.7-max",
  // qwen-plus family
  "qwen-plus":             "qwen3.6-plus",
  "qwen-plus-latest":      "qwen3.6-plus",
  "qwen-plus-0723":        "qwen3.6-plus",
  // qwen-turbo family
  "qwen-turbo":            "qwen3-30b-a3b",
  "qwen-turbo-latest":     "qwen3-30b-a3b",
  "qwen-turbo-0919":       "qwen3-30b-a3b",
  // qwen-long
  "qwen-long":             "qwen3.6-plus",
  // qwq / reasoning
  "qwq-32b":               "qwen3.7-max",
  "qwq-32b-preview":       "qwen3.7-max",
  // qwen3 small/mid
  "qwen3-0.6b":            "qwen3-30b-a3b",
  "qwen3-1.7b":            "qwen3-30b-a3b",
  "qwen3-4b":              "qwen3-30b-a3b",
  "qwen3-8b":              "qwen3-30b-a3b",
  "qwen3-14b":             "qwen3-30b-a3b",
  "qwen3-32b":             "qwen3-235b-a22b",
  "qwen3-72b":             "qwen3-235b-a22b",
  // qwen2.5 instruct series
  "qwen2.5-7b-instruct":   "qwen3-30b-a3b",
  "qwen2.5-14b-instruct":  "qwen3-30b-a3b",
  "qwen2.5-32b-instruct":  "qwen3-235b-a22b",
  "qwen2.5-72b-instruct":  "qwen3-235b-a22b",
  // qwen2.5-coder → route to working qwen3 model
  "qwen2.5-coder-32b-instruct":  "qwen3-235b-a22b",
  "qwen2.5-coder-7b-instruct":   "qwen3-30b-a3b",
  "qwen2.5-coder-14b-instruct":  "qwen3-30b-a3b",
  // DeepSeek model aliases
  "deepseek-v3":              "deepseek-chat",
  "deepseek-v3-0324":         "deepseek-chat",
  "deepseek-v3-0106":         "deepseek-chat",
  "deepseek-r1":              "deepseek-reasoner",
  "deepseek-r1-0528":         "deepseek-reasoner",
  "deepseek-r1-0320":         "deepseek-reasoner",
  // Vision model aliases — vision is handled via OSS image upload, not model ID.
  // Map all VL/vision model IDs to working chat.qwen.ai text models.
  "qwen-vl-max":            "qwen3.7-max",
  "qwen-vl-max-latest":     "qwen3.7-max",
  "qwen-vl":                "qwen3.7-max",
  "qwen-vl-plus":           "qwen3.6-plus",
  "qwen2-vl-7b-instruct":   "qwen3-30b-a3b",
  "qwen2-vl-72b-instruct":  "qwen3-235b-a22b",
  "qwen2.5-vl":             "qwen3-235b-a22b",
  "qwen2.5-vl-7b-instruct": "qwen3-30b-a3b",
  "qwen2.5-vl-72b-instruct": "qwen3-235b-a22b",
  "qwen2.5-vl-max":         "qwen3.7-max",
};

function resolveModel(m: string): string {
  return MODEL_ALIASES[m] ?? m;
}

/** True if the model supports vision input (all Qwen models do via OSS upload). */
function isVisionModel(model: string): boolean {
  return model.startsWith("qwen") || model.includes("vl") || model.includes("vision");
}

// ── POST /v1/chat/completions ────────────────────────────────────────────────

router.post("/chat/completions", requireApiKey, async (req, res) => {
  const reqStart = Date.now();
  const reqId = `v1-${randomUUID().replace(/-/g, "").slice(0, 20)}`;

  const {
    model: _rawModel = "qwen3-235b-a22b",
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
      system_fingerprint: "fp_qwen_gateway",
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
      system_fingerprint: "fp_qwen_gateway",
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

    // ── Perplexity provider path ─────────────────────────────────────────────
    if (isPerplexityModel(model)) {
      const pplxEffective = hasImages ? await flattenVisionMessages(effectiveMessages) : effectiveMessages;
      const pplxMessages = pplxEffective.map(m => ({
        role: m.role,
        content: typeof m.content === "string" ? m.content : getMessageText(m.content),
      }));

      if (stream) {
        startSSE();

        // Collect full response for tool detection, stop sequences, max_tokens
        let pplxCollected = "";
        try {
          for await (const token of perplexityStream(pplxMessages, model)) {
            if (token) pplxCollected += token;
          }
        } catch (err: unknown) {
          logger.warn({ err }, "perplexity: stream error");
        }

        const pplxSsMt = applyMaxTokens(pplxCollected, _max);
        const pplxSsSt = applyStop(pplxSsMt.content, _stop);
        const pplxFinalText = pplxSsSt.content;
        const pplxStreamFinish = (pplxSsMt.truncated || pplxSsSt.truncated) ? "length" : "stop";
        const pplxPromptEst = estimateTokens(messagesToPrompt(pplxMessages));
        const pplxOutEst = Math.round(pplxFinalText.length / 4);

        if (hasTools) {
          const pplxStreamToolCalls = detectToolCalls(pplxFinalText);
          if (pplxStreamToolCalls) {
            res.write(sseChunk({ role: "assistant", content: null }));
            for (let i = 0; i < pplxStreamToolCalls.length; i++) {
              const tc = pplxStreamToolCalls[i];
              res.write(sseChunk({ tool_calls: [{ index: i, id: tc.id, type: "function", function: { name: tc.function.name, arguments: "" } }] }));
              const args = tc.function.arguments;
              for (let j = 0; j < args.length; j += 20) {
                res.write(sseChunk({ tool_calls: [{ index: i, function: { arguments: args.slice(j, j + 20) } }] }));
              }
            }
            if (includeUsage) res.write(sseUsageChunk(pplxPromptEst, pplxOutEst));
            res.write(sseChunk({}, "tool_calls"));
            res.write("data: [DONE]\n\n");
            res.end();
            return;
          }
        }

        res.write(sseChunk({ role: "assistant", content: "" }));
        for (const w of pplxFinalText.split(/(\s+)/)) {
          if (w) res.write(sseChunk({ content: w }));
        }
        if (includeUsage) res.write(sseUsageChunk(pplxPromptEst, pplxOutEst));
        res.write(sseChunk({}, pplxStreamFinish));
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }

      const { content: pplxRaw, inputTokens: pplxIn, outputTokens: pplxOut } = await perplexityChat(pplxMessages, model);
      if (!pplxRaw) {
        res.status(502).json({ error: { message: "No response from Perplexity", type: "upstream_error", code: "empty_response" } });
        return;
      }
      const pplxMt = applyMaxTokens(pplxRaw, _max);
      const pplxSt = applyStop(pplxMt.content, _stop);
      const pplxContent = pplxSt.content;
      const pplxFinish = (pplxMt.truncated || pplxSt.truncated) ? "length" : "stop";
      const pplxUsage = { prompt_tokens: pplxIn, completion_tokens: pplxOut, total_tokens: pplxIn + pplxOut, prompt_tokens_details: { cached_tokens: 0, audio_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0, audio_tokens: 0, accepted_prediction_tokens: 0, rejected_prediction_tokens: 0 } };
      const toolCalls = hasTools ? detectToolCalls(pplxContent) : null;
      if (toolCalls) {
        res.json({ id, object: "chat.completion", created, model: _rawModel, service_tier: "default", system_fingerprint: "fp_perplexity_gateway",
          choices: [{ index: 0, message: { role: "assistant", refusal: null, content: null, tool_calls: toolCalls }, logprobs: null, finish_reason: "tool_calls" }],
          usage: pplxUsage });
        return;
      }
      res.json({ id, object: "chat.completion", created, model: _rawModel, service_tier: "default", system_fingerprint: "fp_perplexity_gateway",
        choices: [{ index: 0, message: { role: "assistant", refusal: null, content: pplxContent }, logprobs: null, finish_reason: pplxFinish }],
        usage: pplxUsage });
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

    // ── ChatAIBot provider path (chataibot.pro promo-chat, no auth) ──────────
    if (isChataibot(model)) {
      const cbEffective = hasImages ? await flattenVisionMessages(effectiveMessages) : effectiveMessages;
      const cbMessages = cbEffective.map(m => ({
        role: m.role,
        content: typeof m.content === "string" ? m.content : getMessageText(m.content),
      }));

      if (stream) {
        startSSE();

        let cbCollected = "";
        try {
          for await (const token of chataibotStream(cbMessages, model)) {
            if (token) cbCollected += token;
          }
        } catch (err: unknown) {
          logger.warn({ err }, "chataibot: stream error");
        }

        const cbSsMt = applyMaxTokens(cbCollected, _max);
        const cbSsSt = applyStop(cbSsMt.content, _stop);
        const cbFinalText = cbSsSt.content;
        const cbStreamFinish = (cbSsMt.truncated || cbSsSt.truncated) ? "length" : "stop";
        const cbPromptEst = estimateTokens(messagesToPrompt(cbMessages));
        const cbOutEst = Math.round(cbFinalText.length / 4);

        if (hasTools) {
          const cbStreamToolCalls = detectToolCalls(cbFinalText);
          if (cbStreamToolCalls) {
            res.write(sseChunk({ role: "assistant", content: null }));
            for (let i = 0; i < cbStreamToolCalls.length; i++) {
              const tc = cbStreamToolCalls[i];
              res.write(sseChunk({ tool_calls: [{ index: i, id: tc.id, type: "function", function: { name: tc.function.name, arguments: "" } }] }));
              const args = tc.function.arguments;
              for (let j = 0; j < args.length; j += 20) {
                res.write(sseChunk({ tool_calls: [{ index: i, function: { arguments: args.slice(j, j + 20) } }] }));
              }
            }
            if (includeUsage) res.write(sseUsageChunk(cbPromptEst, cbOutEst));
            res.write(sseChunk({}, "tool_calls"));
            res.write("data: [DONE]\n\n");
            res.end();
            return;
          }
        }

        res.write(sseChunk({ role: "assistant", content: "" }));
        for (const w of cbFinalText.split(/(\s+)/)) {
          if (w) res.write(sseChunk({ content: w }));
        }
        if (includeUsage) res.write(sseUsageChunk(cbPromptEst, cbOutEst));
        res.write(sseChunk({}, cbStreamFinish));
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }

      let cbResult: { content: string; inputTokens: number; outputTokens: number };
      try {
        cbResult = await chataibot(cbMessages, model);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "ChatAIBot upstream error";
        res.status(502).json({ error: { message: msg, type: "upstream_error", code: "provider_error" } });
        return;
      }
      const { content: cbRaw, inputTokens: cbIn, outputTokens: cbOut } = cbResult;
      if (!cbRaw) {
        res.status(502).json({ error: { message: "No response from ChatAIBot", type: "upstream_error", code: "empty_response" } });
        return;
      }
      const cbMt = applyMaxTokens(cbRaw, _max);
      const cbSt = applyStop(cbMt.content, _stop);
      const cbContent = cbSt.content;
      const cbFinish = (cbMt.truncated || cbSt.truncated) ? "length" : "stop";
      const cbUsage = { prompt_tokens: cbIn, completion_tokens: cbOut, total_tokens: cbIn + cbOut, prompt_tokens_details: { cached_tokens: 0, audio_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0, audio_tokens: 0, accepted_prediction_tokens: 0, rejected_prediction_tokens: 0 } };
      const cbToolCalls = hasTools ? detectToolCalls(cbContent) : null;
      if (cbToolCalls) {
        res.json({ id, object: "chat.completion", created, model: _rawModel, service_tier: "default", system_fingerprint: "fp_chataibot_gateway",
          choices: [{ index: 0, message: { role: "assistant", refusal: null, content: null, tool_calls: cbToolCalls }, logprobs: null, finish_reason: "tool_calls" }],
          usage: cbUsage });
        return;
      }
      res.json({ id, object: "chat.completion", created, model: _rawModel, service_tier: "default", system_fingerprint: "fp_chataibot_gateway",
        choices: [{ index: 0, message: { role: "assistant", refusal: null, content: cbContent }, logprobs: null, finish_reason: cbFinish }],
        usage: cbUsage });
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

    // ── MiniMax provider path (MiniMax-M3 / M2.7 via agent.minimax.io) ─────
    if (isMinimaxModel(model)) {
      const mmEffective = hasImages ? await flattenVisionMessages(effectiveMessages) : effectiveMessages;
      const mmMessages = mmEffective.map(m => ({
        role: m.role,
        content: typeof m.content === "string" ? m.content : getMessageText(m.content),
      }));

      if (stream) {
        startSSE();

        let mmCollected = "";
        try {
          for await (const token of minimaxStream(mmMessages, model)) {
            if (token) mmCollected += token;
          }
        } catch (err: unknown) {
          logger.warn({ err }, "minimax: stream error");
        }

        const mmSsMt = applyMaxTokens(mmCollected, _max);
        const mmSsSt = applyStop(mmSsMt.content, _stop);
        const mmFinalText = mmSsSt.content;
        const mmStreamFinish = (mmSsMt.truncated || mmSsSt.truncated) ? "length" : "stop";
        const mmPromptEst = estimateTokens(messagesToPrompt(mmMessages));
        const mmOutEst = Math.round(mmFinalText.length / 4);

        if (hasTools) {
          const mmStreamToolCalls = detectToolCalls(mmFinalText);
          if (mmStreamToolCalls) {
            res.write(sseChunk({ role: "assistant", content: null }));
            for (let i = 0; i < mmStreamToolCalls.length; i++) {
              const tc = mmStreamToolCalls[i];
              res.write(sseChunk({ tool_calls: [{ index: i, id: tc.id, type: "function", function: { name: tc.function.name, arguments: "" } }] }));
              const args = tc.function.arguments;
              for (let j = 0; j < args.length; j += 20) {
                res.write(sseChunk({ tool_calls: [{ index: i, function: { arguments: args.slice(j, j + 20) } }] }));
              }
            }
            if (includeUsage) res.write(sseUsageChunk(mmPromptEst, mmOutEst));
            res.write(sseChunk({}, "tool_calls"));
            res.write("data: [DONE]\n\n");
            res.end();
            return;
          }
        }

        res.write(sseChunk({ role: "assistant", content: "" }));
        for (const w of mmFinalText.split(/(\s+)/)) {
          if (w) res.write(sseChunk({ content: w }));
        }
        if (includeUsage) res.write(sseUsageChunk(mmPromptEst, mmOutEst));
        res.write(sseChunk({}, mmStreamFinish));
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }

      let mmResult: { content: string; inputTokens: number; outputTokens: number };
      try {
        mmResult = await minimaxChat(mmMessages, model);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "MiniMax upstream error";
        res.status(502).json({ error: { message: msg, type: "upstream_error", code: "provider_error" } });
        return;
      }
      const { content: mmRaw, inputTokens: mmIn, outputTokens: mmOut } = mmResult;
      if (!mmRaw) {
        res.status(502).json({ error: { message: "No response from MiniMax", type: "upstream_error", code: "empty_response" } });
        return;
      }
      const mmMt = applyMaxTokens(mmRaw, _max);
      const mmSt = applyStop(mmMt.content, _stop);
      const mmContent = mmSt.content;
      const mmFinish = (mmMt.truncated || mmSt.truncated) ? "length" : "stop";
      const mmUsage = { prompt_tokens: mmIn, completion_tokens: mmOut, total_tokens: mmIn + mmOut, prompt_tokens_details: { cached_tokens: 0, audio_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0, audio_tokens: 0, accepted_prediction_tokens: 0, rejected_prediction_tokens: 0 } };
      const mmToolCalls = hasTools ? detectToolCalls(mmContent) : null;
      if (mmToolCalls) {
        res.json({ id, object: "chat.completion", created, model: _rawModel, service_tier: "default", system_fingerprint: "fp_minimax_gateway",
          choices: [{ index: 0, message: { role: "assistant", refusal: null, content: null, tool_calls: mmToolCalls }, logprobs: null, finish_reason: "tool_calls" }],
          usage: mmUsage });
        return;
      }
      res.json({ id, object: "chat.completion", created, model: _rawModel, service_tier: "default", system_fingerprint: "fp_minimax_gateway",
        choices: [{ index: 0, message: { role: "assistant", refusal: null, content: mmContent }, logprobs: null, finish_reason: mmFinish }],
        usage: mmUsage });
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

    // ── DeepSeek provider path ───────────────────────────────────────────────
    if (isDeepseekModel(model)) {
      const dsEffective = hasImages ? await flattenVisionMessages(effectiveMessages) : effectiveMessages;
      const dsMessages = dsEffective.map(m => ({
        role: m.role,
        content: typeof m.content === "string" ? m.content : getMessageText(m.content),
      }));

      if (stream) {
        startSSE();

        let dsCollected = "";
        try {
          for await (const token of deepseekStream(dsMessages, model)) {
            if (token) dsCollected += token;
          }
        } catch (err: unknown) {
          logger.warn({ err }, "deepseek: stream error");
        }

        const dsSsMt = applyMaxTokens(dsCollected, _max);
        const dsSsSt = applyStop(dsSsMt.content, _stop);
        const dsFinalText = dsSsSt.content;
        const dsStreamFinish = (dsSsMt.truncated || dsSsSt.truncated) ? "length" : "stop";
        const dsPromptEst = estimateTokens(messagesToPrompt(dsMessages));
        const dsOutEst = Math.round(dsFinalText.length / 4);

        if (hasTools) {
          const dsStreamToolCalls = detectToolCalls(dsFinalText);
          if (dsStreamToolCalls) {
            res.write(sseChunk({ role: "assistant", content: null }));
            for (let i = 0; i < dsStreamToolCalls.length; i++) {
              const tc = dsStreamToolCalls[i];
              res.write(sseChunk({ tool_calls: [{ index: i, id: tc.id, type: "function", function: { name: tc.function.name, arguments: "" } }] }));
              const args = tc.function.arguments;
              for (let j = 0; j < args.length; j += 20) {
                res.write(sseChunk({ tool_calls: [{ index: i, function: { arguments: args.slice(j, j + 20) } }] }));
              }
            }
            if (includeUsage) res.write(sseUsageChunk(dsPromptEst, dsOutEst));
            res.write(sseChunk({}, "tool_calls"));
            res.write("data: [DONE]\n\n");
            res.end();
            return;
          }
        }

        res.write(sseChunk({ role: "assistant", content: "" }));
        for (const w of dsFinalText.split(/(\s+)/)) {
          if (w) res.write(sseChunk({ content: w }));
        }
        if (includeUsage) res.write(sseUsageChunk(dsPromptEst, dsOutEst));
        res.write(sseChunk({}, dsStreamFinish));
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }

      const { content: dsRaw, inputTokens: dsIn, outputTokens: dsOut } = await deepseekChat(dsMessages, model);
      if (!dsRaw) {
        res.status(502).json({ error: { message: "No response from DeepSeek", type: "upstream_error", code: "empty_response" } });
        return;
      }
      const dsMt = applyMaxTokens(dsRaw, _max);
      const dsSt = applyStop(dsMt.content, _stop);
      const dsContent = dsSt.content;
      const dsFinish = (dsMt.truncated || dsSt.truncated) ? "length" : "stop";
      const dsUsage = {
        prompt_tokens: dsIn, completion_tokens: dsOut, total_tokens: dsIn + dsOut,
        prompt_tokens_details: { cached_tokens: 0, audio_tokens: 0 },
        completion_tokens_details: { reasoning_tokens: 0, audio_tokens: 0, accepted_prediction_tokens: 0, rejected_prediction_tokens: 0 },
      };
      const dsToolCalls = hasTools ? detectToolCalls(dsContent) : null;
      if (dsToolCalls) {
        res.json({ id, object: "chat.completion", created, model: _rawModel, service_tier: "default", system_fingerprint: "fp_deepseek_gateway",
          choices: [{ index: 0, message: { role: "assistant", refusal: null, content: null, tool_calls: dsToolCalls }, logprobs: null, finish_reason: "tool_calls" }],
          usage: dsUsage });
        return;
      }
      res.json({ id, object: "chat.completion", created, model: _rawModel, service_tier: "default", system_fingerprint: "fp_deepseek_gateway",
        choices: [{ index: 0, message: { role: "assistant", refusal: null, content: dsContent }, logprobs: null, finish_reason: dsFinish }],
        usage: dsUsage });
      return;
    }

    // ── QWEN provider path ───────────────────────────────────────────────────
    const midtoken = await getMidtoken();
    const headers = qwenHeaders(midtoken);

    // For vision requests, get acw_tc cookie (required by getstsToken upload endpoint)
    let resolvedFiles: QwenFileDescriptor[] = [];
    if (hasImages) {
      const cookie = await getQwenCookies(midtoken);
      const uploadHeaders = { ...headers, Cookie: cookie };
      resolvedFiles = await resolveImageUrls(allImageUrls, uploadHeaders);
    }

    const chatApiModel = QWEN_API_MODEL_MAP[effectiveModel] ?? effectiveModel;
    const chatId = await createQwenChat(headers, chatApiModel, midtoken);

    // Build the prompt; strip image notes when images are handled natively via files[]
    const userPrompt = messagesToPrompt(effectiveMessages, resolvedFiles.length > 0);

    const qwenPayload = {
      stream: true, incremental_output: true, chat_id: chatId, chat_mode: "normal",
      model: chatApiModel,
      temperature,
      ...(typeof _max === "number" && _max > 0 ? { max_output_tokens: _max } : {}),
      ...(typeof _topP === "number" ? { top_p: Math.max(0, Math.min(1, _topP)) } : {}),
      parent_id: null,
      messages: [{
        fid: randomUUID(), parentId: null, childrenIds: [], role: "user",
        content: userPrompt, user_action: "chat",
        files: resolvedFiles,
        models: [chatApiModel],
        chat_type: "t2t",
        feature_config: { thinking_enabled: false, output_schema: "phase", thinking_budget: 81920 },
        sub_chat_type: "t2t",
      }],
    };

    const qwenToken = getQwenSessionToken();

    const getQwenBody = (): Promise<string> =>
      qwenToken
        ? qwenPyBody(qwenToken, chatId, qwenPayload)
        : qwenPyBody("", chatId, qwenPayload, midtoken);

    // ── STREAMING path ──────────────────────────────────────────────────────
    if (stream) {
      startSSE();

      if (hasTools) {
        const body = await getQwenBody();
        checkQwenWaf(body);
        const { content, inputTokens, outputTokens, upstreamError } = parseQwenSSE(body);

        if (upstreamError) {
          res.write(`data: ${JSON.stringify({ error: upstreamError.message })}\n\ndata: [DONE]\n\n`);
          res.end();
          return;
        }
        if (!content) {
          res.write(`data: ${JSON.stringify({ error: "No response from model" })}\n\ndata: [DONE]\n\n`);
          res.end();
          return;
        }

        const toolCalls = detectToolCalls(content);

        if (toolCalls) {
          res.write(sseChunk({ role: "assistant", content: null }));
          for (let i = 0; i < toolCalls.length; i++) {
            const tc = toolCalls[i];
            res.write(sseChunk({
              tool_calls: [{
                index: i, id: tc.id, type: "function",
                function: { name: tc.function.name, arguments: "" },
              }],
            }));
            const args = tc.function.arguments;
            const chunkSize = 20;
            for (let j = 0; j < args.length; j += chunkSize) {
              res.write(sseChunk({
                tool_calls: [{ index: i, function: { arguments: args.slice(j, j + chunkSize) } }],
              }));
            }
          }
          res.write(sseChunk({}, "tool_calls"));
        } else {
          // Safety: if the content looks like a tool-call JSON that we failed to parse,
          // don't leak raw JSON to the client — emit an empty stop instead.
          if (looksLikeToolCallJson(content)) {
            res.write(sseChunk({ role: "assistant", content: null }));
            res.write(sseChunk({}, "stop"));
          } else {
            res.write(sseChunk({ role: "assistant", content: "" }));
            const words = content.split(/(\s+)/);
            for (const word of words) {
              if (word) res.write(sseChunk({ content: word }));
            }
            res.write(sseChunk({}, "stop"));
          }
        }

        if (includeUsage) res.write(sseUsageChunk(inputTokens, outputTokens));
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }

      // ── Real streaming via Python subprocess (when QWEN_SESSION_TOKEN is set) ──
      if (qwenToken) {
        res.write(sseChunk({ role: "assistant", content: "" }));
        const payloadB64 = Buffer.from(JSON.stringify(qwenPayload)).toString("base64");
        const py = spawn("python3", [QWEN_CFFI_PY, "chat", qwenToken, chatId, payloadB64]);
        py.stderr.on("data", (d: Buffer) => logger.warn({ err: d.toString().trim() }, "qwen-cffi: stderr"));

        let ssBuf = "";
        let ssInputTokens = 0;
        let ssOutputTokens = 0;

        await new Promise<void>((resolve, reject) => {
          py.stdout.on("data", (chunk: Buffer) => {
            ssBuf += chunk.toString("utf8");
            const lines = ssBuf.split("\n");
            ssBuf = lines.pop() ?? "";
            for (const line of lines) {
              if (!line.startsWith("data:")) continue;
              try {
                const parsed = JSON.parse(line.slice(5).trim()) as {
                  choices?: Array<{ delta?: { content?: string; extra?: { output_schema?: string } } }>;
                  usage?: { input_tokens?: number; output_tokens?: number };
                };
                if (parsed.usage) {
                  ssInputTokens = parsed.usage.input_tokens ?? ssInputTokens;
                  ssOutputTokens = parsed.usage.output_tokens ?? ssOutputTokens;
                }
                const delta = parsed.choices?.[0]?.delta;
                const content = delta?.content ?? "";
                if (!content) continue;
                const schema = delta?.extra?.output_schema ?? "";
                if (schema && schema !== "answer") continue;
                res.write(sseChunk({ content }));
              } catch { /* skip malformed */ }
            }
          });
          py.stdout.on("end", resolve);
          py.on("error", reject);
          setTimeout(() => { py.kill(); reject(new Error("qwen-cffi stream: timeout")); }, 90000);
        });

        res.write(sseChunk({}, "stop"));
        if (includeUsage) res.write(sseUsageChunk(ssInputTokens, ssOutputTokens));
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }

      // ── Keyless fallback: Node.js fetch (may be WAF-blocked without token) ──
      const r2 = await fetch(qwenCompletionsUrl(chatId), {
        method: "POST", headers, body: JSON.stringify(qwenPayload),
      });

      if (!r2.body) {
        res.write(`data: ${JSON.stringify({ error: "No response body" })}\n\ndata: [DONE]\n\n`);
        res.end();
        return;
      }

      res.write(sseChunk({ role: "assistant", content: "" }));

      const reader = (r2.body as unknown as { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }> } }).getReader();
      const decoder = new TextDecoder();
      let lineBuffer = "";
      let ssInputTokens = 0;
      let ssOutputTokens = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        lineBuffer += decoder.decode(value, { stream: true });

        const lines = lineBuffer.split("\n");
        lineBuffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          try {
            const chunk = JSON.parse(line.slice(5).trim()) as {
              choices?: Array<{ delta?: { content?: string; extra?: { output_schema?: string } } }>;
              usage?: { input_tokens?: number; output_tokens?: number };
            };
            if (chunk.usage) {
              ssInputTokens = chunk.usage.input_tokens ?? ssInputTokens;
              ssOutputTokens = chunk.usage.output_tokens ?? ssOutputTokens;
            }
            const delta = chunk.choices?.[0]?.delta;
            const content = delta?.content ?? "";
            if (!content) continue;
            const schema = delta?.extra?.output_schema ?? "";
            if (schema && schema !== "answer") continue;
            res.write(sseChunk({ content }));
          } catch { /* skip malformed */ }
        }
      }

      res.write(sseChunk({}, "stop"));
      if (includeUsage) res.write(sseUsageChunk(ssInputTokens, ssOutputTokens));
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    // ── NON-STREAMING path ───────────────────────────────────────────────────
    const body = await getQwenBody();
    checkQwenWaf(body);

    const { content: qwenRaw, inputTokens, outputTokens, upstreamError } = parseQwenSSE(body);

    if (upstreamError) {
      res.status(503).json({
        error: { message: upstreamError.message, type: "upstream_error", code: upstreamError.code ?? "upstream_error" },
      });
      return;
    }
    if (!qwenRaw) {
      res.status(502).json({
        error: { message: "No response from model", type: "upstream_error", code: "empty_response" },
      });
      return;
    }

    // Apply stop sequences post-processing (max_tokens handled by Qwen natively)
    const qwenSt = applyStop(qwenRaw, _stop);
    const content = qwenSt.content;
    const qwenFinish = qwenSt.truncated ? "length" : "stop";

    const toolCalls = hasTools ? detectToolCalls(content) : null;

    const usageBlock = {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
      prompt_tokens_details: { cached_tokens: 0, audio_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 0, audio_tokens: 0, accepted_prediction_tokens: 0, rejected_prediction_tokens: 0 },
    };

    if (toolCalls) {
      res.json({
        id,
        object: "chat.completion",
        created,
        model: _rawModel,
        service_tier: "default",
        system_fingerprint: "fp_qwen_gateway",
        choices: [{
          index: 0,
          message: { role: "assistant", refusal: null, content: null, tool_calls: toolCalls },
          logprobs: null,
          finish_reason: "tool_calls",
        }],
        usage: usageBlock,
      });
      return;
    }

    // Safety: if the model leaked a raw tool-call JSON but detection failed,
    // return null content instead of exposing raw JSON to the client.
    const safeContent = (hasTools && looksLikeToolCallJson(content)) ? null : content;

    res.json({
      id,
      object: "chat.completion",
      created,
      model: _rawModel,
      service_tier: "default",
      system_fingerprint: "fp_qwen_gateway",
      choices: [{
        index: 0,
        message: { role: "assistant", refusal: null, content: safeContent },
        logprobs: null,
        finish_reason: safeContent === null ? "stop" : qwenFinish,
      }],
      usage: usageBlock,
    });
  } catch (err) {
    logger.error({ err }, "v1/chat/completions error");
    const errMsg = err instanceof Error ? err.message : "Internal server error";
    // Pass through meaningful provider errors instead of swallowing them
    const isWaf      = errMsg.includes("WAF") || errMsg.includes("QWEN_SESSION_TOKEN");
    const isProvider = errMsg.startsWith("Perplexity") || errMsg.startsWith("AlgoChat")
                    || errMsg.startsWith("Kimi") || errMsg.startsWith("DeepSeek")
                    || errMsg.startsWith("MiniMax") || errMsg.startsWith("GPTFree")
                    || errMsg.startsWith("Opera") || errMsg.includes("authwall")
                    || errMsg.includes("rate limit") || errMsg.includes("rate limited")
                    || errMsg.includes("upstream");
    const expose  = isWaf || isProvider;
    const message = expose ? errMsg : "Internal server error";
    const type    = isWaf ? "service_unavailable" : isProvider ? "upstream_error" : "server_error";
    const code    = isWaf ? "qwen_waf_blocked"   : isProvider ? "provider_error"  : "internal_error";
    if (!res.headersSent) {
      res.status(isWaf ? 503 : 500).json({ error: { message, type, code } });
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

// ── POST /v1/completions (legacy text completions) ───────────────────────────

router.post("/completions", requireApiKey, async (req, res) => {
  const reqId = `cmpl-${randomUUID().replace(/-/g, "").slice(0, 29)}`;
  const created = Math.floor(Date.now() / 1000);

  const {
    model: _rawModel = "qwen3-235b-a22b",
    prompt,
    max_tokens,
    temperature: _temp,
    stream = false,
    suffix: _suffix,
    stop: _stop,
  } = req.body as {
    model?: string;
    prompt?: string | string[];
    max_tokens?: number;
    temperature?: number;
    stream?: boolean;
    suffix?: string;
    stop?: string | string[];
  };

  if (!prompt) {
    res.status(400).json({
      error: {
        message: "prompt is required",
        type: "invalid_request_error",
        param: "prompt",
        code: "missing_required_parameter",
      },
    });
    return;
  }

  const promptText = Array.isArray(prompt) ? prompt.join("") : String(prompt);
  const model = resolveModel(_rawModel);
  const temperature = typeof _temp === "number" ? Math.max(0, Math.min(2, _temp)) : 0.7;

  try {
    const midtoken = await getMidtoken();
    const headers = qwenHeaders(midtoken);
    const chatId = await createQwenChat(headers, model);

    const r = await fetch(qwenCompletionsUrl(chatId), {
      method: "POST",
      headers,
      body: JSON.stringify({
        stream: true, incremental_output: true, chat_id: chatId, chat_mode: "normal",
        model,
        temperature,
        parent_id: null,
        messages: [{
          fid: randomUUID(), parentId: null, childrenIds: [], role: "user",
          content: promptText, user_action: "chat",
          files: [],
          models: [model],
          chat_type: "t2t",
          feature_config: { thinking_enabled: false, output_schema: "phase", thinking_budget: 81920 },
          sub_chat_type: "t2t",
        }],
      }),
    });

    const rawBody = await r.text();
    const { content, inputTokens, outputTokens, upstreamError: legacyErr } = parseQwenSSE(rawBody);

    if (legacyErr) {
      res.status(503).json({
        error: { message: legacyErr.message, type: "upstream_error", param: null, code: legacyErr.code ?? "upstream_error" },
      });
      return;
    }
    if (!content) {
      res.status(502).json({
        error: { message: "No response from model", type: "upstream_error", param: null, code: "empty_response" },
      });
      return;
    }

    const usageBlock = {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
      prompt_tokens_details: { cached_tokens: 0, audio_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 0, audio_tokens: 0, accepted_prediction_tokens: 0, rejected_prediction_tokens: 0 },
    };

    if (stream) {
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders();

      const words = content.split(/(\s+)/);
      for (const word of words) {
        if (!word) continue;
        const chunk = {
          id: reqId,
          object: "text_completion",
          created,
          model: _rawModel,
          service_tier: "default",
          system_fingerprint: "fp_qwen_gateway",
          choices: [{ text: word, index: 0, logprobs: null, finish_reason: null }],
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
      const doneChunk = {
        id: reqId,
        object: "text_completion",
        created,
        model: _rawModel,
        service_tier: "default",
        system_fingerprint: "fp_qwen_gateway",
        choices: [{ text: "", index: 0, logprobs: null, finish_reason: "stop" }],
      };
      res.write(`data: ${JSON.stringify(doneChunk)}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    res.json({
      id: reqId,
      object: "text_completion",
      created,
      model: _rawModel,
      service_tier: "default",
      system_fingerprint: "fp_qwen_gateway",
      choices: [{
        text: content,
        index: 0,
        logprobs: null,
        finish_reason: "stop",
      }],
      usage: usageBlock,
    });
  } catch (err) {
    logger.error({ err }, "v1/completions error");
    if (!res.headersSent) {
      res.status(500).json({
        error: { message: "Internal server error", type: "api_error", param: null, code: "internal_error" },
      });
    }
  }
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

// ── POST /v1/images/generations ──────────────────────────────────────────────
// OpenAI-compatible image generation via Qwen t2i (Wan model internally).
// Request:  { prompt, model?, n?, size?, quality? }
// Response: { created, data: [{ url, revised_prompt? }] }

router.post("/images/generations", requireApiKey, async (req, res) => {
  try {
    const body = req.body as {
      prompt?: string;
      model?: string;
      n?: number;
      size?: string;
      quality?: string;
      response_format?: string;
    };

    const prompt = body.prompt?.trim();
    if (!prompt) {
      res.status(400).json({
        error: { message: "prompt is required", type: "invalid_request_error", param: "prompt", code: "missing_param" },
      });
      return;
    }

    const n = Math.min(Math.max(body.n ?? 1, 1), 4);

    // Use qwen3.7-plus — supports image-generation MCP internally via t2i chat type
    const imageModel = "qwen3.7-plus";
    const imgQwenToken = getQwenSessionToken();

    const midtoken = await getMidtoken();
    const headers = qwenHeaders(midtoken);

    // Generate n images — fire all in parallel
    const tasks = Array.from({ length: n }, async (): Promise<{ url: string } | null> => {
      try {
        const chatId = await createQwenChat(headers, imageModel);

        const imgPayload = {
          stream: true, incremental_output: true,
          chat_id: chatId, chat_mode: "normal",
          model: imageModel, parent_id: null,
          messages: [{
            fid: randomUUID(), parentId: null, childrenIds: [],
            role: "user", content: prompt, user_action: "chat",
            files: [], models: [imageModel],
            chat_type: "t2i",
            feature_config: { thinking_enabled: false },
            sub_chat_type: "t2i",
          }],
        };

        let rawBody: string;
        if (imgQwenToken) {
          rawBody = await qwenPyBody(imgQwenToken, chatId, imgPayload);
        } else {
          const r = await fetch(qwenCompletionsUrl(chatId), {
            method: "POST", headers, body: JSON.stringify(imgPayload),
          });
          if (!r.ok) return null;
          rawBody = await r.text();
        }

        // The content is the signed CDN URL for the image
        let imageUrl = "";
        for (const line of rawBody.split("\n")) {
          if (!line.startsWith("data:")) continue;
          try {
            const chunk = JSON.parse(line.slice(5).trim()) as {
              choices?: Array<{ delta?: { content?: string } }>;
            };
            const content = chunk.choices?.[0]?.delta?.content ?? "";
            if (content) imageUrl += content;
          } catch { /* skip */ }
        }

        imageUrl = imageUrl.trim();
        if (!imageUrl.startsWith("http")) return null;
        return { url: imageUrl };
      } catch {
        return null;
      }
    });

    const results = await Promise.all(tasks);
    const images = results.filter((r): r is { url: string } => r !== null);

    if (images.length === 0) {
      res.status(502).json({
        error: { message: "Image generation failed — no image returned from upstream", type: "upstream_error", param: null, code: "empty_response" },
      });
      return;
    }

    res.json({
      created: Math.floor(Date.now() / 1000),
      data: images,
    });
  } catch (err) {
    logger.error({ err }, "v1/images/generations error");
    if (!res.headersSent) {
      res.status(500).json({
        error: { message: "Internal server error", type: "api_error", param: null, code: "internal_error" },
      });
    }
  }
});

export default router;
