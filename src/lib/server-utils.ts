import "server-only";
import crypto from "node:crypto";
import { cookies } from "next/headers";

export const ANON_COOKIE = "mh_aid";

export async function ensureAnonId(): Promise<string> {
  const jar = await cookies();
  const existing = jar.get(ANON_COOKIE)?.value;
  if (existing) return existing;
  const id = crypto.randomUUID();
  jar.set(ANON_COOKIE, id, { httpOnly: false, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 365 });
  return id;
}
