import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/db";

export const dynamic = "force-dynamic";

/**
 * Health probe. Strictly read-only.
 *
 * This endpoint is polled continuously by uptime monitors, load balancers and
 * platform health checks. It previously called seed(), so every poll ran write
 * transactions and, on an empty database, injected six fictitious suppliers and
 * 36 stock-photo products into production. Bootstrapping now happens once via
 * `npm run setup`, never from a GET request.
 */
export async function GET() {
  const t0 = Date.now();
  try {
    await db.execute(sql`select 1`);
    const [{ products: count }] = await db.execute<{ products: number }>(
      sql`select count(*)::int as products from products where status = 'published'`,
    ).then((r) => r.rows as Array<{ products: number }>).then((rows) => [rows[0] ?? { products: 0 }]);

    return NextResponse.json({
      status: "ok",
      database: "connected",
      publishedProducts: count,
      latencyMs: Date.now() - t0,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return NextResponse.json(
      { status: "error", database: "unreachable", error: "database unavailable" },
      { status: 503 },
    );
  }
}
