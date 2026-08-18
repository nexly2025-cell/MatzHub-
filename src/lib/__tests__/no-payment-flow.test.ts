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

  it("routes cart through delivery details and the WhatsApp handoff, not a gateway", async () => {
    const cart = await readFile("src/app/cart/page.tsx", "utf8");
    const checkout = await readFile("src/app/checkout/page.tsx", "utf8");
    // Cart stays focused on lines and totals; checkout records the request.
    expect(cart).toContain('href="/checkout"');
    expect(checkout).toContain('fetch("/api/orders"');
    expect(checkout).toContain("waLink(buildOrderMessage(cart))");
    expect(cart).not.toContain("buildWhatsAppMessage");
    expect(cart).toContain("cartTotals(cart)");
  });
});

describe("order submission is server-authoritative", () => {
  it("never trusts a client-supplied price", async () => {
    const service = await readFile("src/lib/orders.ts", "utf8");
    // The browser submits ids, quantities, and delivery details only. Live
    // product rows remain the source of every amount written to an order.
    expect(service).toContain("price: products.price");
    expect(service).toContain("unitPrice: line.product.price");
    expect(service).not.toMatch(/raw\.items.*price/);
  });

  it("records the order as unpaid", async () => {
    const service = await readFile("src/lib/orders.ts", "utf8");
    expect(service).toContain('paymentStatus: "pending"');
    expect(service).not.toMatch(/paymentStatus:\s*"paid"/);
    expect(service).toContain('status: "placed"');
  });

  it("writes the order and its items in one transaction", async () => {
    const service = await readFile("src/lib/orders.ts", "utf8");
    expect(service).toContain("db.transaction");
    expect(service).toContain("insert(orderItems)");
  });
});

describe("an order cannot be duplicated", () => {
  it("uses a browser submission key and server-side unique recovery", async () => {
    const checkout = await readFile("src/app/checkout/page.tsx", "utf8");
    const service = await readFile("src/lib/orders.ts", "utf8");
    expect(checkout).toContain("submissionKey: orderRequestKey(cart)");
    expect(service).toContain("where(eq(orders.submissionKey, raw.submissionKey))");
    expect(service).toContain("uniqueViolation(error)");
    expect(service).toContain("ORDER_DUPLICATE");
  });

  it("declares the unique submission key index that settles concurrent requests", async () => {
    const schema = await readFile("src/db/schema.ts", "utf8");
    expect(schema).toContain('uniqueIndex("orders_submission_key_uidx")');
  });
});
