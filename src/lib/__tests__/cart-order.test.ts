import { describe, expect, it } from "vitest";
import { buildOrderMessage } from "@/lib/order-message";
import { cartTotals, type CartItem } from "@/lib/client-store";

const watch: CartItem = {
  productId: "p1",
  slug: "watch",
  title: "Premium Steel Chronograph Watch",
  sku: "MH-W-001",
  image: "https://img/1.jpg",
  price: 1899,
  mrp: 2499,
  variant: "",
  qty: 2,
};

const bag: CartItem = {
  productId: "p2",
  slug: "bag",
  title: "Classic Designer Shoulder Bag",
  sku: "MH-B-002",
  image: "https://img/2.jpg",
  price: 4025,
  mrp: 4550,
  variant: "Tan",
  qty: 1,
};

describe("cartTotals", () => {
  it("computes subtotal, savings and free delivery over 999", () => {
    const t = cartTotals([watch, bag]);
    expect(t.subtotal).toBe(1899 * 2 + 4025);
    expect(t.mrpTotal).toBe(2499 * 2 + 4550);
    expect(t.savings).toBe(2499 * 2 + 4550 - (1899 * 2 + 4025));
    expect(t.delivery).toBe(0);
    expect(t.total).toBe(t.subtotal);
  });

  it("adds 59 delivery under 999", () => {
    const t = cartTotals([{ ...watch, price: 400, mrp: 500, qty: 1 }]);
    expect(t.delivery).toBe(59);
    expect(t.total).toBe(459);
  });
});

describe("buildOrderMessage", () => {
  it("uses the branded MATZHUB ORDER header", () => {
    const msg = buildOrderMessage([watch, bag]);
    expect(msg).toContain("🛍️ MATZHUB ORDER");
    expect(msg).toContain("━━━━━━━━━━━━━━━━");
  });

  it("lists every line with numbered emoji, variant, SKU, qty and price math", () => {
    const msg = buildOrderMessage([watch, bag]);
    expect(msg).toContain("1️⃣ Premium Steel Chronograph Watch");
    expect(msg).toContain("SKU: MH-W-001");
    expect(msg).toContain("Qty: 2");
    expect(msg).toContain("₹1,899 × 2 = ₹3,798");
    expect(msg).toContain("2️⃣ Classic Designer Shoulder Bag");
    expect(msg).toContain("Variant: Tan");
    expect(msg).toContain("SKU: MH-B-002");
    expect(msg).toContain("Qty: 1");
    expect(msg).toContain("₹4,025");
  });

  it("includes subtotal, delivery, bold total and delivery-details section", () => {
    const msg = buildOrderMessage([watch, bag]);
    expect(msg).toContain("Subtotal: ₹7,823");
    expect(msg).toContain("Delivery: Free");
    expect(msg).toContain("*TOTAL: ₹7,823*");
    expect(msg).toContain("📦 Delivery details:");
    expect(msg).toContain("[name, address, pincode]");
    expect(msg).toContain("Order reference: https://matzhub.com/cart");
    expect(msg).toContain("Thank you.");
  });

  it("is customer-safe — no internal metadata", () => {
    const msg = buildOrderMessage([watch, bag]);
    for (const forbidden of [
      "supplier",
      "group",
      "ingestion",
      "worker",
      "cron",
      "database",
      "webhook",
      "automation",
      "telegram",
      "@g.us",
      "admin",
      "internal",
    ]) {
      expect(msg.toLowerCase()).not.toContain(forbidden);
    }
  });

  it("returns empty string for an empty cart", () => {
    expect(buildOrderMessage([])).toBe("");
  });
});
