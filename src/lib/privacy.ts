import "server-only";

/**
 * MANUFACTURER PRIVACY — CORE BUSINESS LOGIC, NOT A UI PREFERENCE.
 *
 * MatzHub is a bridge between manufacturers and resellers. The bridge only
 * works if neither side can route around it. That means supplier identity and
 * cost economics must never reach a non-admin surface: not the UI, not an API
 * response, not JSON-LD, not a feed, not a log line, not an export.
 *
 * Every public read path funnels through here. If you add a new endpoint that
 * returns product data, run it through `publicProduct` or the build will still
 * pass but you will have created a leak — so don't.
 */

/** Fields that must never appear in any non-admin payload. */
export const FORBIDDEN_PUBLIC_FIELDS = [
  "costPrice",
  "cost_price",
  "manufacturerId",
  "manufacturer_id",
  "manufacturer",
  "supplier",
  "supplierName",
  "sourceGroupId",
  "source_group_id",
  "sourceGroupName",
  "source_group_name",
  "messageId",
  "message_id",
  "imageHash",
  "image_hash",
  "contentHash",
  "content_hash",
  "marginPercent",
  "margin_percent",
  "healthScore",
  "resellerPrice",
  "reseller_price",
] as const;

/** Strip forbidden keys from any object graph before it leaves the server. */
export function stripPrivate<T extends Record<string, unknown>>(input: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if ((FORBIDDEN_PUBLIC_FIELDS as readonly string[]).includes(k)) continue;
    out[k] = v;
  }
  return out as Partial<T>;
}

export type PublicProduct = {
  id: string;
  slug: string;
  sku: string;
  title: string;
  subtitle: string | null;
  description: string;
  shortAnswer: string;
  brand: string | null;
  color: string | null;
  material: string | null;
  gender: string;
  specs: Record<string, string>;
  tags: string[];
  faqs: Array<{ q: string; a: string }>;
  images: string[];
  heroImage: string;
  altText: string;
  /** "Original Price" — red, strikethrough. */
  originalPrice: number;
  /** "Selling Price" — green, larger. The only live price. */
  sellingPrice: number;
  savePercent: number;
  availability: string;
  stockQty: number;
  ratingAvg: number;
  ratingCount: number;
  categoryId: string | null;
  createdAt: Date;
};

type ProductLike = {
  id: string;
  slug: string;
  sku?: string;
  title: string;
  subtitle?: string | null;
  description?: string;
  shortAnswer?: string;
  brand?: string | null;
  color?: string | null;
  material?: string | null;
  gender?: string;
  specs?: Record<string, string>;
  tags?: string[];
  faqs?: Array<{ q: string; a: string }>;
  images?: string[];
  heroImage: string;
  altText?: string;
  mrp: number;
  price: number;
  availability: string;
  stockQty?: number;
  ratingAvg?: number;
  ratingCount?: number;
  categoryId?: string | null;
  createdAt?: Date;
};

/**
 * Canonical public projection. `mrp` becomes `originalPrice` and `price`
 * becomes `sellingPrice`, so downstream code physically cannot confuse the two
 * or accidentally render cost.
 */
export function publicProduct(p: ProductLike): PublicProduct {
  const originalPrice = p.mrp;
  const sellingPrice = p.price;
  return {
    id: p.id,
    slug: p.slug,
    sku: p.sku ?? "",
    title: p.title,
    subtitle: p.subtitle ?? null,
    description: p.description ?? "",
    shortAnswer: p.shortAnswer ?? "",
    brand: p.brand ?? null,
    color: p.color ?? null,
    material: p.material ?? null,
    gender: p.gender ?? "unisex",
    specs: sanitizeSpecs(p.specs ?? {}),
    tags: p.tags ?? [],
    faqs: p.faqs ?? [],
    images: p.images ?? [],
    heroImage: p.heroImage,
    altText: p.altText ?? p.title,
    originalPrice,
    sellingPrice,
    savePercent: originalPrice > sellingPrice ? Math.round(((originalPrice - sellingPrice) / originalPrice) * 100) : 0,
    availability: p.availability,
    stockQty: p.stockQty ?? 0,
    ratingAvg: p.ratingAvg ?? 0,
    ratingCount: p.ratingCount ?? 0,
    categoryId: p.categoryId ?? null,
    createdAt: p.createdAt ?? new Date(),
  };
}

const SPEC_BLOCKLIST = /supplier|manufacturer name|factory|vendor|source group|whatsapp|contact|phone|cost/i;

/** Belt and braces: an AI-generated spec table must not smuggle supplier data. */
export function sanitizeSpecs(specs: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(specs)) {
    if (SPEC_BLOCKLIST.test(k)) continue;
    if (/\+?\d[\d\s-]{8,}/.test(v)) continue; // any phone-number-shaped value
    out[k] = v;
  }
  return out;
}

/**
 * Commercial terms that must never survive from a supplier caption into public
 * copy. Suppliers write things like "Cost 2400 Stock 5", "Rate 1850/-",
 * "wholesale 900 net", "moq 10 pcs" — all of which disclose either our buying
 * price or internal inventory.
 *
 * Matched per line. A line is dropped entirely rather than partially redacted,
 * because a half-scrubbed price line reads like broken copy on the storefront.
 */
const SUPPLIER_COMMERCIAL_LINE = new RegExp(
  [
    // Explicit cost/price/rate labels followed by a number.
    String.raw`\b(cost|costing|price|rate|rs|inr|mrp|amount|net|deal|offer)\b\s*[:=\-]?\s*\d`,
    // Bare Indian price shorthand: 2400/-, 2400 /-, 1850rs, ₹2400.
    String.raw`\d\s*/\s*-`,
    String.raw`[₹$]\s*\d`,
    String.raw`\b\d{3,6}\s*(rs|inr|rupees)\b`,
    // Inventory and trade terms.
    String.raw`\b(stock|qty|quantity|pcs|pieces|pairs|moq|min\.?\s*order|wholesale|dealer|distributor|margin|profit|per\s*piece|per\s*pc)\b`,
    // Channel solicitation that belongs to the supplier group, not our listing.
    String.raw`\b(dm|whatsapp|wa\.me|contact|call|book\s*now|order\s*now|limited\s*stock|new\s*arrival|resell(er)?\s*price)\b`,
    // Bare phone numbers.
    String.raw`\+?\d[\d\s-]{8,}`,
  ].join("|"),
  "i",
);

/**
 * Strips supplier-internal commercial lines from a raw WhatsApp caption,
 * keeping only descriptive product text.
 *
 * This is the boundary between what a supplier writes and what a customer
 * reads. Without it the buying price is republished verbatim: a caption of
 * "Chronograph 42mm\nCost 2400\nStock 5" produced a public description
 * containing "Cost 2400 Stock 5", exposing both our margin and our inventory.
 */
export function sanitizeSupplierCaption(caption: string): string {
  return caption
    .split(/\r?\n/)
    .map((line) => line.replace(/[*_~`#]/g, "").trim())
    .filter((line) => line.length > 3)
    .filter((line) => !SUPPLIER_COMMERCIAL_LINE.test(line))
    .map((line) => line.charAt(0).toUpperCase() + line.slice(1))
    .join(" ")
    .replace(/\s{2,}/g, " ")
    .trim();
}
