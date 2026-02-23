import type { Request, Response, NextFunction } from "express";
import type { UserRole } from "@shared/schema";
import { getDevUser } from "../dev-auth";

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (req.user) {
    return next();
  }
  const devUser = await getDevUser();
  if (devUser) {
    req.user = devUser;
    return next();
  }
  return res.status(401).json({ message: "Not authenticated." });
}

export function requireRole(roles: UserRole[]) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      const devUser = await getDevUser();
      if (devUser) {
        req.user = devUser;
      }
    }
    if (!req.user) {
      return res.status(401).json({ message: "Not authenticated." });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ message: "Insufficient permissions." });
    }
    return next();
  };
}

export function requireAnyRoleOrSuperAdmin(roles: UserRole[]) {
  return requireRole(["super_admin", ...roles]);
}
