import { Router } from "express";
import { handleUpdate } from "../lib/telegram-bot";
import { setWebhook, getWebhookInfo, isBotAvailable } from "../lib/telegram";
import { logger } from "../lib/logger";

const router = Router();

// POST /telegram/webhook — receives updates from Telegram
router.post("/telegram/webhook", async (req, res) => {
  // Respond immediately so Telegram doesn't retry
  res.sendStatus(200);

  const update = req.body;
  if (!update?.update_id) return;

  await handleUpdate(update).catch((err) => {
    logger.error({ err }, "Unhandled error in Telegram update handler");
  });
});

// GET /telegram/webhook/info — debug endpoint (no auth needed for health checks)
router.get("/telegram/webhook/info", async (_req, res) => {
  if (!isBotAvailable()) {
    res.json({ available: false, reason: "TELEGRAM_BOT_TOKEN not set" });
    return;
  }
  try {
    const info = await getWebhookInfo();
    res.json({ available: true, ...info });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// POST /telegram/webhook/register — manually trigger webhook registration
router.post("/telegram/webhook/register", async (req, res) => {
  if (!isBotAvailable()) {
    res.status(400).json({ error: "TELEGRAM_BOT_TOKEN not set" });
    return;
  }
  const { url } = req.body as { url?: string };
  const webhookUrl = url ?? buildWebhookUrl();
  if (!webhookUrl) {
    res.status(400).json({ error: "Cannot determine webhook URL. Pass { url } in body." });
    return;
  }
  try {
    await setWebhook(webhookUrl);
    logger.info({ webhookUrl }, "Telegram webhook registered via API");
    res.json({ ok: true, webhookUrl });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

export function buildWebhookUrl(): string | null {
  // BASE_URL always wins (manually set, e.g. production domain)
  if (process.env["BASE_URL"]) {
    const base = process.env["BASE_URL"].replace(/\/$/, "");
    return `${base}/api/telegram/webhook`;
  }

  // In Replit Autoscale/deployment, REPLIT_DEPLOYMENT=1 and REPLIT_DOMAINS has the prod domain
  if (process.env["REPLIT_DEPLOYMENT"] === "1" && process.env["REPLIT_DOMAINS"]) {
    const domain = process.env["REPLIT_DOMAINS"].split(",")[0]!.trim();
    return `https://${domain}/api/telegram/webhook`;
  }

  // Dev environment — skip auto-registration, webhook managed manually
  return null;
}

export async function registerWebhookOnStartup(): Promise<void> {
  if (!isBotAvailable()) {
    logger.info("Telegram bot token not set — skipping webhook registration");
    return;
  }
  const webhookUrl = buildWebhookUrl();
  if (!webhookUrl) {
    // Dev environment: don't overwrite the production webhook URL
    logger.info(
      "Dev environment — skipping Telegram webhook auto-registration. " +
        "Set BASE_URL env var to force registration.",
    );
    return;
  }
  try {
    await setWebhook(webhookUrl);
    logger.info({ webhookUrl }, "Telegram webhook registered");
  } catch (err) {
    logger.warn({ err }, "Failed to register Telegram webhook — bot may not receive messages");
  }
}

export default router;
