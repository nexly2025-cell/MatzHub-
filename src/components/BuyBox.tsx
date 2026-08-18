"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { getWishlist, pushRecent, subscribe, toggleWishlist, track, addToCart, FREE_DELIVERY_OVER, DELIVERY_FEE, MAX_QTY_PER_LINE, type CartItem } from "@/lib/client-store";
import { buildOrderMessage } from "@/lib/order-message";
import { inr, savePercent, waLink } from "@/lib/utils";

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
  const [addedSuccess, setAddedSuccess] = useState(false);

  const handleAddToCart = () => {
    addToCart({
      id: p.id,
      slug: p.slug,
      title: p.title,
      image: p.heroImage,
      price: p.price,
      mrp: p.mrp,
      variant: variant || undefined,
      qty,
      sku: p.sku
    });
    setAddedSuccess(true);
    track("add_to_cart", { productId: p.id, value: p.price * qty });
    setTimeout(() => setAddedSuccess(false), 3000);
  };

  const off = savePercent(p.mrp, p.price);
  const soldOut = p.availability === "out_of_stock";

  // One order format for the whole site. The cart builds the same message from
  // the same helper, so a single-item "Buy on WhatsApp" and a cart checkout
  // arrive looking identical to whoever answers the chat.
  const asLine = (): CartItem[] => [
    { id: p.id, slug: p.slug, title: p.title, image: p.heroImage, price: p.price, mrp: p.mrp, variant: variant || undefined, qty, sku: p.sku },
  ];
  const orderHref = (): string =>
    soldOut
      ? waLink(`Hi MatzHub, is this back in stock?\n${p.title}${variant ? ` (${variant})` : ""}\nSKU ${p.sku}`)
      : waLink(buildOrderMessage(asLine()));
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
          <p className="mt-2 text-[12px] text-muted">
            Taxes included · {p.price >= FREE_DELIVERY_OVER ? "free pan-India delivery" : `${inr(DELIVERY_FEE)} delivery`}
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
            <button type="button" onClick={() => setQty((q) => Math.min(MAX_QTY_PER_LINE, q + 1))} className="h-11 w-11 text-lg text-muted hover:text-ink" aria-label="Increase quantity">+</button>
          </div>
        </div>

        {/* Dual Actions: Add to Cart (multi-item orders) & Buy on WhatsApp (instant single-item checkouts) */}
        <button
          type="button"
          onClick={handleAddToCart}
          disabled={soldOut}
          className="btn btn-solid mt-4 w-full bg-ink text-oninverse hover:opacity-90"
        >
          {addedSuccess ? "✓ Added to Cart!" : "Add to Cart"}
        </button>

        <a
          className="btn btn-whatsapp mt-2 w-full"
          href={orderHref()}
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
            <dd className="flex-1 text-ink">Arranged with our team on WhatsApp after we confirm the order</dd>
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
          <button
            type="button"
            onClick={handleAddToCart}
            disabled={soldOut}
            className="btn btn-solid h-12 flex-1 text-[14px] bg-ink text-oninverse hover:opacity-90"
          >
            {addedSuccess ? "✓ Added" : "Add to Cart"}
          </button>
          <a
            className="btn btn-whatsapp h-12 flex-1 text-[14px]"
            href={orderHref()}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => track("whatsapp_order", { productId: p.id, value: p.price * qty })}
          >
            {soldOut ? "Ask availability" : "Buy on WhatsApp"}
          </a>
        </div>
      </div>
    </aside>
  );
}
