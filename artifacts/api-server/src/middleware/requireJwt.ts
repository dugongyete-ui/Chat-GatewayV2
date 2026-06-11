import type { Request, Response, NextFunction } from "express";
import { verifyJwt, type JwtPayload } from "../lib/auth-helpers";

declare global {
  namespace Express {
    interface Request {
      jwtUser?: JwtPayload;
    }
  }
}

export function requireJwt(req: Request, res: Response, next: NextFunction): void {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Authorization header required" });
    return;
  }
  const token = auth.slice(7);
  try {
    req.jwtUser = verifyJwt(token);
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}
