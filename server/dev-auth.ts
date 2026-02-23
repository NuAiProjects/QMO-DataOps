import { db } from "./db";
import { users } from "@shared/schema";
import { eq } from "drizzle-orm";

export async function getDevUser() {
  if (process.env.NODE_ENV === "production") return null;
  if (process.env.DEV_AUTH !== "true") return null;

  const devEmail = process.env.DEV_USER_EMAIL || "admin@qmo.local";
  const [user] = await db.select().from(users).where(eq(users.email, devEmail)).limit(1);
  if (user && user.isActive) {
    return user;
  }

  const [fallback] = await db.select().from(users).limit(1);
  if (fallback && fallback.isActive) {
    return fallback;
  }

  return null;
}
