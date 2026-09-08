/**
 * Session auth — Edge-compatible HMAC cookies.
 * No database round-trip, works in proxy/middleware, survives restarts.
 *
 * Two separate scopes, two separate cookies. Never conflate them:
 *   ADMIN_COOKIE    ("mh_ops")      → subject "ops",           gates /admin/*
 *   RESELLER_COOKIE ("mh_reseller") → subject "reseller:<id>", gates /reseller/dashboard
 *
 * A reseller token is NEVER accepted as an admin token, and vice versa.
 */

export const ADMIN_COOKIE = "mh_ops";
export const RESELLER_COOKIE = "mh_reseller";
export const CSRF_COOKIE = "mh_ops_csrf";
/** Issue 8 — 24 hour session expiry. */
const TTL_SECONDS = 60 * 60 * 24;

const enc = new TextEncoder();

/**
 * Refuses to run on a guessable secret in production.
 *
 * These previously fell back to ADMIN_PASSWORD and then to a string committed
 * in this file, so a deployment that forgot ADMIN_SESSION_SECRET signed its
 * admin cookies with a value anyone reading the repository already knew — any
 * visitor could forge an ops session. Failing the request is strictly better
 * than serving an unprotected dashboard.
 */
function requireProdSecret(name: string, value: string | undefined): string {
  if (value && value.trim()) return value;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      `${name} is not set. Refusing to run: admin auth would fall back to a publicly known value.`,
    );
  }
  return "matzhub-dev-secret-change-me";
}

function secret(): string {
  return requireProdSecret("ADMIN_SESSION_SECRET", process.env.ADMIN_SESSION_SECRET);
}

async function hmac(payload: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret()), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function issueToken(subject = "ops"): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  // subject must not contain "." — we use base64url for user-supplied ids
  const safeSubject = subject.replace(/\./g, "_");
  const payload = `${safeSubject}.${exp}`;
  return `${payload}.${await hmac(payload)}`;
}

/**
 * Returns the token subject if the token is valid and unexpired, else null.
 * Callers must inspect the subject to decide what scope the token has.
 */
export async function verifyToken(token: string | undefined | null): Promise<string | null> {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [subject, exp, sig] = parts;
  if (!subject || !exp || !sig) return null;
  if (Number(exp) * 1000 < Date.now()) return null;
  const expected = await hmac(`${subject}.${exp}`);
  if (expected.length !== sig.length) return null;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0 ? subject : null;
}

/** True only when the token is a valid ops (admin) session. */
export async function verifyAdminToken(token: string | undefined | null): Promise<boolean> {
  return (await verifyToken(token)) === "ops";
}

/** Returns the reseller id if the token is a valid reseller session, else null. */
export async function verifyResellerToken(token: string | undefined | null): Promise<string | null> {
  const sub = await verifyToken(token);
  if (!sub || !sub.startsWith("reseller:")) return null;
  return sub.slice("reseller:".length);
}

/** The admin login password. Never has a default in production. */
export function adminPassword(): string {
  const pw = process.env.ADMIN_PASSWORD;
  if (pw && pw.trim()) return pw;
  if (process.env.NODE_ENV === "production") {
    throw new Error("ADMIN_PASSWORD is not set. Refusing to run with a default admin password.");
  }
  return "matzhub";
}

async function sha256Hex(value: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(value));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function newCsrfToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Issue 8 — persist an ops session in Postgres. Dynamic import keeps this
 * module Edge-safe for `src/proxy.ts` (HMAC still verifies at the gate).
 */
export async function persistAdminSession(
  token: string,
  csrfToken: string,
  meta?: { ip?: string | null; userAgent?: string | null },
): Promise<void> {
  const { db } = await import("@/db");
  const { adminSessions } = await import("@/db/schema");
  const tokenHash = await sha256Hex(token);
  await db.insert(adminSessions).values({
    tokenHash,
    csrfToken,
    ip: meta?.ip ?? null,
    userAgent: meta?.userAgent ?? null,
    expiresAt: new Date(Date.now() + TTL_SECONDS * 1000),
  });
}

export async function loadAdminSession(token: string | undefined | null) {
  if (!token) return null;
  if (!(await verifyAdminToken(token))) return null;
  const { db } = await import("@/db");
  const { adminSessions } = await import("@/db/schema");
  const { eq } = await import("drizzle-orm");
  const tokenHash = await sha256Hex(token);
  const [row] = await db.select().from(adminSessions).where(eq(adminSessions.tokenHash, tokenHash)).limit(1);
  if (!row) return null;
  if (row.expiresAt.getTime() < Date.now()) {
    await db.delete(adminSessions).where(eq(adminSessions.id, row.id));
    return null;
  }
  await db.update(adminSessions).set({ lastSeenAt: new Date() }).where(eq(adminSessions.id, row.id));
  return row;
}

export async function destroyAdminSession(token: string | undefined | null): Promise<void> {
  if (!token) return;
  const { db } = await import("@/db");
  const { adminSessions } = await import("@/db/schema");
  const { eq } = await import("drizzle-orm");
  await db.delete(adminSessions).where(eq(adminSessions.tokenHash, await sha256Hex(token)));
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
