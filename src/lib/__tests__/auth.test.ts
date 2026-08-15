import { afterEach, describe, expect, it, vi } from "vitest";
import { adminPassword, issueToken, verifyAdminToken, verifyResellerToken, verifyToken } from "@/lib/auth";

describe("auth", () => {
  it("issues and verifies an admin token", async () => {
    const t = await issueToken();
    expect(await verifyToken(t)).toBe("ops");
    expect(await verifyAdminToken(t)).toBe(true);
    expect(await verifyResellerToken(t)).toBeNull();
  });

  it("issues and verifies a reseller token", async () => {
    const t = await issueToken("reseller:abc-123");
    expect(await verifyToken(t)).toBe("reseller:abc-123");
    expect(await verifyResellerToken(t)).toBe("abc-123");
    // Critical: a reseller token must never be accepted as admin.
    expect(await verifyAdminToken(t)).toBe(false);
  });

  it("rejects empty, malformed, and tampered tokens", async () => {
    expect(await verifyToken(undefined)).toBeNull();
    expect(await verifyToken("")).toBeNull();
    expect(await verifyToken("only.two")).toBeNull();
    const t = await issueToken();
    // Flip a byte of the signature.
    const tampered = t.slice(0, -1) + (t.at(-1) === "0" ? "1" : "0");
    expect(await verifyToken(tampered)).toBeNull();
    expect(await verifyAdminToken(tampered)).toBe(false);
  });

  it("rejects expired tokens", async () => {
    // Craft a token whose expiry is in the past.
    const past = Math.floor(Date.now() / 1000) - 10;
    const t = await issueToken("ops");
    const parts = t.split(".");
    const expired = `${parts[0]}.${past}.${parts[2]}`;
    expect(await verifyToken(expired)).toBeNull();
  });
});

describe("production refuses guessable admin secrets", () => {
  const saved = { pw: process.env.ADMIN_PASSWORD, sec: process.env.ADMIN_SESSION_SECRET };
  afterEach(() => {
    vi.unstubAllEnvs();
    if (saved.pw) process.env.ADMIN_PASSWORD = saved.pw;
    if (saved.sec) process.env.ADMIN_SESSION_SECRET = saved.sec;
  });

  it("throws rather than signing cookies with a value published in this repo", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ADMIN_SESSION_SECRET", "");
    // issueToken() calls secret(); a fallback here would let anyone who read
    // the source forge a valid ops session.
    await expect(issueToken()).rejects.toThrow(/ADMIN_SESSION_SECRET/);
  });

  it("throws rather than accepting a default admin password", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ADMIN_PASSWORD", "");
    expect(() => adminPassword()).toThrow(/ADMIN_PASSWORD/);
  });

  it("still works locally so development is not blocked", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("ADMIN_PASSWORD", "");
    expect(adminPassword()).toBe("matzhub");
  });
});
