import "server-only";

import crypto from "node:crypto";
import { and, eq, gte, inArray, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { carts, notifications, orderItems, orders, productVariants, products } from "@/db/schema";
import { log } from "@/lib/tracing";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PHONE = /^(?:91)?([6-9]\d{9})$/;
const PINCODE = /^\d{6}$/;

export type OrderLineInput = { productId: string; qty: number; variant?: string };
export type CustomerOrderInput = {
  name: string;
  phone: string;
  email?: string;
  addressLine: string;
  city: string;
  state: string;
  pincode: string;
  notes?: string;
};
export type CreateOrderInput = {
  anonId: string;
  submissionKey: string;
  items: OrderLineInput[];
  customer: CustomerOrderInput;
};

export class OrderRequestError extends Error {
  constructor(
    message: string,
    readonly status: number = 400,
    readonly code: string = "invalid_order",
  ) {
    super(message);
    this.name = "OrderRequestError";
  }
}

const clean = (value: string, max: number) => value.trim().replace(/\s+/g, " ").slice(0, max);

function normalizePhone(input: string) {
  const digits = input.replace(/\D/g, "");
  const match = digits.match(PHONE);
  if (!match) throw new OrderRequestError("Enter a valid Indian mobile number.", 400, "invalid_phone");
  return `91${match[1]}`;
}

function normalizeCustomer(input: CustomerOrderInput) {
  const name = clean(input.name, 80);
  const addressLine = clean(input.addressLine, 300);
  const city = clean(input.city, 80);
  const state = clean(input.state, 80);
  const pincode = input.pincode.replace(/\D/g, "");
  const email = input.email ? clean(input.email, 150).toLowerCase() : null;
  const notes = input.notes ? clean(input.notes, 500) : null;

  if (name.length < 2 || addressLine.length < 5 || city.length < 2 || state.length < 2 || !PINCODE.test(pincode)) {
    throw new OrderRequestError("Check your delivery details and PIN code.", 400, "invalid_customer");
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new OrderRequestError("Enter a valid email address or leave it blank.", 400, "invalid_email");
  }

  return { name, phone: normalizePhone(input.phone), email, addressLine, city, state, pincode, notes };
}

function normalizeLines(input: OrderLineInput[]) {
  if (!Array.isArray(input) || input.length === 0) {
    throw new OrderRequestError("Your cart is empty.", 400, "empty_cart");
  }
  if (input.length > 24) throw new OrderRequestError("Too many items in one order.", 400, "too_many_items");

  const lines = new Map<string, OrderLineInput>();
  for (const raw of input) {
    const productId = typeof raw?.productId === "string" ? raw.productId : "";
    const qty = typeof raw?.qty === "number" ? Math.floor(raw.qty) : 0;
    const variant = typeof raw?.variant === "string" ? clean(raw.variant, 80) || undefined : undefined;
    if (!UUID.test(productId) || qty < 1 || qty > 10) {
      throw new OrderRequestError("One or more cart items are invalid.", 400, "invalid_cart");
    }
    const key = `${productId}:${variant ?? ""}`;
    const previous = lines.get(key);
    const nextQty = (previous?.qty ?? 0) + qty;
    if (nextQty > 10) throw new OrderRequestError("A single item is limited to 10 pieces.", 400, "quantity_limit");
    lines.set(key, { productId, qty: nextQty, variant });
  }
  return [...lines.values()];
}

function makeOrderNo() {
  const day = new Date().toISOString().slice(2, 10).replace(/-/g, "");
  return `MH${day}${crypto.randomBytes(5).toString("hex").toUpperCase()}`;
}

function makeAccessToken() {
  return crypto.randomBytes(24).toString("base64url");
}

export function shippingFor(subtotal: number) {
  return subtotal >= 999 ? 0 : 59;
}

/**
 * Postgres unique-violation detector.
 *
 * Drizzle wraps driver errors, so the pg SQLSTATE lives on `error.cause` (and
 * can nest further) rather than on the thrown object. Checking only the top
 * level meant a genuine 23505 from the submission_key index was never
 * recognised: a double-tapped Place Order returned HTTP 500 "We could not
 * submit your order" even though the first request had succeeded, so the
 * customer saw a failure for an order that actually existed.
 */
function uniqueViolation(error: unknown): boolean {
  for (let cursor: unknown = error, depth = 0; cursor && depth < 5; depth += 1) {
    if (typeof cursor !== "object") break;
    if ((cursor as { code?: string }).code === "23505") return true;
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return false;
}

export type CreatedOrder = {
  orderNo: string;
  accessToken: string;
  total: number;
  created: boolean;
};

/**
 * Creates one customer order request from live product data.
 *
 * Prices and availability never come from browser storage. The transaction
 * conditionally decrements each product/variant row, so two requests cannot
 * oversell the final item. `submissionKey` gives retries exactly-once behavior.
 */
export async function createCustomerOrder(raw: CreateOrderInput): Promise<CreatedOrder> {
  if (!UUID.test(raw.anonId) || !UUID.test(raw.submissionKey)) {
    throw new OrderRequestError("Your order session has expired. Please refresh and try again.", 400, "invalid_session");
  }

  const customer = normalizeCustomer(raw.customer);
  const lines = normalizeLines(raw.items);

  const findExisting = async () => {
    const [existing] = await db
      .select({ orderNo: orders.orderNo, accessToken: orders.accessToken, total: orders.total })
      .from(orders)
      .where(eq(orders.submissionKey, raw.submissionKey))
      .limit(1);
    if (!existing?.accessToken) return null;
    return { orderNo: existing.orderNo, accessToken: existing.accessToken, total: existing.total, created: false };
  };

  const alreadyCreated = await findExisting();
  if (alreadyCreated) {
    log.info("ORDER_DUPLICATE", { orderNo: alreadyCreated.orderNo, reason: "submission_key" });
    return alreadyCreated;
  }

  try {
    return await db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ orderNo: orders.orderNo, accessToken: orders.accessToken, total: orders.total })
        .from(orders)
        .where(eq(orders.submissionKey, raw.submissionKey))
        .limit(1);
      if (existing?.accessToken) {
        log.info("ORDER_DUPLICATE", { orderNo: existing.orderNo, reason: "transaction_race" });
        return { orderNo: existing.orderNo, accessToken: existing.accessToken, total: existing.total, created: false };
      }

      const productIds = [...new Set(lines.map((line) => line.productId))];
      const catalog = await tx
        .select({
          id: products.id,
          title: products.title,
          heroImage: products.heroImage,
          price: products.price,
          costPrice: products.costPrice,
          stockQty: products.stockQty,
          availability: products.availability,
          status: products.status,
          manufacturerId: products.manufacturerId,
        })
        .from(products)
        .where(inArray(products.id, productIds));
      const byId = new Map(catalog.map((product) => [product.id, product]));
      if (byId.size !== productIds.length) throw new OrderRequestError("One or more products are no longer available.", 409, "product_missing");

      const variants = await tx
        .select({ id: productVariants.id, productId: productVariants.productId, label: productVariants.label, stockQty: productVariants.stockQty })
        .from(productVariants)
        .where(inArray(productVariants.productId, productIds));
      const variantsByProduct = new Map<string, typeof variants>();
      for (const variant of variants) {
        variantsByProduct.set(variant.productId, [...(variantsByProduct.get(variant.productId) ?? []), variant]);
      }

      const resolved = lines.map((line) => {
        const product = byId.get(line.productId)!;
        if (product.status !== "published" || product.availability === "out_of_stock") {
          throw new OrderRequestError(`${product.title} is no longer available.`, 409, "unavailable_product");
        }
        const variantsForProduct = variantsByProduct.get(product.id) ?? [];
        const variant = line.variant ? variantsForProduct.find((candidate) => candidate.label === line.variant) : undefined;
        if (variantsForProduct.length && !variant) {
          throw new OrderRequestError(`Choose an available variant for ${product.title}.`, 409, "variant_required");
        }
        if (variant && variant.stockQty < line.qty) {
          throw new OrderRequestError(`${variant.label} is no longer available in that quantity.`, 409, "variant_unavailable");
        }
        return { ...line, product, variant };
      });

      const subtotal = resolved.reduce((sum, line) => sum + line.product.price * line.qty, 0);
      const shipping = shippingFor(subtotal);
      const total = subtotal + shipping;
      const orderNo = makeOrderNo();
      const accessToken = makeAccessToken();

      const [created] = await tx
        .insert(orders)
        .values({
          orderNo,
          submissionKey: raw.submissionKey,
          accessToken,
          anonId: raw.anonId,
          customerName: customer.name,
          phone: customer.phone,
          email: customer.email,
          addressLine: customer.addressLine,
          city: customer.city,
          state: customer.state,
          pincode: customer.pincode,
          notes: customer.notes,
          subtotal,
          discount: 0,
          shipping,
          total,
          costTotal: resolved.reduce((sum, line) => sum + line.product.costPrice * line.qty, 0),
          profit: resolved.reduce((sum, line) => sum + (line.product.price - line.product.costPrice) * line.qty, 0),
          paymentMode: "prepaid",
          paymentStatus: "pending",
          status: "placed",
          timeline: [{ at: new Date().toISOString(), status: "placed", note: "Order request submitted online" }],
        })
        .returning({ id: orders.id });

      for (const line of resolved) {
        if (line.variant) {
          const [variantUpdated] = await tx
            .update(productVariants)
            .set({ stockQty: sql`greatest(0, ${productVariants.stockQty} - ${line.qty})` })
            .where(and(eq(productVariants.id, line.variant.id), gte(productVariants.stockQty, line.qty)))
            .returning({ id: productVariants.id });
          if (!variantUpdated) throw new OrderRequestError(`${line.variant.label} just sold out. Please try again.`, 409, "variant_unavailable");
        }

        const [productUpdated] = await tx
          .update(products)
          .set({
            stockQty: sql`greatest(0, ${products.stockQty} - ${line.qty})`,
            availability: sql`case
              when ${products.stockQty} - ${line.qty} <= 0 then 'out_of_stock'
              when ${products.stockQty} - ${line.qty} < 5 then 'low_stock'
              else ${products.availability}
            end`,
            orders: sql`${products.orders} + ${line.qty}`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(products.id, line.product.id),
              eq(products.status, "published"),
              ne(products.availability, "out_of_stock"),
              gte(products.stockQty, line.qty),
            ),
          )
          .returning({ id: products.id });
        if (!productUpdated) throw new OrderRequestError(`${line.product.title} just sold out. Please try again.`, 409, "unavailable_product");

        await tx.insert(orderItems).values({
          orderId: created.id,
          productId: line.product.id,
          manufacturerId: line.product.manufacturerId,
          titleSnapshot: line.product.title,
          imageSnapshot: line.product.heroImage,
          variantLabel: line.variant?.label ?? null,
          qty: line.qty,
          unitPrice: line.product.price,
          unitCost: line.product.costPrice,
          lineTotal: line.product.price * line.qty,
        });
      }

      await tx.update(carts).set({ status: "converted", updatedAt: new Date() }).where(and(eq(carts.anonId, raw.anonId), eq(carts.status, "open")));

      const orderUrl = `${process.env.NEXT_PUBLIC_SITE_URL || "https://matzhub.com"}/order/${orderNo}?token=${accessToken}`;
      await tx.insert(notifications).values([
        {
          channel: "telegram",
          audience: "ops",
          recipient: "ops",
          template: "new_order",
          payload: { orderNo, total, city: customer.city, items: resolved.length },
        },
        {
          channel: "whatsapp",
          audience: "customer",
          recipient: customer.phone,
          template: "order_received",
          payload: { orderNo, total, orderUrl },
        },
      ]);

      log.info("ORDER_CREATED", { orderNo, total, lineItems: resolved.length });
      return { orderNo, accessToken, total, created: true };
    });
  } catch (error) {
    if (error instanceof OrderRequestError) throw error;
    if (uniqueViolation(error)) {
      // The winning transaction may still be committing when we get here, so
      // a single lookup can legitimately miss. Re-check briefly rather than
      // reporting a failure for an order that is about to exist.
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const duplicate = await findExisting();
        if (duplicate) {
          log.info("ORDER_DUPLICATE", { orderNo: duplicate.orderNo, reason: "unique_constraint" });
          return duplicate;
        }
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
    }
    throw new OrderRequestError("We could not submit your order. Please try again.", 500, "order_failed");
  }
}
