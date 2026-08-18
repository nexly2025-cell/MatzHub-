import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * MatzHub has no payment gateway and does not offer cash on delivery.
 *
 * Both claims had crept back into the storefront: the cart footer advertised
 * "Cash on Delivery / UPI", the product page listed a Payment row saying the
 * same, the refund policy described refunding "cash-on-delivery orders", and
 * the JSON-LD store node declared `paymentAccepted`. Every one of those tells
 * a customer money changes hands on the site, which is untrue.
 *
 * These assertions make any reintroduction a build failure. The only permitted
 * mentions are explicit denials ("cash on delivery is not offered").
 */

const ROOTS = ["src/app", "src/components"];

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__") continue;
      out.push(...(await walk(full)));
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

async function sources() {
  const files: Array<{ file: string; text: string }> = [];
  for (const root of ROOTS) {
    for (const file of await walk(root)) {
      files.push({ file, text: await readFile(file, "utf8") });
    }
  }
  return files;
}

describe("no payment flow is ever implied", () => {
  it("never advertises cash on delivery as available", async () => {
    for (const { file, text } of await sources()) {
      const claims = text
        .split("\n")
        .filter((l) => /cash[ -]on[ -]delivery|\bCOD\b/i.test(l))
        .filter((l) => !/not offered|no cash on delivery|no COD|nothing is settled/i.test(l));
      expect(claims, `${file} advertises cash on delivery`).toEqual([]);
    }
  });

  it("declares no accepted payment methods in structured data", async () => {
    for (const { file, text } of await sources()) {
      expect(text, `${file} declares paymentAccepted`).not.toContain("paymentAccepted");
    }
  });

  it("never claims a payment succeeded or was captured", async () => {
    for (const { file, text } of await sources()) {
      expect(text, `${file} implies a completed payment`).not.toMatch(
        /payment (successful|received|captured|confirmed)/i,
      );
    }
  });

  it("routes checkout to WhatsApp, not to a gateway", async () => {
    const cart = await readFile("src/app/cart/page.tsx", "utf8");
    // The order is recorded first, then handed to WhatsApp with its number.
    expect(cart).toContain('fetch("/api/orders"');
    expect(cart).toContain("waLink(message)");
    expect(cart).toContain("buildOrderMessage(cart)");
    // A single authoritative order message — the cart must not build its own.
    expect(cart).not.toContain("buildWhatsAppMessage");
    // A single authoritative totals helper — no inline arithmetic.
    expect(cart).toContain("cartTotals(cart)");
  });
});

describe("order submission is server-authoritative", () => {
  it("never trusts a client-supplied price", async () => {
    const route = await readFile("src/app/api/orders/route.ts", "utf8");
    // The client sends ids and quantities only. Anything price-shaped read off
    // the request body would let a tampered cart set its own total.
    expect(route).not.toMatch(/body\.(items\[\d*\]\.)?price/);
    expect(route).toContain("price: products.price");
    expect(route).toContain("unitPrice: p.price");
  });

  it("records the order as unpaid", async () => {
    const route = await readFile("src/app/api/orders/route.ts", "utf8");
    expect(route).toContain('paymentStatus: "pending"');
    expect(route).not.toMatch(/paymentStatus:\s*"paid"/);
    expect(route).toContain('status: "placed"');
  });

  it("writes the order and its items in one transaction", async () => {
    const route = await readFile("src/app/api/orders/route.ts", "utf8");
    expect(route).toContain("db.transaction");
    expect(route).toContain("insert(orderItems)");
  });
});

describe("an order cannot be duplicated", () => {
  it("derives an idempotency key and enforces it uniquely", async () => {
    const route = await readFile("src/app/api/orders/route.ts", "utf8");
    // Key must cover who is buying, what, and how many — not just the phone.
    expect(route).toContain("idempotencyKey");
    expect(route).toContain("createHash(\"sha256\")");
    expect(route).toMatch(/wanted\.map\(\(i\) => `\$\{i\.productId\}:\$\{i\.qty\}/);
    // A targeted conflict clause would throw on an idempotency collision
    // instead of swallowing it, aborting the transaction.
    expect(route).not.toContain("onConflictDoNothing({ target: orders.orderNo })");
    expect(route).toContain("onConflictDoNothing()");
  });

  it("declares the unique index that makes the race safe", async () => {
    const schema = await readFile("src/db/schema.ts", "utf8");
    expect(schema).toContain('uniqueIndex("orders_idempotency_uidx")');
  });
});
