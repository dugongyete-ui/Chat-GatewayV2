import { getDb } from "./mongo";
import { generateApiKey } from "./auth-helpers";
import { logger } from "./logger";
import {
  sendMessage,
  answerCallbackQuery,
  type TgUpdate,
  type TgUser,
  type TgCallbackQuery,
} from "./telegram";

// ── MongoDB helpers ──────────────────────────────────────────────────────────

interface TelegramUser {
  telegram_id: number;
  first_name: string;
  username?: string;
  user_id: string;
  created_at: Date;
}

async function getOrCreateTelegramUser(from: TgUser): Promise<{ userId: string; isNew: boolean }> {
  const db = await getDb();
  const col = db.collection<TelegramUser>("telegram_users");

  const existing = await col.findOne({ telegram_id: from.id });
  if (existing) return { userId: existing.user_id, isNew: false };

  // Create a virtual user in users collection
  const usersCol = db.collection("users");
  const email = `tg_${from.id}@telegram.bot`;

  const exists = await usersCol.findOne({ email });
  let userId: string;

  if (exists) {
    userId = String(exists._id);
  } else {
    const res = await usersCol.insertOne({
      name: from.first_name + (from.username ? ` (@${from.username})` : ""),
      email,
      password_hash: null,
      source: "telegram",
      created_at: new Date(),
    });
    userId = String(res.insertedId);
  }

  await col.insertOne({
    telegram_id: from.id,
    first_name: from.first_name,
    username: from.username,
    user_id: userId,
    created_at: new Date(),
  });

  return { userId, isNew: true };
}

async function getActiveApiKeys(userId: string) {
  const db = await getDb();
  return db
    .collection("api_keys")
    .find({ user_id: userId, is_active: true })
    .sort({ created_at: -1 })
    .toArray();
}

async function createApiKeyForUser(userId: string, name: string) {
  const db = await getDb();
  const { key, prefix, suffix, hash } = generateApiKey();
  await db.collection("api_keys").insertOne({
    user_id: userId,
    name,
    key_prefix: prefix,
    key_suffix: suffix,
    key_hash: hash,
    is_active: true,
    usage_count: 0,
    last_used_at: null,
    created_at: new Date(),
  });
  return { key, prefix, suffix };
}

async function revokeAllKeysForUser(userId: string) {
  const db = await getDb();
  return db.collection("api_keys").updateMany(
    { user_id: userId, is_active: true },
    { $set: { is_active: false } },
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getApiBaseUrl(): string {
  if (process.env["BASE_URL"]) return process.env["BASE_URL"].replace(/\/$/, "");
  if (process.env["REPLIT_DOMAINS"]) return `https://${process.env["REPLIT_DOMAINS"].split(",")[0]!.trim()}`;
  if (process.env["REPLIT_DEV_DOMAIN"]) return `https://${process.env["REPLIT_DEV_DOMAIN"]}`;
  return "http://localhost:5000";
}

// ── Message templates ────────────────────────────────────────────────────────

function welcomeText(firstName: string): string {
  const base = getApiBaseUrl();
  return (
    `👋 <b>Selamat datang, ${escHtml(firstName)}!</b>\n\n` +
    `Saya <b>Dzeck Gateway Bot</b> — asisten untuk mengelola akses ke <b>Qwen AI Gateway</b>.\n\n` +
    `<b>🌐 Base URL API:</b>\n<code>${base}</code>\n\n` +
    `<b>Yang bisa saya lakukan:</b>\n` +
    `• 🔑 Generate &amp; kelola API key Anda\n` +
    `• 📊 Cek status penggunaan\n` +
    `• 🔄 Regenerate key kapan saja\n\n` +
    `Gunakan tombol di bawah atau ketik <code>/help</code> untuk melihat semua perintah.`
  );
}

function helpText(): string {
  const base = getApiBaseUrl();
  return (
    `<b>📋 Daftar Perintah</b>\n\n` +
    `<b>API Key</b>\n` +
    `• /apikey — Lihat atau buat API key Anda\n` +
    `• /newkey — Generate API key baru (menonaktifkan yang lama)\n` +
    `• /mykeys — Lihat semua key aktif &amp; statistik\n\n` +
    `<b>Informasi</b>\n` +
    `• /status — Status server &amp; pool token\n` +
    `• /start — Menu utama\n` +
    `• /help — Tampilkan pesan ini\n\n` +
    `<b>🌐 Base URL API:</b>\n<code>${base}</code>\n\n` +
    `<b>💡 Cara pakai:</b>\n` +
    `<code>Authorization: Bearer sk-dzcx...</code>\n` +
    `<code>POST ${base}/v1/chat/completions</code>`
  );
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ── Command handlers ─────────────────────────────────────────────────────────

async function handleStart(chatId: number, from: TgUser): Promise<void> {
  await sendMessage(chatId, welcomeText(from.first_name), {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "🔑 API Key Saya", callback_data: "cmd:apikey" },
          { text: "📊 Status", callback_data: "cmd:status" },
        ],
        [
          { text: "📋 Semua Key", callback_data: "cmd:mykeys" },
          { text: "❓ Bantuan", callback_data: "cmd:help" },
        ],
      ],
    },
  });
}

async function handleApiKey(chatId: number, from: TgUser): Promise<void> {
  try {
    const { userId, isNew } = await getOrCreateTelegramUser(from);
    const keys = await getActiveApiKeys(userId);

    if (keys.length === 0) {
      // Auto-generate first key
      const { key } = await createApiKeyForUser(userId, "Telegram Key");
      const base = getApiBaseUrl();
      await sendMessage(
        chatId,
        `🎉 <b>API key berhasil dibuat!</b>\n\n` +
          `<b>Key Anda:</b>\n<code>${key}</code>\n\n` +
          `⚠️ <b>Simpan key ini sekarang</b> — tidak akan ditampilkan lagi.\n\n` +
          `<b>🌐 Base URL:</b>\n<code>${base}</code>\n\n` +
          `<b>Cara pakai:</b>\n` +
          `<code>Authorization: Bearer ${key}</code>\n` +
          `<code>POST ${base}/v1/chat/completions</code>`,
        {
          parse_mode: "HTML",
          disable_web_page_preview: true,
          reply_markup: {
            inline_keyboard: [
              [{ text: "🔄 Generate Key Baru", callback_data: "cmd:newkey" }],
            ],
          },
        },
      );
    } else {
      const k = keys[0]!;
      const lastUsed = k.last_used_at
        ? new Date(k.last_used_at).toLocaleDateString("id-ID")
        : "Belum pernah";
      await sendMessage(
        chatId,
        `🔑 <b>API Key Aktif</b>\n\n` +
          `<b>Nama:</b> ${escHtml(String(k.name))}\n` +
          `<b>Prefix:</b> <code>${k.key_prefix}...</code>\n` +
          `<b>Suffix:</b> <code>...${k.key_suffix}</code>\n` +
          `<b>Pemakaian:</b> ${k.usage_count ?? 0} request\n` +
          `<b>Terakhir digunakan:</b> ${lastUsed}\n\n` +
          `${keys.length > 1 ? `📦 Total key aktif: <b>${keys.length}</b>\n\n` : ""}` +
          `ℹ️ Key lengkap tidak dapat ditampilkan ulang demi keamanan.\n` +
          `Gunakan /newkey untuk membuat key baru.`,
        {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [
                { text: "🔄 Key Baru", callback_data: "cmd:newkey" },
                { text: "📊 Semua Key", callback_data: "cmd:mykeys" },
              ],
            ],
          },
        },
      );
    }
  } catch (err) {
    logger.error({ err }, "handleApiKey error");
    await sendMessage(chatId, "❌ Terjadi kesalahan. Coba lagi nanti.");
  }
}

async function handleNewKey(chatId: number, from: TgUser): Promise<void> {
  try {
    const { userId } = await getOrCreateTelegramUser(from);

    // Revoke all existing keys for this user
    await revokeAllKeysForUser(userId);

    // Generate new key
    const { key } = await createApiKeyForUser(userId, "Telegram Key");
    const base = getApiBaseUrl();

    await sendMessage(
      chatId,
      `✅ <b>API key baru berhasil dibuat!</b>\n\n` +
        `<b>Key lama:</b> dinonaktifkan\n\n` +
        `<b>Key baru Anda:</b>\n<code>${key}</code>\n\n` +
        `⚠️ <b>Simpan key ini sekarang</b> — tidak akan ditampilkan lagi.\n\n` +
        `<b>🌐 Base URL:</b>\n<code>${base}</code>\n\n` +
        `<b>Cara pakai:</b>\n` +
        `<code>Authorization: Bearer ${key}</code>\n` +
        `<code>POST ${base}/v1/chat/completions</code>`,
      {
        parse_mode: "HTML",
        disable_web_page_preview: true,
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔑 Lihat Info Key", callback_data: "cmd:apikey" }],
          ],
        },
      },
    );
  } catch (err) {
    logger.error({ err }, "handleNewKey error");
    await sendMessage(chatId, "❌ Gagal generate key baru. Coba lagi.");
  }
}

async function handleMyKeys(chatId: number, from: TgUser): Promise<void> {
  try {
    const { userId } = await getOrCreateTelegramUser(from);
    const keys = await getActiveApiKeys(userId);

    if (keys.length === 0) {
      await sendMessage(
        chatId,
        "📭 <b>Belum ada API key aktif.</b>\n\nGunakan /apikey untuk membuat key pertama Anda.",
        {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [{ text: "🔑 Buat API Key", callback_data: "cmd:apikey" }],
            ],
          },
        },
      );
      return;
    }

    const lines = keys.map((k, i) => {
      const lastUsed = k.last_used_at
        ? new Date(k.last_used_at).toLocaleDateString("id-ID")
        : "Belum digunakan";
      return (
        `<b>${i + 1}. ${escHtml(String(k.name))}</b>\n` +
        `   Prefix: <code>${k.key_prefix}...</code>\n` +
        `   Pemakaian: ${k.usage_count ?? 0}x | Terakhir: ${lastUsed}\n` +
        `   Dibuat: ${new Date(k.created_at).toLocaleDateString("id-ID")}`
      );
    });

    await sendMessage(
      chatId,
      `📊 <b>API Key Aktif (${keys.length})</b>\n\n${lines.join("\n\n")}`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "🔄 Generate Key Baru", callback_data: "cmd:newkey" },
            ],
          ],
        },
      },
    );
  } catch (err) {
    logger.error({ err }, "handleMyKeys error");
    await sendMessage(chatId, "❌ Gagal mengambil data. Coba lagi.");
  }
}

async function handleStatus(chatId: number): Promise<void> {
  try {
    const db = await getDb();
    const totalKeys = await db.collection("api_keys").countDocuments({ is_active: true });
    const totalUsers = await db.collection("users").countDocuments();
    const tgUsers = await db.collection("telegram_users").countDocuments();

    const uptime = process.uptime();
    const uptimeStr =
      uptime < 60
        ? `${Math.floor(uptime)}d`
        : uptime < 3600
          ? `${Math.floor(uptime / 60)}m`
          : `${Math.floor(uptime / 3600)}j ${Math.floor((uptime % 3600) / 60)}m`;

    const base = getApiBaseUrl();
    await sendMessage(
      chatId,
      `🟢 <b>Status Server</b>\n\n` +
        `<b>Server:</b> Online ✅\n` +
        `<b>Uptime:</b> ${uptimeStr}\n` +
        `<b>Environment:</b> ${process.env["NODE_ENV"] ?? "production"}\n\n` +
        `<b>🌐 Base URL API:</b>\n<code>${base}</code>\n\n` +
        `<b>📊 Statistik Database</b>\n` +
        `• Total pengguna: <b>${totalUsers}</b>\n` +
        `• Pengguna Telegram: <b>${tgUsers}</b>\n` +
        `• API key aktif: <b>${totalKeys}</b>\n\n` +
        `<b>🤖 Model tersedia:</b>\n` +
        `• <code>qwen3-235b-a22b</code>\n` +
        `• <code>qwen3-30b-a3b</code>\n` +
        `• <code>qwen3-7b</code> (fast)\n` +
        `• <code>qwen3.7-plus</code> (image gen)`,
      { parse_mode: "HTML" },
    );
  } catch (err) {
    logger.error({ err }, "handleStatus error");
    await sendMessage(chatId, "❌ Tidak dapat mengambil status server.");
  }
}

async function handleHelp(chatId: number): Promise<void> {
  await sendMessage(chatId, helpText(), {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "🔑 API Key Saya", callback_data: "cmd:apikey" },
          { text: "🏠 Menu Utama", callback_data: "cmd:start" },
        ],
      ],
    },
  });
}

// ── Callback query handler ───────────────────────────────────────────────────

async function handleCallback(query: TgCallbackQuery): Promise<void> {
  const chatId = query.message?.chat.id;
  if (!chatId) return;

  await answerCallbackQuery(query.id);

  const cmd = query.data ?? "";

  if (cmd === "cmd:start") return handleStart(chatId, query.from);
  if (cmd === "cmd:apikey") return handleApiKey(chatId, query.from);
  if (cmd === "cmd:newkey") return handleNewKeyConfirm(chatId, query.from);
  if (cmd === "cmd:newkey:confirm") return handleNewKey(chatId, query.from);
  if (cmd === "cmd:mykeys") return handleMyKeys(chatId, query.from);
  if (cmd === "cmd:status") return handleStatus(chatId);
  if (cmd === "cmd:help") return handleHelp(chatId);
}

async function handleNewKeyConfirm(chatId: number, from: TgUser): Promise<void> {
  await sendMessage(
    chatId,
    `⚠️ <b>Konfirmasi Generate Key Baru</b>\n\n` +
      `Semua API key lama Anda akan <b>dinonaktifkan</b> dan diganti dengan key baru.\n\n` +
      `Lanjutkan?`,
    {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "✅ Ya, Generate Baru", callback_data: "cmd:newkey:confirm" },
            { text: "❌ Batal", callback_data: "cmd:apikey" },
          ],
        ],
      },
    },
  );
}

// ── Main update dispatcher ───────────────────────────────────────────────────

export async function handleUpdate(update: TgUpdate): Promise<void> {
  try {
    if (update.callback_query) {
      return handleCallback(update.callback_query);
    }

    const msg = update.message;
    if (!msg?.text || !msg.from) return;

    const chatId = msg.chat.id;
    const from = msg.from;
    const text = msg.text.trim();

    // Strip bot username suffix (e.g. /start@DzeckBot)
    const cmd = text.split("@")[0]!.toLowerCase();

    if (cmd === "/start") return handleStart(chatId, from);
    if (cmd === "/apikey") return handleApiKey(chatId, from);
    if (cmd === "/newkey") return handleNewKeyConfirm(chatId, from);
    if (cmd === "/mykeys") return handleMyKeys(chatId, from);
    if (cmd === "/status") return handleStatus(chatId);
    if (cmd === "/help") return handleHelp(chatId);

    // Unknown command or plain text
    await sendMessage(
      chatId,
      `ℹ️ Perintah tidak dikenal.\n\nKetik /help untuk melihat daftar perintah yang tersedia.`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "📋 Lihat Bantuan", callback_data: "cmd:help" }],
          ],
        },
      },
    );
  } catch (err) {
    logger.error({ err, update_id: update.update_id }, "handleUpdate error");
  }
}
