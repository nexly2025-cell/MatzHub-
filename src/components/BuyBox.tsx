"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { getWishlist, pushRecent, subscribe, toggleWishlist, track } from "@/lib/client-store";
import { SITE, inr, savePercent, waLink } from "@/lib/utils";

type P = {
  id: string;
  slug: string;
  title: string;
  subtitle: string | null;
  heroImage: string;
  price: number;
  mrp: number;
  availability: string;
  stockQty: number;
  ratingAvg: number;
  ratingCount: number;
  brand: string | null;
  sku: string;
};

export default function BuyBox({
  product: p,
  variants,
  shareKit,
}: {
  product: P;
  variants: Array<{ id: string; label: string; stockQty: number }>;
  shareKit?: React.ReactNode;
}) {
  const [variant, setVariant] = useState(variants[0]?.label ?? "");
  const [qty, setQty] = useState(1);
  const [saved, setSaved] = useState(false);
  const [alertOpen, setAlertOpen] = useState(false);
  const [alertPrice, setAlertPrice] = useState(Math.round(p.price * 0.85));
  const [alertDone, setAlertDone] = useState(false);

  const off = savePercent(p.mrp, p.price);
  const soldOut = p.availability === "out_of_stock";
  const line = {
    productId: p.id,
    slug: p.slug,
    title: p.title,
    image: p.heroImage,
    price: p.price,
    mrp: p.mrp,
    variant: variant || undefined,
  };

  useEffect(() => {
    pushRecent(p.id);
    track("view_item", { productId: p.id, value: p.price });
    const sync = () => setSaved(getWishlist().includes(p.id));
    sync();
    return subscribe(sync) as unknown as () => void;
  }, [p.id, p.price]);

  const wishToggle = () => {
    const on = toggleWishlist(p.id);
    setSaved(on);
    track(on ? "add_to_wishlist" : "remove_from_wishlist", { productId: p.id });
  };

  const submitAlert = async () => {
    try {
      await fetch("/api/price-alerts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productId: p.id, targetPrice: alertPrice }),
      });
    } catch {
      /* alert persistence optional */
    }
    setAlertDone(true);
    track("create_price_alert", { productId: p.id, value: alertPrice });
  };

  return (
    <aside className="lg:sticky lg:top-20 lg:self-start">
      <div className="rounded-xl border border-line bg-surface p-6">
        {p.brand && <p className="eyebrow mb-1.5">{p.brand}</p>}
        <h1 className="font-display text-[clamp(1.55rem,3vw,2.15rem)] leading-[1.05] text-ink">{p.title}</h1>
        {p.subtitle && <p className="mt-1.5 text-[12.5px] uppercase tracking-[0.1em] text-subtle">{p.subtitle}</p>}
        {p.ratingCount > 0 && (
          <p className="mt-3 text-[12.5px] text-muted">
            <span className="text-accent">★ {p.ratingAvg.toFixed(1)}</span> · {p.ratingCount} verified {p.ratingCount === 1 ? "review" : "reviews"}
          </p>
        )}

        <div className="mt-5">
          <div className="flex flex-wrap items-baseline gap-3">
            <p className="font-display text-[34px] leading-none text-ink">{inr(p.price)}</p>
            {off > 0 && (
              <>
                <span className="text-[13px] text-subtle line-through">{inr(p.mrp)}</span>
                <span className="rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-accent" style={{ background: "var(--c-accent-soft)" }}>
                  Save {off}%
                </span>
              </>
            )}
          </div>
          <p className="mt-2 text-[11.5px] text-muted">
            The small line shows conventional retail for a comparable piece. The green number is yours.
          </p>
          <p className="mt-1.5 text-[12px] text-muted">
            Taxes included · {p.price >= 999 ? "courier free pan-India" : "₹59 courier"}
          </p>
        </div>

        {variants.length > 1 && (
          <fieldset className="mt-5">
            <legend className="eyebrow mb-2.5">Size</legend>
            <div className="flex flex-wrap gap-2">
              {variants.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => setVariant(v.label)}
                  disabled={v.stockQty === 0}
                  data-on={variant === v.label}
                  className="chip min-w-[44px] justify-center disabled:opacity-30 disabled:line-through"
                  aria-pressed={variant === v.label}
                >
                  {v.label}
                  {v.stockQty > 0 && v.stockQty < 3 && <span className="text-[9px] text-danger">!</span>}
                </button>
              ))}
            </div>
          </fieldset>
        )}

        <div className="mt-6 flex items-center gap-3">
          <div className="flex items-center rounded-full border border-linestrong">
            <button type="button" onClick={() => setQty((q) => Math.max(1, q - 1))} className="h-11 w-11 text-lg text-muted hover:text-ink" aria-label="Decrease quantity">−</button>
            <span className="w-7 text-center text-sm tabular-nums" aria-live="polite">{qty}</span>
            <button type="button" onClick={() => setQty((q) => Math.min(10, q + 1))} className="h-11 w-11 text-lg text-muted hover:text-ink" aria-label="Increase quantity">+</button>
          </div>
        </div>

        {/* Orders are placed in conversation, not on the site. There is no
            cart and no checkout: Buy opens WhatsApp with the piece, variant,
            quantity and SKU pre-filled so the customer never retypes it. */}
        <a
          className="btn btn-whatsapp mt-4 w-full"
          href={waLink(`Hi MatzHub, I'd like to order:\n${p.title}${variant ? ` (${variant})` : ""}${qty > 1 ? ` x${qty}` : ""}\nSKU ${p.sku}\n${SITE.url}/p/${p.slug}`)}
          target="_blank"
          rel="noopener noreferrer"
          aria-disabled={soldOut}
          onClick={() => track("whatsapp_order", { productId: p.id, value: p.price * qty })}
        >
          {soldOut ? "Ask about availability" : "Buy on WhatsApp"}
        </a>

        <button type="button" onClick={wishToggle} className="btn btn-outline mt-3 w-full" aria-pressed={saved}>
          {saved ? "♥ Saved" : "♡ Save for later"}
        </button>

        <dl className="mt-6 space-y-2.5 border-t border-line pt-5 text-[12px]">
          <div className="flex gap-3">
            <dt className="w-24 shrink-0 pt-0.5 text-[10px] uppercase tracking-[0.14em] text-subtle">Delivery</dt>
            <dd className="flex-1 text-ink">Pan-India, standard courier timing</dd>
          </div>
          <div className="flex gap-3">
            <dt className="w-24 shrink-0 pt-0.5 text-[10px] uppercase tracking-[0.14em] text-subtle">Payment</dt>
            <dd className="flex-1 text-ink">Cash on delivery or UPI</dd>
          </div>
          <div className="flex gap-3">
            <dt className="w-24 shrink-0 pt-0.5 text-[10px] uppercase tracking-[0.14em] text-subtle">Replacement</dt>
            <dd className="flex-1 text-ink">Free inside one week if it isn&apos;t as shown</dd>
          </div>
          <div className="flex gap-3">
            <dt className="w-24 shrink-0 pt-0.5 text-[10px] uppercase tracking-[0.14em] text-subtle">Available</dt>
            <dd className="flex-1 text-ink">
              {p.availability === "low_stock" ? `Last ${p.stockQty} pieces` : p.availability === "out_of_stock" ? "Sold out" : "In stock"}
            </dd>
          </div>
        </dl>

        <div className="mt-5 rounded-xl border border-line p-4" style={{ background: "var(--c-accent-soft)" }}>
          <p className="flex items-center gap-2 text-[13px] font-medium text-ink">
            <span className="text-accent" aria-hidden>✓</span>
            Not as shown? Replaced free. No forms.
          </p>
        </div>

        <div className="mt-4">
          {!alertOpen ? (
            <button type="button" onClick={() => setAlertOpen(true)} className="text-[12px] text-muted underline underline-offset-4 hover:text-ink">
              Notify me if the price drops
            </button>
          ) : alertDone ? (
            <p className="text-[12px] text-accent">Done. We&apos;ll ping you when it hits {inr(alertPrice)}.</p>
          ) : (
            <div className="flex gap-2">
              <label htmlFor="target-price" className="sr-only">Target price</label>
              <input id="target-price" type="number" value={alertPrice} onChange={(e) => setAlertPrice(Number(e.target.value))} className="field py-2 text-sm" />
              <button type="button" onClick={submitAlert} className="btn btn-outline shrink-0 px-4 py-2 text-[11px]">Set alert</button>
            </div>
          )}
        </div>

        {shareKit}

        <p className="mt-4 text-[11.5px] leading-relaxed text-muted">
          Imported first-copy, master quality. We&apos;re not affiliated with, endorsed by, or licensed by any original
          brand. <Link href="/legal/disclaimer" className="underline underline-offset-4">Read the disclaimer</Link>.
        </p>
      </div>

      {/* mobile sticky CTA */}
      <div className="fixed bottom-0 left-0 right-0 z-40 border-t border-line bg-canvas/96 px-4 py-3 backdrop-blur-xl pb-safe lg:hidden">
        <div className="mx-auto flex max-w-lg gap-2.5">
          <a
            className="btn btn-whatsapp h-12 flex-1 text-[15px]"
            href={waLink(`Hi MatzHub, I'd like to order:\n${p.title}${variant ? ` (${variant})` : ""}${qty > 1 ? ` x${qty}` : ""}\nSKU ${p.sku}\n${SITE.url}/p/${p.slug}`)}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => track("whatsapp_order", { productId: p.id, value: p.price * qty })}
          >
            {soldOut ? "Ask about availability" : "Buy on WhatsApp"}
          </a>
        </div>
      </div>
    </aside>
  );
}
