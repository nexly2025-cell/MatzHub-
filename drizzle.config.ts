import "dotenv/config";
import { defineConfig } from "drizzle-kit";

const url = process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL!;
// Managed Postgres (Supabase, Neon, RDS) requires SSL. Skip only for a local
// socket where TLS isn't configured.
const useSsl =
  process.env.DATABASE_SSL !== "disable" &&
  !/^postgres(ql)?:\/\/[^/]*(localhost|127\.0\.0\.1|::1)/.test(url);

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    // DDL needs session mode. Supabase's transaction pooler (:6543) cannot run
    // schema changes, so migrations use DIRECT_DATABASE_URL when it is set.
    url,
    ssl: useSsl ? { rejectUnauthorized: false } : false,
  },
});
