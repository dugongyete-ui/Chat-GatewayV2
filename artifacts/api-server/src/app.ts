import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import path from "node:path";
import { existsSync } from "node:fs";
import router from "./routes";
import v1Router from "./routes/v1";
import telegramRouter from "./routes/telegram";
import { logger } from "./lib/logger";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

app.use("/api", router);
app.use("/api", telegramRouter);
app.use("/v1", v1Router);

// Serve React frontend (built by Vite into dist/public)
const staticDir = path.join(__dirname, "public");
if (existsSync(staticDir)) {
  app.use(express.static(staticDir));
  // SPA fallback — use middleware (not route) so Express 5 path-to-regexp is not involved
  app.use((_req, res) => {
    res.sendFile(path.join(staticDir, "index.html"));
  });
} else {
  // No frontend build present — show API info
  app.get("/", (_req, res) => {
    res.json({
      name: "Qwen API Gateway",
      version: "1.0.0",
      status: "ok",
      docs: "https://platform.openai.com/docs/api-reference",
      endpoints: {
        chat: "POST /v1/chat/completions",
        images: "POST /v1/images/generations",
        models: "GET /v1/models",
        health: "GET /api/healthz",
        register: "POST /api/auth/register",
        login: "POST /api/auth/login",
        apikeys: "GET/POST /api/apikeys",
      },
    });
  });
}

export default app;
