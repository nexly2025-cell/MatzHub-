import Image from "next/image";
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, opsTasks, products } from "@/db/schema";
import { getPendingProducts } from "@/lib/queries";
import { retireProductAlert } from "@/lib/notify";
import { toPublicMediaUrl } from "@/lib/storage";
import { inr } from "@/lib/utils";

export const dynamic = "force-dynamic";

async function decide(formData: FormData) {
  "use server";
  const id = String(formData.get("id"));
  const action = String(formData.get("action"));
  const patch =
    action === "approve"
      ? { status: "published", publishedAt: new Date(), updatedAt: new Date() }
      : { status: "rejected", moderationReason: "Rejected in review queue", updatedAt: new Date() };

  await db.update(products).set(patch).where(eq(products.id, id));
  await db.update(opsTasks).set({ status: "resolved", resolvedAt: new Date() }).where(eq(opsTasks.entityId, id));
  await db.insert(auditLog).values({ actor: "ops", action: `product.${action}`, entityType: "product", entityId: id });
  // The decision exists, so the Telegram alert that asked for it is retired.
  // This is what keeps the admin chat clear without deleting anything the
  // operator has not acted on yet.
  await retireProductAlert(id);
  revalidatePath("/admin/moderation");
  revalidatePath("/admin");
}

export default async function Moderation() {
  const items = await getPendingProducts();
  return (
    <div className="shell py-8">
      <h1 className="display text-3xl mb-1">Review queue</h1>
      <p className="mb-8 text-sm text-muted">
        {items.length} products the pipeline was not confident enough to publish on its own. Everything else already went live.
      </p>

      {items.length === 0 ? (
        <div className="surface p-12 text-center">
          <p className="display text-xl text-[--color-jade]">Nothing to review</p>
          <p className="mt-1 text-sm text-muted">Auto-publish handled 100% of today&apos;s intake.</p>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {items.map((p) => (
            <article key={p.id} className="surface flex gap-4 p-4">
              <div className="relative h-28 w-28 shrink-0 overflow-hidden rounded-lg bg-surface-3">
                {p.heroImage ? <Image src={toPublicMediaUrl(p.heroImage) || p.heroImage} alt="" fill sizes="112px" className="object-cover" /> : <div className="grid h-full place-items-center text-[10px] text-[--color-rose]">no image</div>}
              </div>
              <div className="min-w-0 flex-1">
                <h2 className="line-clamp-2 text-sm font-medium">{p.title}</h2>
                <p className="mt-1 text-xs text-muted">
                  {inr(p.price)} · cost {inr(p.costPrice)} · margin {p.marginPercent.toFixed(0)}%
                </p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <span className={`chip text-[10px] ${p.qualityScore < 50 ? "!text-[--color-rose] !border-[--color-rose]" : ""}`}>quality {p.qualityScore.toFixed(0)}</span>
                  <span className="chip text-[10px]">confidence {(p.confidence * 100).toFixed(0)}%</span>
                  {!p.heroImage && <span className="chip text-[10px] !text-[--color-rose]">no image</span>}
                  {p.moderationReason && <span className="chip text-[10px] !text-[--color-rose] !border-[--color-rose]">{p.moderationReason}</span>}
                </div>
                <div className="mt-3 flex gap-2">
                  <form action={decide}>
                    <input type="hidden" name="id" value={p.id} />
                    <input type="hidden" name="action" value="approve" />
                    <button className="btn btn-primary px-4 py-2 text-xs">Publish</button>
                  </form>
                  <form action={decide}>
                    <input type="hidden" name="id" value={p.id} />
                    <input type="hidden" name="action" value="reject" />
                    <button className="btn btn-ghost px-4 py-2 text-xs">Reject</button>
                  </form>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
