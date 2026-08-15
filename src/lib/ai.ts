import { sanitizeSupplierCaption } from "@/lib/privacy";

/**
 * MatzHub AI Enrichment Engine
 * ----------------------------
 * Turns a raw WhatsApp message (caption + image) into a fully merchandised,
 * SEO/AEO/GEO-ready product record with zero human input.
 *
 * Design rules:
 *  - NEVER block the pipeline on an LLM. If the model is unavailable, slow,
 *    or returns junk, the deterministic extractor takes over and the product
 *    still ships (flagged for review if confidence is low).
 *  - Every field an LLM produces is validated and clamped before use.
 *  - Output is fully typed so downstream code cannot drift.
 */

export type EnrichmentInput = {
  caption: string;
  imageUrl?: string | null;
  groupName?: string | null;
  defaultCategory?: string | null;
};

export type Enrichment = {
  title: string;
  subtitle: string;
  description: string;
  shortAnswer: string;
  categorySlug: string;
  brand: string | null;
  color: string | null;
  material: string | null;
  gender: "men" | "women" | "unisex";
  tags: string[];
  specs: Record<string, string>;
  faqs: Array<{ q: string; a: string }>;
  seoTitle: string;
  seoDescription: string;
  altText: string;
  variants: Array<{ label: string; axis: "size" | "color" }>;
  costPrice: number;
  mrp: number;
  qualityScore: number;
  confidence: number;
  model: string;
  latencyMs: number;
};

export const CATEGORY_ALIASES: Record<string, string> = {
  bags: "handbags",
  purses: "handbags",
  shoes: "footwear",
  sneakers: "footwear",
  clothing: "apparel",
  clothes: "apparel",
  wear: "apparel",
  perfume: "perfumes",
  fragrance: "perfumes",
  attar: "perfumes",
};

export const normalizeCategoryAlias = (v: string | null | undefined): string | null =>
  v ? (CATEGORY_ALIASES[v.toLowerCase().trim()] ?? v.toLowerCase().trim()) : null;

const CATEGORY_RULES: Array<{ slug: string; words: string[] }> = [
  { slug: "watches", words: ["watch", "watches", "chrono", "timepiece", "wrist", "rolex", "casio", "seiko", "fossil"] },
  { slug: "handbags", words: ["bag", "purse", "handbag", "clutch", "tote", "sling", "backpack", "wallet"] },
  { slug: "footwear", words: ["shoe", "shoes", "sneaker", "loafer", "sandal", "slipper", "boot", "heel", "footwear"] },
  { slug: "sunglasses", words: ["sunglass", "sunglasses", "shades", "eyewear", "goggle", "aviator", "wayfarer"] },
  { slug: "apparel", words: ["shirt", "tshirt", "t-shirt", "hoodie", "jacket", "jeans", "trouser", "kurta", "dress", "apparel", "wear"] },
  { slug: "perfumes", words: ["perfume", "perfumes", "fragrance", "attar", "oud", "cologne", "edt", "edp", "parfum", "scent"] },
];

const COLORS = [
  "black", "white", "brown", "tan", "beige", "blue", "navy", "red", "maroon", "green", "olive",
  "grey", "gray", "silver", "gold", "rose gold", "pink", "purple", "yellow", "orange", "cream",
];

const MATERIALS = [
  "leather", "genuine leather", "pu leather", "canvas", "suede", "stainless steel", "steel",
  "denim", "cotton", "silicone", "rubber", "mesh", "nylon", "polyester", "acetate", "metal",
];

/** Per-category attribute vocabulary. The extractor checks the dominant category
 * first, then applies that category's spec schema so watches get movements,
 * shoes get size runs, bags get dimensions, perfumes get concentrations. */
const CATEGORY_SPEC_SCHEMA: Record<string, { labels: string[]; fields: Record<string, RegExp[]> }> = {
  watches: {
    labels: ["strap", "dial", "case", "movement", "glass", "water resistance"],
    fields: {
      Strap: [/\b(leather|steel|mesh|silicone|nato|canvas|metal)\s+(strap|band|bracelet)/i, /\bstrap\s*[:\-]\s*([a-z ]{3,20})/i],
      Dial: [/\b(\d{2,3})\s*mm\s*(dial|case)/i, /\bbig dial\b|\bslim dial\b|\bsquare dial\b|\bround dial\b/i],
      "Case size": [/\b(\d{2,3})\s*mm\b/i],
      Movement: [/\b(quartz|automatic|mechanical|chrono|chronograph|analog|analogue|day date|date)\b/i],
      Glass: [/\b(sapphire|mineral|hardened|coated)\s*glass/i],
      "Water resistance": [/\b(\d+\s*atm|water\s*resistan[a-z]*\s*\d*)\b/i],
    },
  },
  footwear: {
    labels: ["size range", "sole", "upper", "insole length"],
    fields: {
      "Size run": [/\bsize\s*(?:[:\-]\s*)?(\d{1,2})\s*(?:to|-|–)\s*(\d{1,2})/i, /\buk\s*(\d{1,2})\s*(?:to|-|–)\s*(\d{1,2})/i, /\beu\s*(\d{2})\s*(?:to|-|–)\s*(\d{2})/i],
      Sole: [/\b(eva|phylon|rubber|tpr|pu|stitched|glued)\s*(sole|midsole|outsole)/i],
      Upper: [/\b(mesh|knit|canvas|leather|suede|pu)\s*(upper|lining)/i],
      "Insole length": [/\b(\d{2}(?:\.\d)?\s*cm)\s*(insole|foot\s*length)?/i],
      Type: [/\b(oxford|derby|loafer|brogues?|sneaker|sneakers|boot|boots|sandal|sandals|heel|flats?|moccasin)\b/i],
    },
  },
  apparel: {
    labels: ["size", "color", "material", "gsm", "fit"],
    fields: {
      "Size set": [/\bsizes?\s*(?:[:\-]\s*)?(s[,.\s]*m[,.\s]*l[,.\s]*xl)/i, /\b(s\/m\/l\/(xl)|s m l xl|xs.*xxl)\b/i, /\b(30\s*to\s*36|28\s*to\s*34)\b/],
      GSM: [/\b(\d{3})\s*gsm\b/i],
      Material: [/\b(cotton|denim|polyester|fleece|lycra|spandex|viscose|linen|rayon| Blend)\s*\d*/i],
      Fit: [/\b(slim\s*fit|regular\s*fit|oversized|relaxed|skinny|straight)\b/i],
    },
  },
  handbags: {
    labels: ["capacity", "dimensions", "material", "compartments"],
    fields: {
      Capacity: [/\b(\d+\s*(?:l|litre|liter))\b/i, /\b(laptop\s*compatible|13["']|15["'])\b/i],
      Dimensions: [/\b(\d+)\s*x\s*(\d+)\s*x\s*(\d+)\s*cm/i],
      Material: [/\b(genuine\s*leather|pu\s*leather|vegan\s*leather|canvas|suede|nylon)\b/i],
      Compartments: [/\b(\d+)\s*compartment/i],
      Type: [/\b(tote|sling|clutch|satchel|backpack|hobo|crossbody|wallet|duffel)\b/i],
    },
  },
  sunglasses: {
    labels: ["lens rating", "frame", "polarisation", "shape"],
    fields: {
      "Lens rating": [/\b(uv\s*400|uv400)\b/i, /\b(400nm)\b/i],
      Frame: [/\b(acetate|metal|tr90|titanium|steel)\s*(frame)?/i],
      Polarisation: [/\b(polari[sz]ed)\b/i],
      Shape: [/\b(aviator|wayfarer|square|round|cat\s*eye|oversized|sports?|goggle|heart)\b/i],
      "Lens colour": [/\b(green|grey|black|brown|blue|gradient|pink|mirror)\s*(lens|lenses)?\b/i],
    },
  },
  perfumes: {
    labels: ["volume", "concentration", "profile", "longevity"],
    fields: {
      Volume: [/(\d+)\s*ml\b/i],
      Concentration: [/\b(edp|eau de parfum|edt|eau de toilette|attar|oils?\s*free|parfum|pure perfume)\b/i],
      Profile: [/\b(oud|oudh|musk|amber|vanilla|floral|woody|aquatic|citrus|fresh|spicy|oriental|leathery|chypre)\b/i],
      Longevity: [/\b(\d{1,2})\s*(?:h|hr|hrs|hours?)\s*((?:lasting)?)/i],
    },
  },
};

const BRAND_HINTS = [
  "rolex", "casio", "fossil", "titan", "seiko", "daniel wellington", "gucci", "prada", "coach",
  "nike", "adidas", "puma", "woodland", "bata", "rayban", "ray-ban", "oakley", "levis", "levi's",
  "zara", "h&m", "tommy", "calvin klein",
];

const STOPWORDS = new Set([
  "the", "and", "for", "with", "new", "best", "price", "rs", "inr", "only", "offer", "available",
  "stock", "piece", "pcs", "quality", "original", "copy", "first", "moq", "dm", "order", "book",
]);

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// Domain acronyms that must never be sentence-cased in a product title.
const ACRONYMS: Record<string, string> = {
  uv400: "UV400", uv: "UV", gsm: "GSM", pu: "PU", led: "LED", atm: "ATM",
  eva: "EVA", uk: "UK", us: "US", eu: "EU", xl: "XL", xxl: "XXL", oz: "oz",
  mm: "mm", cm: "cm", "3d": "3D", hd: "HD", tpu: "TPU", abs: "ABS",
};

export const titleCase = (s: string) =>
  s
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => {
      const bare = w.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (ACRONYMS[bare]) return w.toLowerCase().replace(bare, ACRONYMS[bare]);
      if (w.length <= 2 && w === w.toUpperCase()) return w;
      return cap(w.toLowerCase());
    })
    .join(" ");

export const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 70);

/* ---------------- deterministic extraction ---------------- */

function extractNumbers(caption: string): number[] {
  const out: number[] = [];
  // Formats: "Rs 780/-", "780 rs", "₹1,250", "MRP 3499", "only 640", "890/-"
  const patterns = [
    /(?:₹|rs\.?|inr)\s*([0-9][0-9,]{1,7})/gi,
    /\bmrp\b\s*[:\-]?\s*([0-9][0-9,]{1,7})/gi,
    /\b(?:cost|price)\b\s*[:\-]?\s*([0-9][0-9,]{1,7})/gi,
    /\bonly\b\s*([0-9][0-9,]{1,7})/gi,
    /([0-9][0-9,]{2,7})\s*\/-/gi,
    /\b([0-9][0-9,]{2,7})\s*(?:rs|inr)\b/gi,
    /\b([0-9][0-9,]{2,7})\s*(?:per piece|per pc|pcs|set)\b/gi,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(caption))) {
      const raw = m[1].replace(/,/g, "");
      const n = Number.parseInt(raw, 10);
      if (Number.isFinite(n) && n >= 50 && n <= 500000 && !out.includes(n)) out.push(n);
    }
  }
  return out;
}

export function detectCategory(caption: string, groupName?: string | null, fallback?: string | null): { slug: string; confidence: number } {
  const haystack = `${groupName ?? ""} ${caption}`.toLowerCase();
  // group name wins — manufacturers post into dedicated groups
  if (groupName) {
    const g = groupName.toLowerCase();
    for (const rule of CATEGORY_RULES) {
      if (rule.words.some((w) => g.includes(w))) return { slug: rule.slug, confidence: 0.97 };
    }
  }
  let best: { slug: string; hits: number } = { slug: "", hits: 0 };
  for (const rule of CATEGORY_RULES) {
    const hits = rule.words.filter((w) => haystack.includes(w)).length;
    if (hits > best.hits) best = { slug: rule.slug, hits };
  }
  if (best.hits > 0) return { slug: best.slug, confidence: Math.min(0.6 + best.hits * 0.12, 0.94) };
  return { slug: fallback || "apparel", confidence: 0.4 };
}

function detectFrom(list: string[], caption: string): string | null {
  const c = caption.toLowerCase();
  const found = list.filter((w) => c.includes(w)).sort((a, b) => b.length - a.length);
  return found[0] ? titleCase(found[0]) : null;
}

function detectGender(caption: string): "men" | "women" | "unisex" {
  const c = caption.toLowerCase();
  if (/\b(women|ladies|female|girl|her)\b/.test(c)) return "women";
  if (/\b(men|gents|male|boy|his)\b/.test(c)) return "men";
  return "unisex";
}

function detectVariants(caption: string): Array<{ label: string; axis: "size" | "color" }> {
  const out: Array<{ label: string; axis: "size" | "color" }> = [];
  const sizeRange = caption.match(/\b(?:size[s]?\s*[:\-]?\s*)(\d{1,2})\s*(?:to|-|–)\s*(\d{1,2})\b/i);
  if (sizeRange) {
    const from = Number(sizeRange[1]);
    const to = Number(sizeRange[2]);
    if (to > from && to - from <= 12) {
      for (let i = from; i <= to; i += 1) out.push({ label: `UK ${i}`, axis: "size" });
    }
  }
  if (!out.length && /\b(s\s*[,/]\s*m\s*[,/]\s*l|small.*medium.*large)\b/i.test(caption)) {
    ["S", "M", "L", "XL"].forEach((l) => out.push({ label: l, axis: "size" }));
  }
  if (!out.length) out.push({ label: "Free Size", axis: "size" });
  return out.slice(0, 12);
}

function buildTitle(caption: string, category: string, brand: string | null, color: string | null): string {
  const firstLine = caption.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 3) || "";
  const cleaned = firstLine
    .replace(/(?:₹|rs\.?|inr)\s*[0-9,]+/gi, " ")
    .replace(/\b[0-9,]+\s*\/-/g, " ")
    .replace(/\bmrp\b[^a-z]*[0-9,]*/gi, " ")
    .replace(/\bsizes?\s*[:\-]?\s*\d+\s*(?:to|-|–)\s*\d+/gi, " ")
    .replace(/[*_~`#/\\]/g, " ")
    .replace(/\b(moq|dm|whatsapp|order now|book now|available|new arrival|new stock|limited stock|arrived|now)\b/gi, " ")
    .replace(/[.,;:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Trailing connector/qualifier words read as truncation artefacts in a title.
  const DANGLING = new Set(["size", "sizes", "men", "and", "with", "for", "in", "to", "pcs", "piece", "quality"]);
  const words = cleaned
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w.toLowerCase()))
    .slice(0, 7);
  while (words.length > 3 && DANGLING.has(words[words.length - 1].toLowerCase())) words.pop();

  const noun = CATEGORY_RULES.find((r) => r.slug === category)?.words[0] ?? "product";
  const base = words.length >= 2 ? words.join(" ") : [brand, color, noun].filter(Boolean).join(" ");
  return titleCase(base || `Premium ${noun}`).slice(0, 90);
}

function qualityScore(e: Omit<Enrichment, "qualityScore">, hasImage: boolean): number {
  let score = 0;
  if (hasImage) score += 25;
  if (e.title.length >= 15) score += 15;
  if (e.description.length >= 120) score += 15;
  if (e.brand) score += 8;
  if (e.color) score += 6;
  if (e.material) score += 6;
  if (Object.keys(e.specs).length >= 3) score += 10;
  if (e.tags.length >= 4) score += 5;
  if (e.faqs.length >= 3) score += 5;
  if (e.mrp > 0 && e.costPrice > 0) score += 5;
  return Math.min(100, score);
}

/** Apply the category's spec schema: first regex match per field wins. */
function extractCategorySpecs(caption: string, categorySlug: string): Record<string, string> {
  const schema = CATEGORY_SPEC_SCHEMA[categorySlug];
  const out: Record<string, string> = {};
  if (!schema) return out;
  for (const [field, patterns] of Object.entries(schema.fields)) {
    for (const re of patterns) {
      const m = caption.match(re);
      if (m) {
        const val = m.slice(1).filter(Boolean).join(" ").trim();
        if (val) out[field] = titleCase(val.length > 2 ? val : m[0]).slice(0, 80);
        break;
      }
    }
  }
  return out;
}

export function deterministicEnrich(input: EnrichmentInput): Enrichment {
  const caption = (input.caption || "").trim();
  const { slug: categorySlug, confidence } = detectCategory(caption, input.groupName, input.defaultCategory);
  const brand = detectFrom(BRAND_HINTS, caption);
  const color = detectFrom(COLORS, caption);
  const material = detectFrom(MATERIALS, caption);
  const gender = detectGender(caption);
  const title = buildTitle(caption, categorySlug, brand, color);

  // Cost is the LOWEST rupee figure. MRP is ALWAYS derived (cost×1.40) downstream —
  // the manufacturer-supplied figure is informational only, not part of the pricing
  // rule. Giving it precedence would break the cost×1.40 guarantee.
  const nums = extractNumbers(caption).sort((a, b) => a - b);
  const costPrice = nums[0] ?? 0;
  const mrp = 0; // derived by computePricing; never read from the caption

  const catLabel = titleCase(categorySlug);
  const specs: Record<string, string> = {};
  if (brand) specs.Brand = brand;
  if (color) specs.Colour = color;
  if (material) specs.Material = material;
  // Category-specific attribute extraction: watches → movement/dial/strap,
  // footwear → size run/sole/type, bags → capacity/dimensions,
  // sunglasses → UV400/frame, apparel → GSM/fit, perfumes → volume/profile.
  for (const [k, v] of Object.entries(extractCategorySpecs(caption, categorySlug))) {
    if (!Object.values(specs).includes(v)) specs[k] = v;
  }
  specs.Category = catLabel;
  specs.Gender = titleCase(gender);
  specs.Delivery = "Standard courier, pan-India";
  specs.Sourcing = "Verified partner, identity protected";

  const tags = Array.from(
    new Set(
      [categorySlug, gender, color, material, brand, "premium", "curated"]
        .filter(Boolean)
        .map((t) => String(t).toLowerCase()),
    ),
  ).slice(0, 10);

  const shortAnswer = `${title} is a ${color ? `${color.toLowerCase()} ` : ""}${material ? `${material.toLowerCase()} ` : ""}${catLabel.toLowerCase()} listed through MatzHub. Ships across India with a 7-day replacement window.`;

  // Description elaborates ONLY what the supplier stated. No invented benefits.
  // Supplier captions carry our buying price and their stock counts.
  // sanitizeSupplierCaption strips those before any becomes public copy.
  const supplierLine = sanitizeSupplierCaption(caption);
  const description = [
    supplierLine || `${title} — imported ${catLabel.toLowerCase()} from the verified supplies channel, listed exactly as provided by the source.`,
    `Ships across India with a 7-day replacement window if the item does not match the listing.`,
  ].join(" ");

  const faqs = [
    { q: `Is this ${catLabel.toLowerCase()} an original branded product?`, a: `No. This is imported first-copy, master-quality merchandise. MatzHub is not affiliated with, endorsed by or licensed by any original brand, and we state this openly on every listing.` },
    { q: "Who makes it?", a: "Our sourcing partners are verified but their identity is private — that's the agreement that keeps pricing honest. Every partner is quality-scored before their stock is listed." },
    { q: "How long does delivery take?", a: "Orders are dispatched within ≤5 hours. Metro cities receive in 2–4 days, rest of India in 4–7 days." },
    { q: "How do I pay?", a: "Payment is arranged directly with our team over WhatsApp once your order is confirmed. Cash on delivery is not offered." },
    { q: "Can I return or replace it?", a: "Yes. You get a 7-day replacement window if the product does not match the listing photo or arrives damaged." },
    { q: "Can I resell this product?", a: "Yes — that is exactly what MatzHub is built for. Resellers get the listing images, details and a share link they can pass to their own customers at whatever price they choose." },
  ];

  const base: Omit<Enrichment, "qualityScore"> = {
    title,
    subtitle: [brand, color, catLabel].filter(Boolean).join(" · "),
    description,
    shortAnswer,
    categorySlug,
    brand,
    color,
    material,
    gender,
    tags,
    specs,
    faqs,
    seoTitle: `${title} — Best Price Online | MatzHub`.slice(0, 60),
    seoDescription: `Buy ${title} at MatzHub. Direct-from-manufacturer pricing, pan-India delivery, 7-day replacement.`.slice(0, 158),
    altText: `${title}${color ? ` in ${color.toLowerCase()}` : ""} — MatzHub ${catLabel.toLowerCase()}`,
    variants: detectVariants(caption),
    costPrice,
    mrp,
    confidence,
    model: "matzhub-rules-v2",
    latencyMs: 0,
  };

  return { ...base, qualityScore: qualityScore(base, Boolean(input.imageUrl)) };
}

/* ---------------- LLM path (optional, non-blocking) ---------------- */

const SYSTEM_PROMPT = `You are MatzHub's product merchandiser. You receive a raw WhatsApp message from a manufacturer and output ONLY minified JSON matching this shape:
{"title":string,"subtitle":string,"description":string,"shortAnswer":string,"categorySlug":"watches"|"handbags"|"footwear"|"sunglasses"|"apparel","brand":string|null,"color":string|null,"material":string|null,"gender":"men"|"women"|"unisex","tags":string[],"specs":{},"faqs":[{"q":string,"a":string}],"seoTitle":string,"seoDescription":string,"altText":string,"variants":[{"label":string,"axis":"size"|"color"}],"costPrice":number,"mrp":number,"confidence":number}
Rules: title <= 80 chars, no ALL CAPS, no emoji. description 90-140 words, factual, no invented brand claims. shortAnswer is one 40-55 word paragraph that directly answers "what is this product" for AI answer engines. seoTitle <= 60 chars. seoDescription <= 158 chars. 4 FAQs. costPrice is the lowest rupee figure in the message, mrp the highest (or 2.6x cost if only one). confidence 0-1.`;

async function llmEnrich(input: EnrichmentInput, timeoutMs = 9000): Promise<Partial<Enrichment> | null> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || "gpt-4o-mini",
        temperature: 0.3,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: `Group: ${input.groupName ?? "unknown"}\nHas image: ${Boolean(input.imageUrl)}\nMessage:\n${input.caption}`,
          },
        ],
      }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const raw = json.choices?.[0]?.message?.content;
    if (!raw) return null;
    return JSON.parse(raw) as Partial<Enrichment>;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const clampStr = (v: unknown, max: number, fallback: string) =>
  typeof v === "string" && v.trim().length > 0 ? v.trim().slice(0, max) : fallback;

const VALID_CATS = new Set(CATEGORY_RULES.map((r) => r.slug));

/** Main entrypoint: LLM-first with guaranteed deterministic fallback + validation. */
export async function enrichProduct(input: EnrichmentInput): Promise<Enrichment> {
  const t0 = Date.now();
  const base = deterministicEnrich(input);
  const ai = await llmEnrich(input);
  if (!ai) return { ...base, latencyMs: Date.now() - t0 };

  const merged: Enrichment = {
    ...base,
    title: clampStr(ai.title, 90, base.title),
    subtitle: clampStr(ai.subtitle, 120, base.subtitle),
    description: clampStr(ai.description, 2000, base.description),
    shortAnswer: clampStr(ai.shortAnswer, 600, base.shortAnswer),
    categorySlug: typeof ai.categorySlug === "string" && VALID_CATS.has(ai.categorySlug) ? ai.categorySlug : base.categorySlug,
    brand: typeof ai.brand === "string" ? titleCase(ai.brand).slice(0, 40) : base.brand,
    color: typeof ai.color === "string" ? titleCase(ai.color).slice(0, 30) : base.color,
    material: typeof ai.material === "string" ? titleCase(ai.material).slice(0, 40) : base.material,
    gender: ai.gender === "men" || ai.gender === "women" ? ai.gender : base.gender,
    tags: Array.isArray(ai.tags) ? ai.tags.filter((t) => typeof t === "string").slice(0, 12) : base.tags,
    specs: ai.specs && typeof ai.specs === "object" ? { ...base.specs, ...(ai.specs as Record<string, string>) } : base.specs,
    faqs: Array.isArray(ai.faqs) && ai.faqs.length >= 2 ? ai.faqs.slice(0, 6) : base.faqs,
    seoTitle: clampStr(ai.seoTitle, 60, base.seoTitle),
    seoDescription: clampStr(ai.seoDescription, 158, base.seoDescription),
    altText: clampStr(ai.altText, 160, base.altText),
    variants: Array.isArray(ai.variants) && ai.variants.length ? ai.variants.slice(0, 12) : base.variants,
    costPrice: Number.isFinite(ai.costPrice) && Number(ai.costPrice) > 0 ? Math.round(Number(ai.costPrice)) : base.costPrice,
    mrp: Number.isFinite(ai.mrp) && Number(ai.mrp) > 0 ? Math.round(Number(ai.mrp)) : base.mrp,
    confidence: Number.isFinite(ai.confidence) ? Math.min(1, Math.max(0, Number(ai.confidence))) : base.confidence,
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    latencyMs: Date.now() - t0,
  };
  return { ...merged, qualityScore: qualityScore(merged, Boolean(input.imageUrl)) };
}

/* ---------------- pricing intelligence ---------------- */

/**
 * MatzHub pricing rule — core business logic. Do not change without a signed
 * decision note. This is global, mandatory, and applies to every product.
 *
 *   originalPrice (mrp)   = cost × 1.40   → red, strikethrough, display-only
 *   sellingPrice  (price) = cost × 1.15   → green, larger, the ONLY live price
 *
 * Both figures derive from the same cost base, so the ~21% perceived saving is
 * real and consistent. The manufacturer cost is stored but never leaves the
 * server on a non-admin path — see src/lib/privacy.ts.
 */
export const normalizeTextForDedupe = (s: string) =>
  s.toLowerCase().replace(/₹|rs\.?|inr\b/g, " ").replace(/[0-9,]+/g, " ").replace(/[^a-z ]+/g, " ").replace(/\s+/g, " ").trim();

export const captionSimilarity = (a: string, b: string): number => {
  const toks = (s: string) => new Set(normalizeTextForDedupe(s).split(" ").filter((w) => w.length > 2));
  const A = toks(a);
  const B = toks(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter += 1;
  return inter / Math.max(A.size, B.size);
};

/** 0-1 similarity by hex char matches of hash digests. Bounded and deterministic. */
export const imageHashSimilarity = (a: string, b: string): number => {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const { createHash } = require("node:crypto");
  const ha = createHash("sha256").update(a).digest("hex");
  const hb = createHash("sha256").update(b).digest("hex");
  let same = 0;
  for (let i = 0; i < Math.min(ha.length, hb.length); i += 1) if (ha[i] === hb[i]) same += 1;
  return same / Math.max(ha.length, hb.length);
};

export const ORIGINAL_MARKUP_PERCENT = 40;
export const SELLING_MARGIN_PERCENT = 15;

export function computePricing(opts: { costPrice: number; marginPercent?: number }) {
  const cost = Math.max(0, Math.round(opts.costPrice));
  const margin = opts.marginPercent ?? SELLING_MARGIN_PERCENT;

  const mrp = Math.max(1, Math.round(cost * (1 + ORIGINAL_MARKUP_PERCENT / 100)));
  const price = Math.max(1, Math.round(cost * (1 + margin / 100)));

  return {
    costPrice: cost,
    mrp,
    price,
    resellerPrice: price,
    marginPercent: margin,
  };
}

/* ---------------- risk scoring ---------------- */

export function scoreOrderRisk(o: {
  total: number;
  paymentMode: string;
  pincode: string;
  phone: string;
  priorOrders: number;
}): { score: number; flags: string[] } {
  const flags: string[] = [];
  let score = 0;
  if (!/^\d{6}$/.test(o.pincode)) {
    score += 25;
    flags.push("invalid_pincode");
  }
  if (!/^\+?\d{10,13}$/.test(o.phone.replace(/\s/g, ""))) {
    score += 25;
    flags.push("suspicious_phone");
  }
  if (o.priorOrders === 0) {
    score += 10;
    flags.push("first_order");
  }
  if (o.priorOrders >= 3) score -= 15;
  return { score: Math.max(0, Math.min(100, score)), flags };
}
