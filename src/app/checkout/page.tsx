"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { buildOrderMessage } from "@/lib/order-message";
import { anonId, cartTotals, clearCart, getCart, subscribe, type CartItem } from "@/lib/client-store";
import { inr, waLink } from "@/lib/utils";

const REQUEST_KEY = "mh_order_request_v1";

type RequestKey = { fingerprint: string; key: string };

function fingerprint(cart: CartItem[]) {
  return cart
    .map((item) => `${item.id}:${item.variant ?? ""}:${item.qty}`)
    .sort()
    .join("|");
}

function orderRequestKey(cart: CartItem[]) {
  const current = fingerprint(cart);
  try {
    const stored = sessionStorage.getItem(REQUEST_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as RequestKey;
      if (parsed.fingerprint === current && parsed.key) return parsed.key;
    }
    const key = crypto.randomUUID();
    sessionStorage.setItem(REQUEST_KEY, JSON.stringify({ fingerprint: current, key } satisfies RequestKey));
    return key;
  } catch {
    return crypto.randomUUID();
  }
}

export default function CheckoutPage() {
  const router = useRouter();
  const [cart, setCart] = useState<CartItem[]>([]);
  const [mounted, setMounted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const totals = useMemo(() => cartTotals(cart), [cart]);

  useEffect(() => {
    const sync = () => setCart(getCart());
    const timer = window.setTimeout(() => {
      sync();
      setMounted(true);
    }, 0);
    const unsubscribe = subscribe(sync);
    return () => {
      window.clearTimeout(timer);
      unsubscribe();
    };
  }, []);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!cart.length || submitting) return;
    setSubmitting(true);
    setError("");

    const form = new FormData(event.currentTarget);
    const customer = {
      name: String(form.get("name") ?? ""),
      phone: String(form.get("phone") ?? ""),
      email: String(form.get("email") ?? ""),
      addressLine: String(form.get("addressLine") ?? ""),
      city: String(form.get("city") ?? ""),
      state: String(form.get("state") ?? ""),
      pincode: String(form.get("pincode") ?? ""),
      notes: String(form.get("notes") ?? ""),
    };

    try {
      const response = await fetch("/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-mh-anon": anonId() },
        body: JSON.stringify({
          submissionKey: orderRequestKey(cart),
          customer,
          items: cart.map((item) => ({ productId: item.id, qty: item.qty, variant: item.variant })),
        }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        ok?: boolean; error?: string; orderNo?: string; accessToken?: string;
      };
      if (!response.ok || !body.ok || !body.orderNo || !body.accessToken) {
        throw new Error(body.error || "We could not submit your order. Please try again.");
      }

      try {
        sessionStorage.removeItem(REQUEST_KEY);
      } catch {
        /* non-critical */
      }
      clearCart();
      router.replace(`/order/${body.orderNo}?token=${encodeURIComponent(body.accessToken)}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "We could not submit your order. Please try again.");
      setSubmitting(false);
    }
  }

  if (!mounted) {
    return <div className="shell py-16"><div className="skeleton mx-auto h-72 max-w-3xl rounded-2xl" /></div>;
  }

  if (!cart.length) {
    return (
      <div className="shell py-16 text-center">
        <div className="surface mx-auto max-w-md p-8 sm:p-10">
          <p className="eyebrow">Order details</p>
          <h1 className="display mt-3 text-3xl">Your cart is empty</h1>
          <p className="t-body mt-3">Add something you like before entering delivery details.</p>
          <Link href="/" className="btn btn-solid mt-7">Browse catalogue</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="shell py-10 sm:py-14 lg:py-16">
      <div className="mx-auto max-w-5xl">
        <p className="eyebrow mb-3">Order details</p>
        <h1 className="display text-[clamp(2rem,5vw,3.2rem)]">Where should we send it?</h1>
        <p className="t-lead mt-4 max-w-2xl">Send your order request and we’ll confirm availability and delivery details with you on WhatsApp. No payment is taken here.</p>

        <form onSubmit={submit} className="mt-9 grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px] lg:gap-10">
          <section className="surface p-5 sm:p-7">
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block sm:col-span-2">
                <span className="eyebrow mb-2 block">Full name</span>
                <input name="name" required autoComplete="name" minLength={2} maxLength={80} className="field w-full" />
              </label>
              <label className="block">
                <span className="eyebrow mb-2 block">Mobile number</span>
                <input name="phone" required inputMode="tel" autoComplete="tel" placeholder="91XXXXXXXXXX" className="field w-full" />
              </label>
              <label className="block">
                <span className="eyebrow mb-2 block">Email <span className="normal-case tracking-normal text-subtle">(optional)</span></span>
                <input name="email" type="email" autoComplete="email" className="field w-full" />
              </label>
              <label className="block sm:col-span-2">
                <span className="eyebrow mb-2 block">Delivery address</span>
                <textarea name="addressLine" required minLength={5} maxLength={300} rows={3} autoComplete="street-address" className="field w-full resize-y" />
              </label>
              <label className="block">
                <span className="eyebrow mb-2 block">City</span>
                <input name="city" required minLength={2} maxLength={80} autoComplete="address-level2" className="field w-full" />
              </label>
              <label className="block">
                <span className="eyebrow mb-2 block">State</span>
                <input name="state" required minLength={2} maxLength={80} autoComplete="address-level1" className="field w-full" />
              </label>
              <label className="block">
                <span className="eyebrow mb-2 block">PIN code</span>
                <input name="pincode" required inputMode="numeric" pattern="[0-9]{6}" autoComplete="postal-code" maxLength={6} className="field w-full" />
              </label>
              <label className="block sm:col-span-2">
                <span className="eyebrow mb-2 block">Note <span className="normal-case tracking-normal text-subtle">(optional)</span></span>
                <input name="notes" maxLength={500} placeholder="Size, colour, or delivery note" className="field w-full" />
              </label>
            </div>

            {error && <p role="alert" className="mt-5 rounded-lg border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">{error}</p>}

            <button type="submit" disabled={submitting} className="btn btn-solid mt-7 w-full disabled:cursor-not-allowed disabled:opacity-60">
              {submitting ? "Submitting order…" : "Submit order request"}
            </button>
            <p className="mt-3 text-center text-[12px] leading-relaxed text-muted">We’ll confirm stock before dispatch. Submitting this form does not complete a payment.</p>
          </section>

          <aside className="surface h-fit p-5 sm:p-6 lg:sticky lg:top-20">
            <p className="eyebrow border-b border-line pb-3">Your order</p>
            <ul className="divide-y divide-line">
              {cart.map((item) => (
                <li key={`${item.id}-${item.variant ?? ""}`} className="flex gap-3 py-4">
                  <div className="relative h-16 w-14 shrink-0 overflow-hidden rounded-lg bg-surface-3">
                    <Image src={item.image} alt="" fill sizes="56px" className="object-cover" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="line-clamp-2 text-[13px] font-medium text-ink">{item.title}</p>
                    <p className="mt-1 text-[11px] text-muted">{item.variant ? `${item.variant} · ` : ""}Qty {item.qty}</p>
                    <p className="mt-1 font-display text-[15px] text-ink">{inr(item.price * item.qty)}</p>
                  </div>
                </li>
              ))}
            </ul>
            <dl className="space-y-2 border-t border-line pt-4 text-[13px]">
              <div className="flex justify-between"><dt className="text-muted">Subtotal</dt><dd>{inr(totals.subtotal)}</dd></div>
              <div className="flex justify-between"><dt className="text-muted">Delivery</dt><dd>{totals.delivery ? inr(totals.delivery) : "Free"}</dd></div>
              <div className="flex justify-between border-t border-line pt-3 font-semibold text-ink"><dt>Total</dt><dd className="font-display text-[20px]">{inr(totals.total)}</dd></div>
            </dl>
            <div className="mt-5 border-t border-line pt-4">
              <Link href="/cart" className="text-[12px] text-muted underline underline-offset-4 hover:text-ink">Edit cart</Link>
              <a href={waLink(buildOrderMessage(cart))} target="_blank" rel="noopener noreferrer" className="mt-3 block text-[12px] text-muted underline underline-offset-4 hover:text-ink">Prefer to order with us on WhatsApp?</a>
            </div>
          </aside>
        </form>
      </div>
    </div>
  );
}
