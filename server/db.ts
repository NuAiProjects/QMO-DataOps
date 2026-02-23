import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "@shared/schema";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required.");
}

const shouldDisableTlsVerification = process.env.PGSSL_NO_VERIFY === "true";

function getConnectionString() {
  if (!shouldDisableTlsVerification) {
    return process.env.DATABASE_URL as string;
  }

  const url = new URL(process.env.DATABASE_URL as string);
  url.searchParams.set("sslmode", "no-verify");
  return url.toString();
}

export const pool = new Pool({
  connectionString: getConnectionString(),
  ssl: shouldDisableTlsVerification ? { rejectUnauthorized: false } : undefined,
});

export const db = drizzle(pool, { schema });
