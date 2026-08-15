import { defineConfig } from "vitest/config";
import path from "node:path";

// Server-only modules throw in the test client env; mock the boundary.
export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    // src/db builds a pg Pool at import time (it does not connect eagerly).
    // Modules under test import it transitively, so give it a parseable URL.
    env: { DATABASE_URL: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/app_db" },
    alias: [{ find: "server-only", replacement: path.resolve(__dirname, "src/lib/__mocks__/server-only.ts") }],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
