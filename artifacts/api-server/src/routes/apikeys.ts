import { Router } from "express";
import { ObjectId } from "mongodb";
import { requireJwt } from "../middleware/requireJwt";
import { getDb } from "../lib/mongo";
import { generateApiKey } from "../lib/auth-helpers";

const router = Router();

// GET /api/apikeys
router.get("/apikeys", requireJwt, async (req, res) => {
  try {
    const db = await getDb();
    const keys = await db
      .collection("api_keys")
      .find({ user_id: req.jwtUser!.userId, is_active: true })
      .sort({ created_at: -1 })
      .toArray();

    res.json(keys.map(k => ({
      id: String(k._id),
      name: k.name,
      prefix: k.key_prefix,
      suffix: k.key_suffix,
      created_at: k.created_at,
      last_used_at: k.last_used_at ?? null,
      usage_count: k.usage_count ?? 0,
    })));
  } catch (err) {
    req.log.error({ err }, "List API keys error");
    res.status(500).json({ error: "Failed to list API keys" });
  }
});

// POST /api/apikeys
router.post("/apikeys", requireJwt, async (req, res) => {
  const { name = "My API Key" } = req.body as { name?: string };
  try {
    const db = await getDb();
    const count = await db.collection("api_keys").countDocuments({ user_id: req.jwtUser!.userId, is_active: true });
    if (count >= 10) {
      res.status(400).json({ error: "Maximum 10 API keys per account" });
      return;
    }
    const { key, prefix, suffix, hash } = generateApiKey();
    const result = await db.collection("api_keys").insertOne({
      user_id: req.jwtUser!.userId,
      name,
      key_prefix: prefix,
      key_suffix: suffix,
      key_hash: hash,
      is_active: true,
      usage_count: 0,
      last_used_at: null,
      created_at: new Date(),
    });
    res.status(201).json({
      id: String(result.insertedId),
      name,
      key,   // shown ONLY once
      prefix,
      suffix,
      created_at: new Date(),
      usage_count: 0,
    });
  } catch (err) {
    req.log.error({ err }, "Create API key error");
    res.status(500).json({ error: "Failed to create API key" });
  }
});

// DELETE /api/apikeys/:id
router.delete("/apikeys/:id", requireJwt, async (req, res) => {
  try {
    const db = await getDb();
    let oid: ObjectId;
    try { oid = new ObjectId(req.params.id); } catch { res.status(400).json({ error: "Invalid key ID" }); return; }

    const result = await db.collection("api_keys").updateOne(
      { _id: oid, user_id: req.jwtUser!.userId },
      { $set: { is_active: false } }
    );
    if (result.matchedCount === 0) {
      res.status(404).json({ error: "API key not found" });
      return;
    }
    res.json({ revoked: true });
  } catch (err) {
    req.log.error({ err }, "Revoke API key error");
    res.status(500).json({ error: "Failed to revoke API key" });
  }
});

export default router;
