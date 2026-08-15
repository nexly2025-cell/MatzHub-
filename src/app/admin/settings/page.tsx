import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, settings } from "@/db/schema";

export const dynamic = "force-dynamic";

const MODULES = [
  { key: "selling_margin_percent", label: "Selling margin (%)", help: "Cost markup for the live selling price. Global; applies on the next reprice.", current: "15" },
  { key: "original_markup_percent", label: "Original markup (%)", help: "Display markup for the struck-through original price.", current: "40" },
  { key: "free_shipping_threshold", label: "Free shipping threshold (₹)", help: "Order minimum for free shipping. Currently static in code.", current: "999" },
  { key: "auto_publish_quality_floor", label: "Auto-publish quality floor", help: "Products below this quality score wait for review instead of auto-publishing.", current: "55" },
  { key: "auto_publish_confidence_floor", label: "Auto-publish confidence floor", help: "Products below this AI confidence wait for review (0-100 scale maps to 0-1).", current: "60" },
  { key: "product_expiry_days", label: "Product expiry (days)", help: "Products auto-archive after this many days unless reconfirmed by the supplier.", current: "45" },
];

async function save(formData: FormData) {
  "use server";
  const key = String(formData.get("key"));
  const value = String(formData.get("value") ?? "");
  if (!key || !value.trim()) return;
  await db.insert(settings).values({ key, value: value.trim() }).onConflictDoUpdate({ target: settings.key, set: { value: value.trim(), updatedAt: new Date() }});
  await db.insert(auditLog).values({ actor: "ops", action: "settings.updated", entityType: "setting", after: { key, value: value.trim() } });
  revalidatePath("/admin/settings");
}

export default async function AdminSettings() {
  const rows = await db.select().from(settings).where(eq(settings.key, "selling_margin_percent"));
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  return (
    <div className="shell max-w-2xl py-8">
      <h1 className="display text-3xl mb-1">Settings</h1>
      <p className="mb-8 text-sm text-muted">
        Global business rules. Changes apply to products created after saving; run <code className="text-accent">/api/cron/reprice</code> to reprice existing products.
      </p>

      <div className="space-y-3">
        {MODULES.map((m) => {
          const current = byKey.get(m.key) ?? m.current;
          return (
            <form key={m.key} action={save} className="surface p-5">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <label htmlFor={`f-${m.key}`} className="block text-sm font-medium">{m.label}</label>
                  <p className="mt-0.5 text-xs leading-relaxed text-muted">{m.help}</p>
                </div>
                <div className="flex items-center gap-2">
                  <input type="hidden" name="key" value={m.key} />
                  <input
                    id={`f-${m.key}`}
                    name="value"
                    defaultValue={current}
                    className="w-24 rounded-lg border border-line  px-3 py-2 text-right text-sm"
                    required
                  />
                  <button className="btn btn-primary px-4 py-2 text-xs">Save</button>
                </div>
              </div>
            </form>
          );
        })}
      </div>

      <div className="surface mt-8 p-6">
        <h2 className="eyebrow mb-4">Business pricing rule</h2>
        <dl className="grid gap-2.5 text-sm">
          <div className="flex justify-between">
            <dt className="text-muted">Original price shown struck-through</dt>
            <dd className="font-mono">Cost × 1.40</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted">Selling price (live)</dt>
            <dd className="font-mono text-accent">Cost × 1.15</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted">Margin on every product</dt>
            <dd className="font-mono">15%</dd>
          </div>
        </dl>
        <p className="mt-4 text-xs leading-relaxed text-subtle">
          These are locked in code (<code className="text-accent">src/lib/ai.ts</code>). Changing margin here
          sets the default for new products. Changing the 15% factor requires a code edit — it&rsquo;s a core business rule,
          not a preference.
        </p>
      </div>
    </div>
  );
}
