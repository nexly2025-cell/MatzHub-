import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

const databaseUrl =
  process.env.DATABASE_URL ||
  "postgresql://postgres:postgres@127.0.0.1:5432/app_db";

const globalForDb = globalThis as typeof globalThis & {
  __matzhubPostgresqlPool?: Pool;
};

/**
 * Issue 3 — shared pg.Pool.
 *
 * Vercel serverless would otherwise open a new client per request and blow
 * past Supabase's ~50 (session-mode 15) connection ceiling. One pool per
 * isolate, max 10, idle 30s. Override with DATABASE_POOL_MAX if a tiny
 * plan needs an even smaller cap.
 *
 * SSL is required by every managed Postgres. `rejectUnauthorized: false` is
 * what Supabase's examples use because the pooler presents an intermediate CA.
 * Set DATABASE_SSL=disable for local Postgres without TLS.
 */
const useSsl = (() => {
  if (process.env.DATABASE_SSL === "disable") return false;
  if (process.env.DATABASE_SSL === "require") return true;
  const url = databaseUrl!;
  if (/^postgres(ql)?:\/\/[^/]*(localhost|127\.0\.0\.1|::1)/.test(url)) return false;
  return true;
})();

export const pool =
  globalForDb.__matzhubPostgresqlPool ??
  new Pool({
    connectionString: databaseUrl,
    max: Number(process.env.DATABASE_POOL_MAX || 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    allowExitOnIdle: true,
    ssl: useSsl ? { rejectUnauthorized: false } : undefined,
  });

// Preserve across warm serverless lambdas as well as dev HMR
globalForDb.__matzhubPostgresqlPool = pool;

export const db = drizzle(pool);
