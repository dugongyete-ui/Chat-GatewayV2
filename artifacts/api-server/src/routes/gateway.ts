import { Router } from "express";
import { getHistory, clearHistory, getStats } from "../lib/stats";

const router = Router();

// ── Routes ───────────────────────────────────────────────────────────────────

// GET /api/gateway/history
router.get("/gateway/history", async (req, res) => {
  const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
  res.json(await getHistory(limit));
});

// DELETE /api/gateway/history
router.delete("/gateway/history", async (_req, res) => {
  res.json({ cleared: await clearHistory() });
});

// GET /api/gateway/stats
router.get("/gateway/stats", async (_req, res) => {
  res.json(await getStats());
});

export default router;
