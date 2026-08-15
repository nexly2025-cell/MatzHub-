import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

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
export const pool =
  globalForDb.__arenaNextJsPostgresqlPool ??
  new Pool({
    connectionString: databaseUrl,
    max: Number(process.env.DATABASE_POOL_MAX || 4),
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
    // Supabase terminates idle pooled sessions; do not hold them open.
    allowExitOnIdle: true,
  });

if (process.env.NODE_ENV !== "production") {
  globalForDb.__arenaNextJsPostgresqlPool = pool;
}

export const db = drizzle(pool);
