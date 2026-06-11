import { Router } from "express";
import { getDb } from "../lib/mongo";
import { hashPassword, verifyPassword, signJwt } from "../lib/auth-helpers";
import { requireJwt } from "../middleware/requireJwt";

const router = Router();

// POST /api/auth/register
router.post("/auth/register", async (req, res) => {
  const { name, email, password } = req.body as { name?: string; email?: string; password?: string };
  if (!name || !email || !password) {
    res.status(400).json({ error: "name, email, and password are required" });
    return;
  }
  if (password.length < 6) {
    res.status(400).json({ error: "Password must be at least 6 characters" });
    return;
  }
  try {
    const db = await getDb();
    const exists = await db.collection("users").findOne({ email: email.toLowerCase() });
    if (exists) {
      res.status(409).json({ error: "Email already registered" });
      return;
    }
    const password_hash = await hashPassword(password);
    const result = await db.collection("users").insertOne({
      name,
      email: email.toLowerCase(),
      password_hash,
      created_at: new Date(),
    });
    const userId = String(result.insertedId);
    const token = signJwt({ userId, email: email.toLowerCase(), name });
    res.status(201).json({ token, user: { id: userId, name, email: email.toLowerCase() } });
  } catch (err) {
    req.log.error({ err }, "Register error");
    res.status(500).json({ error: "Registration failed" });
  }
});

// POST /api/auth/login
router.post("/auth/login", async (req, res) => {
  const { email, password } = req.body as { email?: string; password?: string };
  if (!email || !password) {
    res.status(400).json({ error: "email and password are required" });
    return;
  }
  try {
    const db = await getDb();
    const user = await db.collection("users").findOne({ email: email.toLowerCase() });
    if (!user) {
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }
    const ok = await verifyPassword(password, String(user.password_hash));
    if (!ok) {
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }
    const userId = String(user._id);
    const name = String(user.name);
    const token = signJwt({ userId, email: email.toLowerCase(), name });
    res.json({ token, user: { id: userId, name, email: email.toLowerCase() } });
  } catch (err) {
    req.log.error({ err }, "Login error");
    res.status(500).json({ error: "Login failed" });
  }
});

// GET /api/auth/me
router.get("/auth/me", requireJwt, (req, res) => {
  res.json({ user: req.jwtUser });
});

export default router;
