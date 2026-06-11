import type { Request, Response, NextFunction } from "express";
import { hashApiKey } from "../lib/auth-helpers";
import { getDb } from "../lib/mongo";

declare global {
  namespace Express {
    interface Request {
      apiKeyDoc?: { id: string; userId: string; name: string };
    }
  }
}

export async function requireApiKey(req: Request, res: Response, next: NextFunction): Promise<void> {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) {
    res.status(401).json({
      error: {
        message: "You didn't provide an API key. Include it in the Authorization header: Authorization: Bearer YOUR_API_KEY",
        type: "invalid_request_error",
        param: null,
        code: "missing_api_key",
      },
    });
    return;
  }
  const key = auth.slice(7);
  if (!key.startsWith("sk-dzcx")) {
    res.status(401).json({
      error: {
        message: `Incorrect API key provided: ${key.slice(0, 8)}...`,
        type: "invalid_request_error",
        param: null,
        code: "invalid_api_key",
      },
    });
    return;
  }
  try {
    const db = await getDb();
    const hash = hashApiKey(key);
    const doc = await db.collection("api_keys").findOne({ key_hash: hash, is_active: true });
    if (!doc) {
      res.status(401).json({
        error: {
          message: `Incorrect API key provided: ${key.slice(0, 8)}...`,
          type: "invalid_request_error",
          param: null,
          code: "invalid_api_key",
        },
      });
      return;
    }
    req.apiKeyDoc = { id: String(doc._id), userId: String(doc.user_id), name: String(doc.name) };
    void db.collection("api_keys").updateOne(
      { _id: doc._id },
      { $inc: { usage_count: 1 }, $set: { last_used_at: new Date() } }
    );
    next();
  } catch (err) {
    res.status(500).json({
      error: {
        message: "Internal server error while validating API key",
        type: "api_error",
        param: null,
        code: "internal_error",
      },
    });
  }
}
