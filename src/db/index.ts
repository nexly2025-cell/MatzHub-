import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

/**
 * Connection string comes from the environment. Nothing else.
 *
 * A previous revision hardcoded a live Supabase pooler URL *including the
 * password* as a fallback, and additionally rewrote any localhost DATABASE_URL
 * to point at it. That committed a production credential to git and made every
 * local/preview process write to the production database. Both are removed:
 * the credential must be rotated in Supabase and set via DATABASE_URL only.
 */
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

const globalForDb = globalThis as typeof globalThis & {
  __arenaNextJsPostgresqlPool?: Pool;
};

/**
 * Connection pool.
 *
 * `max` matters on managed Postgres behind a pooler. node-postgres defaults to
 * 10 connections per process; a Next.js build spawns several render workers and
 * each serverless instance is its own process, so the default overshoots
 * Supabase's session-mode ceiling (15) and the build dies with
 * `EMAXCONNSESSION: max clients reached in session mode`.
 *
 * Keeping this small is correct rather than merely defensive: queries here are
 * short, and a pooler multiplexes them far better than idle client sockets do.
 *
 * Point DATABASE_URL at the transaction-mode pooler (:6543) for the app and the
 * session-mode pooler (:5432) only for drizzle-kit DDL. No prepared statements
 * are used anywhere in this codebase, so transaction mode is safe.
 */
/**
 * SSL is required by every managed Postgres (Supabase, Neon, RDS).
 * Enable it whenever the URL isn't clearly a local socket. `rejectUnauthorized:
 * false` is what Supabase's own examples use because the pooler presents an
 * intermediate CA that node-postgres doesn't ship in its trust store; it still
 * negotiates TLS, so credentials aren't sent in the clear.
 * Set `DATABASE_SSL=disable` to force it off for local Postgres without TLS.
 */
const useSsl = (() => {
  if (process.env.DATABASE_SSL === "disable") return false;
  if (process.env.DATABASE_SSL === "require") return true;
  const url = databaseUrl!;
  if (/^postgres(ql)?:\/\/[^/]*(localhost|127\.0\.0\.1|::1)/.test(url)) return false;
  return true;
})();

export const pool =
  globalForDb.__arenaNextJsPostgresqlPool ??
  new Pool({
    connectionString: databaseUrl,
    max: Number(process.env.DATABASE_POOL_MAX || 4),
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
    // Supabase terminates idle pooled sessions; do not hold them open.
    allowExitOnIdle: true,
    ssl: useSsl ? { rejectUnauthorized: false } : undefined,
  });

if (process.env.NODE_ENV !== "production") {
  globalForDb.__arenaNextJsPostgresqlPool = pool;
}

export const db = drizzle(pool);
