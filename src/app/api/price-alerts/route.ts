import { NextResponse } from "next/server";
import { db } from "@/db";
import { priceAlerts } from "@/db/schema";
import { ensureAnonId } from "@/lib/server-utils";

export async function POST(request: Request) {
  const { productId, targetPrice, phone } = (await request.json()) as {
    productId?: string; targetPrice?: number; phone?: string;
  };
  if (!productId || !targetPrice) return NextResponse.json({ ok: false }, { status: 400 });
  const anonId = await ensureAnonId();
  await db.insert(priceAlerts).values({
    productId, anonId, phone: phone?.trim() || null, targetPrice: Math.max(1, Math.round(targetPrice)),
  });
  return NextResponse.json({ ok: true });
}
