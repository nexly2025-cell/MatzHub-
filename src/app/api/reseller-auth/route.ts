import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { resellers, users } from "@/db/schema";
import { RESELLER_COOKIE, issueToken } from "@/lib/auth";
import { clientKey, rateLimit } from "@/lib/rate-limit";

const sha = (v: string) => crypto.createHash("sha256").update(v).digest("hex");

/** POST { phone, name?, gst?, otp? } — verify + create reseller identity + issue scoped token */
export async function POST(request: Request) {
  const limit = rateLimit(`reseller-auth:${clientKey(request)}`, { max: 5, windowMs: 60000 });
  if (!limit.ok) return NextResponse.json({ ok: false, error: "Too many attempts" }, { status: 429 });

  const body = (await request.json()) as { phone?: string; name?: string; gst?: string; otp?: string };
  const { phone, name, gst } = body;
  if (!phone || !/^\d{10,13}$/.test(phone.replace(/\D/g, ""))) {
    return NextResponse.json({ ok: false, error: "Valid Indian phone number required" }, { status: 400 });
  }
  const phoneRef = phone.replace(/\D/g, "");

  // Dev bootstrap path: first reseller can self-onboard without an OTP service configured.
  const requireOtp = Boolean(process.env.TWILIO_AUTH_TOKEN || process.env.TEXT_LOCAL_KEY);
  if (requireOtp) {
    const { otpCodes } = await import("@/db/schema");
    const [code] = await db.select().from(otpCodes).where(eq(otpCodes.phone, phoneRef)).orderBy(sql`created_at desc`).limit(1).catch(() => []);
    if (!code || code.codeHash !== sha(body.otp ?? "")) return NextResponse.json({ ok: false, error: "Invalid OTP" }, { status: 401 });
    await db.update(otpCodes).set({ consumedAt: new Date() }).where(eq(otpCodes.id, code.id));
  }

  const [existing] = await db.select().from(resellers).where(eq(resellers.phone, phoneRef)).limit(1);
  let resellerId = existing?.id;
  if (!resellerId) {
    const [created] = await db
      .insert(resellers)
      .values({ phone: phoneRef, name: name?.trim() || "Reseller", gst: gst?.trim() || null })
      .returning({ id: resellers.id });
    resellerId = created.id;
  }

  const [identity] = await db.select().from(users).where(eq(users.phone, phoneRef)).limit(1);
  if (!identity) {
    await db.insert(users).values({
      phone: phoneRef,
      name: name?.trim() || null,
      role: "reseller",
      referralCode: `R-${crypto.randomBytes(4).toString("hex").toUpperCase()}`,
    }).catch(() => undefined);
  }

  const token = await issueToken(`reseller:${resellerId}`);
  const res = NextResponse.json({ ok: true, resellerId, scope: "reseller" });
  res.cookies.set(RESELLER_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 12,
  });
  return res;
}
