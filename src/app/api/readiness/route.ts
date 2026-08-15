import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/db";

/**
 * Readiness — can the process serve traffic? Checks DB connectivity.
 * K8s-style: include this in your readiness probe, not liveness.
 */
export const dynamic = "force-dynamic";
export async function GET() {
  const t0 = Date.now();
  try {
    await db.execute(sql`select 1`);
    const [{ published }] = await db
      .execute<{ published: number }>(sql`select count(*)::int as published from products where status='published'`)
      .then((r) => r.rows);
    return NextResponse.json({ status: "ready", products: published, latencyMs: Date.now() - t0 });
  } catch (error) {
    return NextResponse.json({ status: "not-ready", error: error instanceof Error ? error.message : "db unavailable" }, { status: 503 });
  }
}
