import { logger } from "./logger";

const BASE = "https://api.telegram.org";

function token(): string {
  const t = process.env["TELEGRAM_BOT_TOKEN"];
  if (!t) throw new Error("TELEGRAM_BOT_TOKEN is not set");
  return t;
}

async function call<T = unknown>(method: string, body?: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${BASE}/bot${token()}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json() as { ok: boolean; result?: T; description?: string };
  if (!data.ok) {
    logger.warn({ method, description: data.description }, "Telegram API error");
    throw new Error(`Telegram ${method}: ${data.description}`);
  }
  return data.result as T;
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface TgUser {
  id: number;
  first_name: string;
  username?: string;
  language_code?: string;
}

export interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: { id: number; type: string };
  text?: string;
  date: number;
}

export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

export interface InlineKeyboard {
  inline_keyboard: Array<Array<{ text: string; callback_data?: string; url?: string }>>;
}

export interface SendOptions {
  parse_mode?: "HTML" | "Markdown" | "MarkdownV2";
  reply_markup?: InlineKeyboard | { remove_keyboard: true };
  disable_web_page_preview?: boolean;
  disable_notification?: boolean;
}

// ── API Methods ──────────────────────────────────────────────────────────────

export async function sendMessage(
  chatId: number,
  text: string,
  options: SendOptions = {},
): Promise<TgMessage> {
  return call<TgMessage>("sendMessage", { chat_id: chatId, text, ...options });
}

export async function answerCallbackQuery(
  callbackQueryId: string,
  text?: string,
  showAlert = false,
): Promise<boolean> {
  return call<boolean>("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    ...(text ? { text, show_alert: showAlert } : {}),
  });
}

export async function setWebhook(webhookUrl: string): Promise<boolean> {
  return call<boolean>("setWebhook", {
    url: webhookUrl,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: true,
  });
}

export async function deleteWebhook(): Promise<boolean> {
  return call<boolean>("deleteWebhook", { drop_pending_updates: false });
}

export async function getMe(): Promise<TgUser & { is_bot: boolean; username: string }> {
  return call("getMe");
}

export async function getWebhookInfo(): Promise<{
  url: string;
  has_custom_certificate: boolean;
  pending_update_count: number;
  last_error_message?: string;
}> {
  return call("getWebhookInfo");
}

export function isBotAvailable(): boolean {
  return Boolean(process.env["TELEGRAM_BOT_TOKEN"]);
}
