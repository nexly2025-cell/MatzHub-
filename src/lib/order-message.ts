import { SITE, inr } from "@/lib/utils";
import type { CartItem } from "@/lib/client-store";
import { cartTotals } from "@/lib/client-store";

/** WhatsApp renders *text* as bold. */
const RULE = "━━━━━━━━━━━━━━━━";
const NUM = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];

/**
 * Builds the premium customer-facing WhatsApp order message for a
 * multi-product cart. Pure function — unit-tested, used by the cart page.
 *
 * Customer-facing only: products, quantities, variants, SKU, prices,
 * subtotal, delivery, total and the site reference. No supplier, group,
 * automation, internal id or operational metadata is ever included.
 */
export function buildOrderMessage(cart: CartItem[]): string {
  if (!cart.length) return "";
  const totals = cartTotals(cart);

  const lines = cart.map((i, n) => {
    const parts = [`${NUM[n] ?? `${n + 1}.`} ${i.title}`];
    if (i.variant) parts.push(`   Variant: ${i.variant}`);
    if (i.sku) parts.push(`   SKU: ${i.sku}`);
    parts.push(`   Qty: ${i.qty}`);
    parts.push(
      i.qty > 1
        ? `   ${inr(i.price)} × ${i.qty} = ${inr(i.price * i.qty)}`
        : `   ${inr(i.price)}`,
    );
    return parts.join("\n");
  });

  return [
    RULE,
    "🛍️ MATZHUB ORDER",
    RULE,
    "",
    "Hello MatzHub 👋",
    "",
    "I'd like to place the following order:",
    "",
    ...lines,
    "",
    RULE,
    `Subtotal: ${inr(totals.subtotal)}`,
    `Delivery: ${totals.delivery === 0 ? "Free" : inr(totals.delivery)}`,
    `*TOTAL: ${inr(totals.total)}*`,
    RULE,
    "",
    "📦 Delivery details:",
    "[name, address, pincode]",
    "",
    `Order reference: ${SITE.url}/cart`,
    "",
    "Thank you.",
  ].join("\n");
}
