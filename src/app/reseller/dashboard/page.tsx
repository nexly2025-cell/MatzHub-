import Image from "next/image";
import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { orders, resellerOrders, resellers } from "@/db/schema";
import { RESELLER_COOKIE, verifyResellerToken } from "@/lib/auth";
import { inr, relativeTime } from "@/lib/utils";

export const dynamic = "force-dynamic";
export const metadata = { title: "Reseller dashboard", robots: { index: false, follow: false } };

export default async function ResellerDashboard() {
  const jar = await cookies();
  const resellerId = await verifyResellerToken(jar.get(RESELLER_COOKIE)?.value);
  if (!resellerId) redirect("/reseller/login");

  const [r] = await db.select().from(resellers).where(eq(resellers.id, resellerId)).limit(1);
  if (!r) redirect("/reseller/login");

  const [stats] = await db
    .select({
      margin: sql<number>`coalesce(sum(${resellerOrders.marginINR}),0)::int`,
      count: sql<number>`count(*)::int`,
      revenue: sql<number>`coalesce(sum(${orders.total}),0)::int`,
    })
    .from(resellerOrders)
    .innerJoin(orders, eq(orders.id, resellerOrders.orderId))
    .where(eq(resellerOrders.resellerId, resellerId));

  const recentOrders = await db
    .select({ no: orders.orderNo, total: orders.total, status: orders.status, margin: resellerOrders.marginINR, at: orders.createdAt })
    .from(resellerOrders)
    .innerJoin(orders, eq(orders.id, resellerOrders.orderId))
    .where(eq(resellerOrders.resellerId, resellerId))
    .orderBy(desc(orders.createdAt))
    .limit(15);

  return (
    <div className="shell py-10 lg:py-12">
      <div className="mb-8 flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="eyebrow">Private channel</p>
          <h1 className="font-display text-3xl text-ink">Reseller dashboard</h1>
          <p className="mt-1.5 text-[12.5px] text-muted">
            {r.name} · {r.phone}
            {r.status === "verified" ? " · verified" : ` · status: ${r.status}`} · margin {r.marginPercent}%
          </p>
        </div>
        <div className="flex gap-2">
          {/* /reseller/api/my-catalogue never existed — this button 404'd.
              /products.json is the real published catalogue feed. */}
          <a href="/products.json" target="_blank" rel="noopener noreferrer" className="btn btn-ghost">Catalogue feed</a>
          <Link href="/" className="btn btn-outline">Browse</Link>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="surface p-5">
          <p className="eyebrow mb-2">Your revenue</p>
          <p className="font-display text-2xl text-ink">{inr(stats.revenue)}</p>
        </div>
        <div className="surface p-5">
          <p className="eyebrow mb-2">Your margin</p>
          <p className="font-display text-2xl text-accent">{inr(stats.margin)}</p>
        </div>
        <div className="surface p-5">
          <p className="eyebrow mb-2">Orders attributed</p>
          <p className="font-display text-2xl text-ink">{stats.count}</p>
        </div>
      </div>

      <div className="mt-8 overflow-x-auto rounded-xl border border-line bg-surface">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="border-b border-line">
            <tr className="text-[10px] uppercase tracking-[0.14em] text-muted">
              {["Order", "Total", "Your margin", "Status", "Placed"].map((h) => (
                <th key={h} className="px-4 py-3 text-left font-medium">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {recentOrders.map((o) => (
              <tr key={o.no} className="border-b border-line last:border-0">
                <td className="px-4 py-3 font-mono text-xs">{o.no}</td>
                <td className="px-4 py-3">{inr(o.total)}</td>
                <td className="px-4 py-3 text-accent">{inr(o.margin)}</td>
                <td className="px-4 py-3 text-[11px]">{o.status}</td>
                <td className="px-4 py-3 text-[11px] text-subtle">{relativeTime(o.at)}</td>
              </tr>
            ))}
            {recentOrders.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-10 text-center text-muted">
                  No attributed orders yet. Orders placed with your account land here automatically.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="mt-4 text-[11.5px] text-muted">
        Internal channel only. Customers never see this. Referral code: <code className="text-ink">{r.referralCode ?? "pending"}</code>
      </p>
    </div>
  );
}
