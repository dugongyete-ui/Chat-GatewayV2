import app from "./app";
import { logger } from "./lib/logger";
import { warmPool } from "./lib/umid-pool";
import { registerWebhookOnStartup } from "./routes/telegram";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

process.on("uncaughtException", (err) => {
  logger.error({ err }, "Uncaught exception — server will continue");
});

process.on("unhandledRejection", (reason) => {
  logger.error({ reason }, "Unhandled promise rejection — server will continue");
});

const server = app.listen(port, "0.0.0.0", () => {
  logger.info({ port }, "Server listening on 0.0.0.0");
  if (process.env["QWEN_SESSION_TOKEN"]) {
    logger.info("QWEN_SESSION_TOKEN set — skipping bx-umidtoken pool (using Python WAF bypass)");
  } else {
    warmPool();
  }
  // Register Telegram webhook in background — non-blocking
  registerWebhookOnStartup().catch((err) => {
    logger.warn({ err }, "Telegram webhook registration failed at startup");
  });
});

server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
