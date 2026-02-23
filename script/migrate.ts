import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

async function runMigrations() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to run migrations.");
  }

  const shouldDisableTlsVerification = process.env.PGSSL_NO_VERIFY === "true";
  const connectionString = shouldDisableTlsVerification
    ? (() => {
        const url = new URL(databaseUrl);
        url.searchParams.set("sslmode", "no-verify");
        return url.toString();
      })()
    : databaseUrl;

  const pool = new Pool({
    connectionString,
    ssl: shouldDisableTlsVerification ? { rejectUnauthorized: false } : undefined,
  });
  const db = drizzle(pool);

  await migrate(db, { migrationsFolder: "migrations" });
  await pool.end();
}

runMigrations().catch((error) => {
  console.error("Migration failed:", error);
  process.exit(1);
});
