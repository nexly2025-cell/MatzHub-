import "dotenv/config";
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    // DDL needs session mode. Supabase's transaction pooler (:6543) cannot run
    // schema changes, so migrations use DIRECT_DATABASE_URL when it is set.
    url: process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL!,
  },
});
