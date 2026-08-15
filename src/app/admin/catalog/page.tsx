import Image from "next/image";
import Link from "next/link";
import { revalidatePath } from "next/cache";
import { desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { products } from "@/db/schema";
import { inr } from "@/lib/utils";

export const dynamic = "force-dynamic";

async function setCover(formData: FormData) {
  "use server";
  const id = String(formData.get("id"));
  const url = String(formData.get("cover"));
  if (!/^https:\/\//.test(url)) return;
  await db.update(products).set({ heroImage: url, updatedAt: new Date() }).where(eq(products.id, id));
  revalidatePath("/admin/catalog");
}

async function patchProduct(formData: FormData) {
  "use server";
  const id = String(formData.get("id"));
  const action = String(formData.get("action"));
  if (action === "hide") await db.update(products).set({ status: "archived", updatedAt: new Date() }).where(eq(products.id, id));
  if (action === "show") await db.update(products).set({ status: "published", publishedAt: new Date() }).where(eq(products.id, id));
  if (action === "stock") {
    const stock = Math.max(0, Number(formData.get("stockQty")));
    await db.update(products).set({ stockQty: stock, availability: stock === 0 ? "out_of_stock" : stock < 5 ? "low_stock" : "in_stock", updatedAt: new Date() }).where(eq(products.id, id));
  }
  revalidatePath("/admin/catalog");
}

export default async function Catalog({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const status = typeof sp.status === "string" ? sp.status : "published";
  const [items, [{ total }]] = await Promise.all([
    db.select({ id: products.id, slug: products.slug, title: products.title, heroImage: products.heroImage, images: products.images, videoUrl: products.videoUrl, mediaType: products.mediaType, price: products.price, costPrice: products.costPrice, stockQty: products.stockQty, availability: products.availability, trendingScore: products.trendingScore, views: products.views, clicks: products.clicks, orders: products.orders })
      .from(products).where(eq(products.status, status)).orderBy(desc(products.trendingScore)).limit(100),
    db.select({ total: sql<number>`count(*)::int` }).from(products).where(eq(products.status, status)),
  ]);

  return (
    <div className="shell py-8">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="display text-3xl mb-1">Catalogue</h1>
          <p className="text-sm text-muted">{total} in status <code className="text-accent">{status}</code></p>
        </div>
        <div className="flex gap-2">
          {["published", "pending_review", "archived", "draft"].map((st) => (
            <Link key={st} href={`/admin/catalog?status=${st}`} className="chip" data-on={status === st}>{st.replace(/_/g, " ")}</Link>
          ))}
        </div>
      </div>

      <div className="surface overflow-x-auto">
        <table className="w-full min-w-[900px] text-sm">
          <thead className="border-b border-line text-left">
            <tr className="text-[10px] uppercase tracking-widest text-muted">
              {["Product", "Cost", "Selling", "Margin", "Stock", "Availability", "Views", "Clicks", "Orders", ""].map((h) => (
                <th key={h} className="px-4 py-3 font-medium">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {items.map((p) => (
              <tr key={p.id} className="border-b border-line last:border-0">
                <td className="px-4 py-3">
                  <div className="flex items-center gap-3">
                    <div className="relative h-11 w-11 shrink-0 overflow-hidden rounded-md bg-surface-3">
                      <Image src={p.heroImage} alt="" fill sizes="44px" className="object-cover" />
                    </div>
                    <div className="min-w-0">
                      <Link href={`/p/${p.slug}`} className="line-clamp-1 max-w-[240px] hover:text-accent">{p.title}</Link>
                      {p.videoUrl && <span className="chip mt-1 text-[9px]">🎬 video</span>}
                      {p.images.length > 1 && (
                        <div className="mt-1.5 flex gap-1">
                          {p.images.slice(0, 4).map((u) => (
                            <form key={u} action={setCover}>
                              <input type="hidden" name="id" value={p.id} />
                              <input type="hidden" name="cover" value={u} />
                              <button
                                title="Set as cover"
                                className={`relative h-8 w-8 overflow-hidden rounded border ${u === p.heroImage ? "border-[--color-gold]" : "border-transparent opacity-60 hover:opacity-100"}`}
                              >
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img src={u} alt="" className="h-full w-full object-cover" />
                              </button>
                            </form>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </td>
                <td className="px-4 py-3 text-muted">{inr(p.costPrice)}</td>
                <td className="px-4 py-3 text-accent">{inr(p.price)}</td>
                <td className="px-4 py-3 text-xs">15%</td>
                <td className="px-4 py-3">
                  <form action={patchProduct} className="flex items-center gap-1">
                    <input type="hidden" name="id" value={p.id} />
                    <input type="hidden" name="action" value="stock" />
                    <input name="stockQty" defaultValue={p.stockQty} className="w-14 rounded border border-line  px-2 py-1 text-xs" />
                    <button className="rounded border border-line px-2 py-1 text-[10px] hover:border-[--color-mist]">set</button>
                  </form>
                </td>
                <td className="px-4 py-3"><span className={`chip text-[10px] ${p.availability === "out_of_stock" ? "!text-[--color-rose]" : ""}`}>{p.availability}</span></td>
                <td className="px-4 py-3 text-xs text-muted">{p.views}</td>
                <td className="px-4 py-3 text-xs text-muted">{p.clicks}</td>
                <td className="px-4 py-3 text-xs text-muted">{p.orders}</td>
                <td className="px-4 py-3">
                  <form action={patchProduct}>
                    <input type="hidden" name="id" value={p.id} />
                    <input type="hidden" name="action" value={status === "published" ? "hide" : "show"} />
                    <button className={`rounded px-3 py-1 text-[10px] ${status === "published" ? "border border-line hover:border-[--color-rose] hover:text-[--color-rose]" : "bg-[--color-gold] text-black font-semibold"}`}>
                      {status === "published" ? "Hide" : "Publish"}
                    </button>
                  </form>
                </td>
              </tr>
            ))}
            {items.length === 0 && <tr><td colSpan={10} className="px-4 py-12 text-center text-muted">Nothing in <code>{status}</code>.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
