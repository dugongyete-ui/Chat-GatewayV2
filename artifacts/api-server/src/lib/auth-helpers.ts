import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { createHash, randomBytes } from "crypto";

const JWT_SECRET = process.env["JWT_SECRET"] ?? process.env["SESSION_SECRET"] ?? "dev-secret-change-me";
const JWT_EXPIRES = "7d";

// ── Passwords ────────────────────────────────────────────────────────────────

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

// ── JWT ──────────────────────────────────────────────────────────────────────

export interface JwtPayload {
  userId: string;
  email: string;
  name: string;
}

export function signJwt(payload: JwtPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

export function verifyJwt(token: string): JwtPayload {
  return jwt.verify(token, JWT_SECRET) as JwtPayload;
}

// ── API Keys ─────────────────────────────────────────────────────────────────

const KEY_PREFIX = "sk-dzcx";
const KEY_RANDOM_LEN = 44;

export function generateApiKey(): { key: string; prefix: string; suffix: string; hash: string } {
  const random = randomBytes(33).toString("base64url").slice(0, KEY_RANDOM_LEN);
  const key = `${KEY_PREFIX}${random}`;
  const prefix = key.slice(0, 12);   // "sk-dzcxXXXX"
  const suffix = key.slice(-4);       // last 4 chars
  const hash = hashApiKey(key);
  return { key, prefix, suffix, hash };
}

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}
