"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { useRouter } from "next/navigation";
import {
  getCart,
  updateCartQty,
  removeFromCart,
  clearCart,
  subscribe,
  cartTotals,
  revalidateCart,
  FREE_DELIVERY_OVER,
  MAX_QTY_PER_LINE,
  type CartItem,
} from "@/lib/client-store";
import { buildOrderMessage } from "@/lib/order-message";
import { inr, waLink } from "@/lib/utils";

type Fields = Record<string, string>;

const BLANK = { name: "", phone: "", addressLine: "", city: "", state: "", pincode: "", notes: "" };

/**
 * Cart.
 *
 * There is no payment gateway and no cash on delivery. The cart's only job is
 * to assemble the order accurately and hand it to a human on WhatsApp, so
 * nothing here implies a payment has been taken or scheduled.
 *
 * The WhatsApp message and every rupee figure come from the shared helpers in
 * `client-store` / `order-message`. This page holds no pricing logic of its
 * own — a second copy is how the summary and the message drift apart.
 */
export default function CartPage() {
  const router = useRouter();
  const [cart, setCart] = useState<CartItem[]>([]);
  const [ready, setReady] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [details, setDetails] = useState(BLANK);
  const [errors, setErrors] = useState<Fields>({});
  const [submitting, setSubmitting] = useState(false);
  const [formOpen, setFormOpen] = useState(false);

  const set = (k: keyof typeof BLANK) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setDetails((d) => ({ ...d, [k]: e.target.value }));

  /**
   * Records the order, then hands the customer to WhatsApp.
   *
   * The order is written down BEFORE the handoff. Previously the cart only
   * opened wa.me, so an order the customer never repeated in the chat left no
   * trace at all. No payment is taken at any point in this function.
   */
  async function submitOrder() {
    setSubmitting(true);
    setErrors({});
    try {
      const res = await fetch("/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customer: details,
          items: cart.map((i) => ({ productId: i.id, qty: i.qty, variant: i.variant })),
        }),
      });
      const data = (await res.json()) as {
        ok?: boolean; orderNo?: string; error?: string; message?: string; fields?: Fields;
      };

      if (!res.ok || !data.ok) {
        if (data.fields) setErrors(data.fields);
        setNotice(data.message ?? (data.fields ? "Check the highlighted fields." : data.error ?? "Something went wrong."));
        if (res.status === 409) void revalidateCart().then(() => setCart(getCart()));
        return;
      }

      // Open WhatsApp with the real order number, then land on the receipt.
      // Opened before the redirect so it is still inside the click gesture.
      const message = `${buildOrderMessage(cart)}\n\nOrder number: ${data.orderNo}`;
      window.open(waLink(message), "_blank", "noopener,noreferrer");
      clearCart();
      router.push(`/track?no=${encodeURIComponent(data.orderNo!)}`);
    } catch {
      setNotice("We could not reach the server. Check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  useEffect(() => {
    const sync = () => {
      setCart(getCart());
      setReady(true);
    };
    sync();
    const unsub = subscribe(sync);

    // Prices and availability drift while a cart sits in localStorage.
    // Reconcile once on mount and tell the customer what moved.
    let alive = true;
    void revalidateCart().then(({ removed, repriced, soldOut }) => {
      if (!alive) return;
      const parts: string[] = [];
      if (removed.length) parts.push(`${removed.join(", ")} is no longer available and was removed.`);
      if (soldOut.length) parts.push(`${soldOut.join(", ")} just sold out and was removed.`);
      if (repriced.length) parts.push(`Prices updated for ${repriced.join(", ")}.`);
      if (parts.length) setNotice(parts.join(" "));
    });

    return () => {
      alive = false;
      unsub();
    };
  }, []);

  const totals = cartTotals(cart);

  if (!ready) {
    return (
      <div className="shell py-16">
        <div className="skeleton mx-auto h-40 max-w-3xl rounded-2xl" />
      </div>
    );
  }

  if (cart.length === 0) {
    return (
      <div className="shell py-16 lg:py-24">
        <div className="mx-auto max-w-md rounded-2xl border border-line bg-surface p-8 text-center sm:p-10">
          <h1 className="display text-[1.6rem] text-ink">Your cart is empty</h1>
          <p className="mt-2 text-[13.5px] leading-relaxed text-muted">
            Add a few pieces and we&apos;ll put the order together with you on WhatsApp.
          </p>
          <Link href="/" className="btn btn-solid mt-7 px-7">
            Browse the catalogue
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="shell py-10 lg:py-14">
      <h1 className="display text-[clamp(1.7rem,4.5vw,2.5rem)] text-ink">Your cart</h1>
      <p className="mt-1.5 text-[13px] text-muted">
        Check the pieces below, then send the order to us on WhatsApp. Nothing is charged here.
      </p>

      {notice && (
        <div
          role="status"
          className="mt-5 rounded-xl border border-line bg-surface-2 px-4 py-3 text-[12.5px] leading-relaxed text-ink"
        >
          {notice}
        </div>
      )}

      <div className="mt-8 grid gap-8 lg:grid-cols-[1fr_340px] lg:gap-10">
        {/* ── Lines ──────────────────────────────────────────────────────── */}
        <div className="space-y-3">
          {cart.map((item) => (
            <div
              key={`${item.id}-${item.variant || ""}`}
              className="flex gap-4 rounded-xl border border-line bg-surface p-3.5 sm:p-4"
            >
              <Link
                href={`/p/${item.slug}`}
                className="relative h-24 w-20 shrink-0 overflow-hidden rounded-lg border border-line bg-surface-3"
              >
                <Image src={item.image} alt="" fill sizes="80px" className="object-cover" aria-hidden />
              </Link>

              <div className="flex min-w-0 flex-1 flex-col justify-between gap-3">
                <div className="min-w-0">
                  <Link
                    href={`/p/${item.slug}`}
                    className="line-clamp-2 text-[14px] font-medium leading-snug text-ink hover:underline"
                  >
                    {item.title}
                  </Link>
                  {item.variant && <p className="mt-1 text-[12px] text-muted">{item.variant}</p>}
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center rounded-full border border-linestrong">
                    <button
                      type="button"
                      aria-label={`Decrease quantity of ${item.title}`}
                      onClick={() => updateCartQty(item.id, item.variant, item.qty - 1)}
                      className="h-9 w-9 text-base text-muted transition-colors hover:text-ink"
                    >
                      −
                    </button>
                    <span className="w-7 text-center text-[13px] tabular-nums text-ink" aria-live="polite">
                      {item.qty}
                    </span>
                    <button
                      type="button"
                      aria-label={`Increase quantity of ${item.title}`}
                      disabled={item.qty >= MAX_QTY_PER_LINE}
                      onClick={() => updateCartQty(item.id, item.variant, item.qty + 1)}
                      className="h-9 w-9 text-base text-muted transition-colors hover:text-ink disabled:opacity-30"
                    >
                      +
                    </button>
                  </div>

                  <div className="flex items-baseline gap-2 text-right">
                    <span className="font-display text-[16px] text-ink">{inr(item.price * item.qty)}</span>
                    {item.mrp > item.price && (
                      <span className="text-[11.5px] text-subtle line-through">{inr(item.mrp * item.qty)}</span>
                    )}
                  </div>

                  <button
                    type="button"
                    onClick={() => removeFromCart(item.id, item.variant)}
                    className="text-[12px] text-muted underline underline-offset-4 transition-colors hover:text-danger"
                  >
                    Remove
                  </button>
                </div>
              </div>
            </div>
          ))}

          <div className="flex items-center justify-between pt-3">
            <button
              type="button"
              onClick={() => clearCart()}
              className="text-[12px] text-muted underline underline-offset-4 transition-colors hover:text-danger"
            >
              Clear cart
            </button>
            <Link href="/" className="text-[12px] text-muted underline underline-offset-4 hover:text-ink">
              Continue shopping
            </Link>
          </div>
        </div>

        {/* ── Summary ────────────────────────────────────────────────────── */}
        <aside className="self-start rounded-xl border border-line bg-surface p-5 lg:sticky lg:top-20">
          <h2 className="eyebrow border-b border-line pb-3">Summary</h2>

          <dl className="space-y-2.5 pt-4 text-[13px]">
            <div className="flex justify-between">
              <dt className="text-muted">
                Subtotal · {totals.count} {totals.count === 1 ? "item" : "items"}
              </dt>
              <dd className="text-ink tabular-nums">{inr(totals.subtotal)}</dd>
            </div>
            {totals.savings > 0 && (
              <div className="flex justify-between">
                <dt className="text-muted">You save</dt>
                <dd className="text-accent tabular-nums">−{inr(totals.savings)}</dd>
              </div>
            )}
            <div className="flex justify-between">
              <dt className="text-muted">Delivery</dt>
              <dd className="text-ink tabular-nums">{totals.delivery === 0 ? "Free" : inr(totals.delivery)}</dd>
            </div>
          </dl>

          {totals.delivery > 0 && (
            <p className="mt-2 text-[11.5px] leading-relaxed text-muted">
              Add {inr(FREE_DELIVERY_OVER - totals.subtotal)} more for free pan-India delivery.
            </p>
          )}

          <div className="mt-4 flex items-baseline justify-between border-t border-line pt-4">
            <span className="text-[13px] font-medium text-ink">Total</span>
            <span className="font-display text-[24px] text-ink tabular-nums">{inr(totals.total)}</span>
          </div>

          {!formOpen ? (
            <>
              <button type="button" onClick={() => setFormOpen(true)} className="btn btn-solid mt-5 w-full">
                Continue to delivery details
              </button>
              <p className="mt-3 text-[11.5px] leading-relaxed text-muted">
                We confirm availability in the chat, then arrange payment with you directly. No payment is taken on
                this website.
              </p>
            </>
          ) : (
            <form
              className="mt-5 space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (!submitting) void submitOrder();
              }}
            >
              <p className="eyebrow">Delivery details</p>

              <Field id="c-name" label="Full name" value={details.name} onChange={set("name")} error={errors.name} autoComplete="name" />
              <Field id="c-phone" label="Mobile number" value={details.phone} onChange={set("phone")} error={errors.phone} autoComplete="tel" inputMode="numeric" placeholder="10-digit number" />
              <Field id="c-address" label="Address" value={details.addressLine} onChange={set("addressLine")} error={errors.addressLine} autoComplete="street-address" />

              <div className="grid grid-cols-2 gap-3">
                <Field id="c-city" label="City" value={details.city} onChange={set("city")} error={errors.city} autoComplete="address-level2" />
                <Field id="c-pin" label="PIN code" value={details.pincode} onChange={set("pincode")} error={errors.pincode} autoComplete="postal-code" inputMode="numeric" />
              </div>
              <Field id="c-state" label="State" value={details.state} onChange={set("state")} error={errors.state} autoComplete="address-level1" />

              <button type="submit" disabled={submitting} className="btn btn-whatsapp w-full disabled:opacity-60">
                {submitting ? "Placing order…" : "Place order on WhatsApp"}
              </button>

              <p className="text-[11.5px] leading-relaxed text-muted">
                We save your order, open WhatsApp with the details, and confirm availability there. Payment is
                arranged with our team afterwards — nothing is charged on this website.
              </p>
            </form>
          )}
        </aside>
      </div>
    </div>
  );
}

/** Labelled input with inline validation, matching the site's field styling. */
function Field({
  id, label, value, onChange, error, ...rest
}: {
  id: string;
  label: string;
  value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  error?: string;
} & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-[11.5px] text-muted">
        {label}
      </label>
      <input
        id={id}
        value={value}
        onChange={onChange}
        required
        aria-invalid={Boolean(error)}
        aria-describedby={error ? `${id}-err` : undefined}
        className={`field w-full text-[13px] ${error ? "border-danger" : ""}`}
        {...rest}
      />
      {error && (
        <p id={`${id}-err`} role="alert" className="mt-1 text-[11px] text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
