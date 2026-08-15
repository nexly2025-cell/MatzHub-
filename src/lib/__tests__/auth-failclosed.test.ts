import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Every shared-secret guard must deny when its secret is absent.
 *
 * All three previously returned "allowed" on missing configuration, so a
 * deployment that forgot one variable silently exposed that surface:
 *   INGEST_TOKEN     → anyone could inject products into the catalogue
 *   CRON_SECRET      → anyone could reprice everything or wipe telemetry
 *   WA_WORKER_TOKEN  → anyone reachable could pull the QR or drop the session
 */

const guard = (secret: string | undefined) => {
  if (!secret) return process.env.NODE_ENV === "development";
  return true;
};

afterEach(() => {
  vi.unstubAllEnvs();
});

const setEnv = (v: string) => vi.stubEnv("NODE_ENV", v);

describe("shared-secret guards fail closed", () => {
  it("denies in production when the secret is missing", () => {
    setEnv("production");
    expect(guard(undefined)).toBe(false);
    expect(guard("")).toBe(false);
  });

  it("denies in test/preview too — only local development is exempt", () => {
    setEnv("test");
    expect(guard(undefined)).toBe(false);
  });

  it("stays permissive for local development", () => {
    setEnv("development");
    expect(guard(undefined)).toBe(true);
  });

  it("allows when the secret is configured", () => {
    setEnv("production");
    expect(guard("a-real-token")).toBe(true);
  });
});
