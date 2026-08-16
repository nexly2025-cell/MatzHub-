"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { getCart, updateCartQty, removeFromCart, clearCart, subscribe, type CartItem } from "@/lib/client-store";
import { inr, waLink } from "@/lib/utils";
import { buildOrderMessage } from "@/lib/order-message";

export default function CartPage() {
  const [cart, setCart] = useState<CartItem[]>([]);
  const [mounted, setSetMounted] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      setSetMounted(true);
    }, 0);
    const sync = () => {
      setCart(getCart());
    };
    sync();
    const unsub = subscribe(sync);
    return () => {
      clearTimeout(timer);
      unsub();
    };
  }, []);

  if (!mounted) {
    return (
      <div className="shell py-16 text-center">
        <div className="skeleton mx-auto h-32 max-w-2xl rounded-2xl" />
      </div>
    );
  }

  const subtotal = cart.reduce((acc, item) => acc + item.price * item.qty, 0);
  const originalSubtotal = cart.reduce((acc, item) => acc + (item.mrp || item.price) * item.qty, 0);
  const totalSavings = originalSubtotal - subtotal;
  const shippingCost = subtotal === 0 ? 0 : subtotal >= 999 ? 0 : 59;
  const finalTotal = subtotal + shippingCost;

  const handleQtyChange = (item: CartItem, newQty: number) => {
    updateCartQty(item.id, item.variant, newQty);
  };

  const handleRemove = (item: CartItem) => {
    removeFromCart(item.id, item.variant);
  };

  // Single premium WhatsApp order builder — src/lib/order-message.ts (unit-tested,
  // used by every surface; contains zero internal/supplier metadata).
  const buildWhatsAppMessage = () => buildOrderMessage(cart);

  if (cart.length === 0) {
    return (
      <div className="shell py-16 text-center">
        <div className="surface mx-auto max-w-md py-16 rounded-2xl border border-line p-6">
          <div className="text-muted text-5xl mb-4">🛒</div>
          <h1 className="display text-2xl mb-2 text-ink">Your cart is empty</h1>
          <p className="mb-8 text-sm text-muted">
            Looks like you haven&apos;t added anything to your cart yet. Explore our premium direct-from-manufacturer collections.
          </p>
          <Link href="/" className="btn btn-solid px-8 py-3 bg-accent text-white hover:opacity-90">
            Browse Catalogue
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="shell py-10 lg:py-16">
      <h1 className="display text-[clamp(1.8rem,4.5vw,2.8rem)] mb-2 text-ink">Your Shopping Cart</h1>
      <p className="mb-8 text-sm text-muted">Review your items before checking out via WhatsApp.</p>

      <div className="grid gap-8 lg:grid-cols-[1fr_360px] lg:gap-12">
        {/* Cart items list */}
        <div className="space-y-4">
          {cart.map((item) => {
            const itemSavings = (item.mrp - item.price) * item.qty;
            return (
              <div
                key={`${item.id}-${item.variant || ""}`}
                className="flex flex-col gap-4 rounded-xl border border-line bg-surface p-4 sm:flex-row sm:items-center justify-between"
              >
                <div className="flex gap-4">
                  <div className="relative h-20 w-16 shrink-0 overflow-hidden rounded-lg bg-surface-3 border border-line">
                    <Image src={item.image} alt={item.title} fill sizes="80px" className="object-cover" />
                  </div>
                  <div className="min-w-0">
                    <Link href={`/p/${item.slug}`} className="font-display text-[15px] font-semibold text-ink hover:underline line-clamp-1">
                      {item.title}
                    </Link>
                    {item.variant && (
                      <p className="text-[12px] text-muted mt-0.5">Size/Variant: <span className="font-medium text-ink">{item.variant}</span></p>
                    )}
                    <p className="text-[12px] text-subtle mt-0.5">SKU: {item.sku}</p>
                    <button
                      type="button"
                      onClick={() => handleRemove(item)}
                      className="mt-2 text-[11px] text-danger hover:underline font-medium flex items-center gap-1"
                    >
                      ✕ Remove
                    </button>
                  </div>
                </div>

                <div className="flex items-center justify-between gap-6 border-t border-line pt-3 sm:border-t-0 sm:pt-0">
                  {/* Quantity selector */}
                  <div className="flex items-center rounded-full border border-linestrong">
                    <button
                      type="button"
                      onClick={() => handleQtyChange(item, item.qty - 1)}
                      className="h-8 w-8 text-sm text-muted hover:text-ink"
                    >
                      −
                    </button>
                    <span className="w-6 text-center text-xs tabular-nums text-ink">{item.qty}</span>
                    <button
                      type="button"
                      onClick={() => handleQtyChange(item, item.qty + 1)}
                      className="h-8 w-8 text-sm text-muted hover:text-ink"
                    >
                      +
                    </button>
                  </div>

                  {/* Pricing block */}
                  <div className="text-right">
                    <p className="font-display text-[16px] font-bold text-ink">{inr(item.price * item.qty)}</p>
                    {item.mrp > item.price && (
                      <p className="text-[11px] text-muted line-through">{inr(item.mrp * item.qty)}</p>
                    )}
                  </div>
                </div>
              </div>
            );
          })}

          <div className="flex justify-between items-center border-t border-line pt-6">
            <button
              type="button"
              onClick={() => clearCart()}
              className="text-[12px] text-muted hover:text-danger underline decoration-dotted"
            >
              Clear entire cart
            </button>
            <Link href="/" className="text-[12px] text-accent font-medium hover:underline">
              ← Continue shopping
            </Link>
          </div>
        </div>

        {/* Order summary */}
        <div className="rounded-xl border border-line bg-surface p-6 self-start space-y-5">
          <h2 className="eyebrow border-b border-line pb-3">Order Summary</h2>

          <div className="space-y-2.5 text-[13px] text-ink">
            <div className="flex justify-between">
              <span className="text-muted">Subtotal ({cart.reduce((a, b) => a + b.qty, 0)} items)</span>
              <span>{inr(subtotal)}</span>
            </div>
            {totalSavings > 0 && (
              <div className="flex justify-between text-accent">
                <span>Total Savings</span>
                <span>-{inr(totalSavings)}</span>
              </div>
            )}
            <div className="flex justify-between">
              <span className="text-muted">Courier Fee</span>
              <span>{shippingCost === 0 ? "FREE" : inr(shippingCost)}</span>
            </div>
            <p className="text-[11px] text-muted mt-1 leading-normal">
              {subtotal >= 999
                ? "✓ Your order qualifies for free courier delivery pan-India."
                : `Add ${inr(999 - subtotal)} more to unlock FREE shipping.`}
            </p>
          </div>

          <div className="border-t border-line pt-4 flex justify-between items-baseline">
            <span className="font-display text-[16px] font-bold text-ink">Total Price</span>
            <span className="font-display text-[26px] font-black text-ink">{inr(finalTotal)}</span>
          </div>

          <a
            href={waLink(buildWhatsAppMessage())}
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-whatsapp w-full py-3 h-auto text-[15px] font-semibold text-center flex items-center justify-center gap-2 mt-4 shadow-sm"
          >
            Checkout on WhatsApp
          </a>

          <div className="rounded-lg border border-line p-3 text-[11px] text-muted leading-relaxed space-y-1 bg-surface-2">
            <p className="font-medium text-ink flex items-center gap-1">
              <span className="text-accent">✓</span> Cash on Delivery / UPI
            </p>
            <p>Order is finalized in conversation with our team on WhatsApp. You get a tracking ID once shipped.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
