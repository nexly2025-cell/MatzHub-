import { sanitizeSupplierCaption } from "@/lib/privacy";
import { approvedSupplierGroups } from "@/lib/supplier-groups";

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
  { slug: "apparel", words: ["shirt", "tshirt", "t-shirt", "hoodie", "jacket", "jeans", "trouser", "kurta", "dress", "apparel", "wear", "mens", "men's", "menswear"] },
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

// Derived from actual brands observed in ingestion_events (last 90 days) + closed allowlist.
// Do not add a brand without live caption evidence. Word-boundary matching prevents occasion->Casio.
const BRAND_HINTS = [
  "rolex", "casio", "fossil", "titan", "seiko", "daniel wellington", "gucci", "prada", "coach",
  "nike", "adidas", "puma", "woodland", "bata", "rayban", "ray-ban", "oakley", "levis", "levi's",
  "zara", "h&m", "tommy", "calvin klein",
  "cartier", "tissot", "omega", "tudor", "rado", "bvlgari", "versace", "tag heuer", "audemars piguet",
  "patek philippe", "rado", "lacoste", "amouage", "burberry", "michael kors", "louis vuitton",
  "onitsuka tiger", "emporio armani", "loropiana", "loro piana",
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
    // "900 only", "1,250/- only" — the number comes FIRST. This is how Indian
    // supplier groups actually write a price, and it was the one common form
    // no pattern matched. A caption like "Aviator sunglasses UV400\n900 only"
    // therefore yielded no figure at all, costPrice fell to 0, and the product
    // published at the Math.max(1, ...) floor of Rs 1.
    /\b([0-9][0-9,]{1,7})\s*(?:\/-)?\s*only\b/gi,
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
  const c = ` ${caption.toLowerCase()} `;
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const found = list
    .filter((w) => new RegExp(`(?<![a-z0-9])${esc(w.toLowerCase())}(?![a-z0-9])`).test(c))
    .sort((a, b) => b.length - a.length);
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
  if (!out.length && /\bfree\s*size\b/i.test(caption)) out.push({ label: "Free Size", axis: "size" });
  return out.slice(0, 12);
}

const EMOJI_STRIP_RE = /[\p{Extended_Pictographic}\p{Regional_Indicator}\uFE00-\uFE0F\u200D\u20E3\u2190-\u21FF\u2300-\u23FF\u2B50\u2B55\u2934\u2935\u25AA\u25AB\u25FE\u25FD\u25FB\u25FC\u25B6\u25C0\u3030\u303D\u3297\u3299\u{1F3FB}-\u{1F3FF}\u2600-\u27BF✅⚡🔥🛑😍✨🌟🛬✌️⚜️Ⓡ🅢ⓡ🅢🐊📏✔️💕🖤📦‼️▪️👇#*~_`]+/gu;

const PROMO_TITLE_PATTERNS = [
  /^\s*(?:product[- ]*(?:name|code|title)?|model[- ]*(?:name|no|code)?|item[- ]*(?:name|no|code)?|article[- ]*(?:name|no|code)?)\s*[:=\-#/.]*\s*/gi,
  /^\s*(?:1st\s*time\s*in\s*india|first\s*time\s*in\s*india|restocked\s*(?:on|in)?\s*high\s*demand|high\s*demand|new\s*arrival[s]?|fresh\s*stock|ready\s*stock|in\s*stock|exclusive\s*article|limited\s*edition|top\s*premium\s*quality|100\s*percent|original\s*quality|super\s*quality|og\s*level|store\s*article|live\s*images?|deals\s*in\s*imported[^\n]*)\s*[:=\-#/.]*\s*/gi,
  /\b(?:with\s+original\s+box\s+as\s+shown\s+in\s+picture|with\s+box\s+as\s+shown\s+in\s+picture|as\s+shown\s+in\s+picture|as\s+shown\b|as\s+pictured\b)/gi,
  /\b(?:with\s+(?:original\s+|branded\s+|safety\s+|magnetic\s+|double\s+|og\s+)?box|proper\s+box\s+packing|double\s+box\s+packing|box\s+packing|dust\s*bag\s*packing|with\s+dust\s*bag|with\s+bill|with\s+cards?|with\s+tags?|with\s+safety\s+box|with\s+carry\s+bag|proper\s+packing|double\s+box|magnetic\s+box|duty\s+free\s+packing|df\s+packing|comes\s+magnetic)\b/gi,
  /\b(?:free\s+shipping\s+included|free\s+shipping|with\s+shipping|shipping\s+free|shipping\s+extra)\b/gi,
  /\b(?:quality\s+guaranteed|premium\s+quality\s+guaranteed|guaranteed\s+orders\s+if\s+uploaded\s+on\s+reels|guaranteed\s+orders|super\s+premium|very\s+premium|very\s+very\s+premium\s+stuff|superb\s+stuff|highend\s+store\s+collection|high-end\s+store\s+collection|store\s+collection|store\s+article)\b/gi,
  /\b(?:as\s+comes\s+in\s+original|same\s+as\s+in\s+store|same\s+comes\s+in\s+original|all\s+original\s+detailing|with\s+full\s+detailing|dont\s+compare\s+with\s+market|book\s+fast|available\s+on\s+demand)\b/gi,
  /\b(?:cash\s+discount\s+on\s+premium\s+watches|attractive\s+cash\s+discount|cash\s+price\s+is\s*(?:₹|rs\.?|inr)?\s*\d+[\d,]*)\b/gi,
  /\b(?:sizes?\s*[:-]?\s*(?:eur\s*)?\d+\s*(?:to|-|–|,)\s*\d+|sizes?\s*[:-]?\s*\d+(?:\s*,\s*\d+)*|sizes?\s*avail\s*\d+\s*to\s*\d+|sizes?\s*\d+\s*(?:to|-|–)\s*\d+|size\s*eur\s*\d+\s*to\s*\d+)\b/gi,
  /\b(?:dimensions?\s*[:\-]?\s*\d+["'”]?\s*[wWlxLhH]\s*\d+["'”]?\s*[wWlxLhH]|dimension\s*\d+\s*[wW]\s*\d+\s*[lL]|length\s*[:\-]?\s*\d+.*height\s*[:\-]?\s*\d+.*)\b/gi,
  /\b(?:₹|rs\.?|inr|price|rate|cost|mrp|amount|net)\s*[:=\-]?\s*(?:₹|rs\.?|inr)?\s*\d+[\d,]*\b/gi,
  /\d+[\d,]*\s*(?:\/[-–]|rs\b|inr\b|rupees\b|only\b)/gi,
  /\b(?:available\s+in\s+\w+\s+colou?rs?|in\s+colors?|in\s+him|in\s+her|for\s+him|for\s+her|aa\+\s*all\s*time\s*highly\s*demanded\s*model|highly\s*demanded\s*model)\b/gi,
  /\b(?:combines|meets|presents|features|is\s+a?\s*line|is\s+one\s+of|is\s+global|has\s+attracted|was\s+always|equipped|reflects|unites|designed\s+to|was\s+introduced|is\s+comfortable|crafted\s+by|synonymous|comes\s+in|can\s+be\s+style|made\s+in\s+italy\s+from|is\s+reimagined|is\s+superfine|stands?\s+in|exclusively\s+solid|now\s+ready\s+to|just\s+launched|change\s+background|product\s+will\s+be\s+delivered|explore\s+timeless|famous\s+designer|as\s+bold\s+as|make\s+him\s+dress|those\s+who\s+love|timeless\s+minimalism|timeless\s+swiss|tough\s+ion|sparkling\s+sophistication)\b.*$/gi,
];

const GENERIC_NOUN_SET = new Set([
  "bag", "bags", "handbag", "handbags", "watch", "watches", "shoe", "shoes", "footwear",
  "perfume", "perfumes", "fragrance", "sunglass", "sunglasses", "eyewear", "apparel", "clothes",
  "clothing", "shirt", "shirts", "tshirt", "t-shirt", "tee", "denim", "cap", "product"
]);

const KNOWN_TITLE_FIXES: Record<string, string> = {
  "perfume-1e6c3e": "Louis Vuitton Unisex Fragrance",
  "sunglass-2ff6aa": "Puma Polarised Sport Sunglasses",
  "sunglass-6": "Michael Kors Acetate Sunglasses",
  "sunglass-0e87c7": "Ray-Ban Z-643 Polarised Sunglasses",
  "sunglass-505aca": "Ray-Ban Z-644 Polarised Sunglasses",
  "size-eur-41-to-45": "On Running Cloud Shoes",
  "size-eur-41-to-45-2": "On Cloud Sports Shoes",
  "size-eur-41-to-45-4": "Asics Superblast 3 Shoes",
  "size-40-to-44": "Puma Drift Cat Sneakers",
  "bag-de6c23": "Marc Jacobs Jacquard Shoulder Bag",
  "bag-61bb09": "Coach Tabby Leather Shoulder Bag",
  "bag-540de8": "Michael Kors Greenwich Green Handbag",
  "bag-e3eb6b": "Coach Charms Shoulder Bag",
  "bag-b5a2ac": "YSL Leather Shoulder Bag",
  "bag-d7589a": "Prada Saffiano Leather Handbag",
  "bag-671dc9": "Louis Vuitton Speedy Trunk Monogram Bag",
  "bag-c28e0d": "Gucci Moire Fabric Calfskin Bag",
  "bag-310bb8": "Coach Signature Tote Bag",
  "bag-2b12c1": "Michael Kors Sling Handbag",
  "bag-6f69f2": "Louis Vuitton Duty Free Monogram Handbag",
  "bag-44696d": "Charles & Keith Classic Sling Bag",
  "bag-6684a8": "Louis Vuitton Speedy Soft 30 Crafty Duffle Bag",
  "bag-fd5d55": "Louis Vuitton Neverfull Bandouliere Monogram Tote",
  "bag-3654d6": "Coach Savannah Carryall Small Bag",
  "bag-4": "YSL Hand & Sling Bag",
  "bag-5": "Michael Kors Romee Tote Bag",
  "bag-6": "Tory Burch Classic Sling Bag",
  "bag-1d07ff": "Dior Magnetic Flap Handbag",
  "bag-fd3793": "Coach Leather Shoulder Bag",
  "bag": "Burberry Softly Structured Tote Bag",
  "shirt-a5d59b": "Lacoste Cotton Full Sleeves Shirt",
  "shirt-2": "Gucci Cotton Pique Polo T-Shirt",
  "shirt-5": "Tom Ford Stitchless Polo Tee",
  "1st-time-in-india": "Hoka One One Stinson 7 Running Shoes",
  "1st-time-in-india-brown": "On Cloud 5 Sand Rosebrown Running Shoes",
  "hugo-boss-pilot-sport-watch-combines-bold-orange": "Hugo Boss Pilot Sport Watch",
  "omega-de-ville-prestige-collection-has-attracted-silver": "Omega De Ville Prestige Watch",
  "from-first-generation-models-launched-in-1998-bvlgari-white": "Bvlgari Nuclear Weapon Watch 45mm",
  "bold-italian-craftsmanship-meets-timeless-luxury-this-rose-gold": "Versace V-Chrono Italian Luxury Watch",
  "cartier-automatic-skeleton-watch-combines-iconic-luxury-black": "Cartier Automatic Skeleton Watch",
  "coach-is-global-fashion-house-founded-silver": "Coach Astor Stainless Steel Watch",
  "famous-designer-brand-burberry-is-synonymous-reliability-white": "Burberry Classic Check Watch",
  "as-bold-as-it-is-beautiful-latest-gold": "Michael Kors Portia Gold Watch",
  "those-who-love-to-hear-engine-roaring-black": "Tag Heuer Formula 1 Chronograph Watch",
  "versace-chronograph-watch-combines-bold-italian-inspired-luxury-black": "Versace Chronograph Black Watch",
  "michael-kors-is-one-of-most-prestigious-white": "Michael Kors Runway Chronograph Watch",
  "attractive-cash-discount-on-premium-watches": "Rolex GMT-Master II Luxury Watch",
  "sporty-tag-heuer-carrera-chronograph-equipped-fixed-blue": "Tag Heuer Carrera Chronograph Watch",
  "roll-out-of-tag-heuer-s-gulf-branded-watches-continues-silver": "Tag Heuer Formula 1 Gulf Edition Watch",
  "casio-premium-edifice-eqb-series-is-superfine-black": "Casio Edifice EQB Series Watch",
  "beautifully-elegant-swarovski-inspired-timepiece-featuring-stunning-ro": "Casio Rose Gold Swarovski Timepiece",
  "sophisticated-gc-timepiece-featuring-luxurious-rose-gold-finish-rose-g": "Gc Prime Chic Rose Gold Watch",
  "bold-chronograph-timepiece-that-combines-sporty-sophistication-rose-go": "Armani Chronograph Rose Gold Watch",
  "tudor-black-bay-chrono-exclusively-solid-silver": "Tudor Black Bay Chrono Watch",
  "tudor-black-bay-chrono-exclusively-solid-silver-2": "Tudor Black Bay Chrono 41mm Watch",
  "tissot-prx-powematic-80-was-always-going-black": "Tissot PRX Powermatic 80 Watch",
  "luxury-that-breathes-cartier-open-heart-unites-white": "Cartier Open Heart Automatic Watch",
  "explore-timeless-rado-collections-made-revolutionary-materials-black": "Rado Centrix Ceramic Watch",
  "make-him-dress-like-king-change-background-tan": "Rolex Day-Date President Watch",
  "coussin-de-cartier-is-line-of-luxurious-silver": "Cartier Coussin Luxury Watch",
  "rugged-strength-meets-modern-luxury-powerful-black": "Casio G-Shock Mudmaster Watch"
};

export function cleanTitleText(raw: string, categorySlug: string, brand: string | null, slug?: string): string {
  if (slug && KNOWN_TITLE_FIXES[slug]) {
    return KNOWN_TITLE_FIXES[slug];
  }

  let t = raw.replace(EMOJI_STRIP_RE, " ");
  for (const re of PROMO_TITLE_PATTERNS) {
    t = t.replace(re, " ");
  }
  t = t.replace(/[()\[\]{}"'“”`~#*/\\]/g, " ");
  t = t.replace(/[-–—:;,.]{2,}/g, " ");
  t = t.replace(/\s+/g, " ").trim();

  const words = t
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w.toLowerCase()));

  const DANGLING = new Set(["size", "sizes", "men", "women", "and", "with", "for", "in", "to", "pcs", "piece", "quality", "as", "of", "the", "on", "top", "aa"]);
  while (words.length > 2 && DANGLING.has(words[words.length - 1].toLowerCase())) {
    words.pop();
  }
  while (words.length > 2 && DANGLING.has(words[0].toLowerCase())) {
    words.shift();
  }

  let cleaned = words.join(" ").trim();
  const lower = cleaned.toLowerCase();

  const catNoun = CATEGORY_RULES.find((r) => r.slug === categorySlug)?.words[0] ?? "product";
  const catTitleNoun = titleCase(catNoun);

  if (!cleaned || words.length < 2 || GENERIC_NOUN_SET.has(lower)) {
    cleaned = [brand, catTitleNoun].filter(Boolean).join(" ");
  } else if (brand && !lower.includes(brand.toLowerCase()) && !words.some(w => BRAND_HINTS.some(b => b.toLowerCase() === w.toLowerCase()))) {
    cleaned = `${brand} ${cleaned}`;
  }

  if (categorySlug === "sunglasses" && cleaned.toLowerCase().includes("bag")) {
    cleaned = cleaned.replace(/\bbag\b/gi, "Sunglasses");
  }
  if (categorySlug === "perfumes" && cleaned.toLowerCase().includes("apparel")) {
    cleaned = cleaned.replace(/\bapparel\b/gi, "Fragrance");
  }
  if (categorySlug === "footwear" && cleaned.toLowerCase().includes("apparel")) {
    cleaned = cleaned.replace(/\bapparel\b/gi, "Footwear");
  }

  if (GENERIC_NOUN_SET.has(cleaned.toLowerCase().trim())) {
    cleaned = brand ? `${brand} ${catTitleNoun}` : titleCase(categorySlug || catTitleNoun);
  }

  return titleCase(cleaned).slice(0, 80);
}

function buildTitle(caption: string, category: string, brand: string | null, color: string | null): string {
  const modelMatch = caption.match(/\b(?:product\s*name|model\s*name|model\s*no|model)\s*[:=\-]\s*([^\n\r*]+)/i);
  if (modelMatch && modelMatch[1]) {
    const fromModel = cleanTitleText(modelMatch[1].trim(), category, brand);
    const words = fromModel.split(/\s+/).filter((w) => w.length > 1 && !STOPWORDS.has(w.toLowerCase()));
    if (words.length >= 2 && !GENERIC_NOUN_SET.has(fromModel.toLowerCase())) {
      return fromModel;
    }
  }

  const lines = caption.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 3);
  let bestClean = "";
  let bestScore = 0;

  for (const line of lines) {
    const cleaned = cleanTitleText(line, category, brand);
    const words = cleaned.split(/\s+/).filter((w) => w.length > 1 && !STOPWORDS.has(w.toLowerCase()));
    if (words.length > bestScore && !GENERIC_NOUN_SET.has(cleaned.toLowerCase())) {
      bestScore = words.length;
      bestClean = cleaned;
    }
  }

  if (!bestClean || bestScore < 2) {
    bestClean = cleanTitleText(caption, category, brand);
  }

  return bestClean || `${brand ? brand + " " : ""}${titleCase(category)}`;
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

  const specTags = Object.entries(specs)
    .filter(([k]) => !["Category", "Gender", "Delivery", "Sourcing", "Brand", "Colour", "Material"].includes(k))
    .map(([, v]) => v.toLowerCase().trim());

  const tags = Array.from(
    new Set(
      [categorySlug, gender, color, material, brand, ...specTags]
        .filter(Boolean)
        .map((t) => String(t).toLowerCase().trim()),
    ),
  ).slice(0, 10);

  const shortAnswer = `${title} is a ${color ? `${color.toLowerCase()} ` : ""}${material ? `${material.toLowerCase()} ` : ""}${catLabel.toLowerCase()} listed through MatzHub. Ships across India with a 7-day replacement window.`;

  // Description elaborates ONLY what the supplier stated. No invented benefits.
  // Supplier captions carry our buying price and their stock counts.
  // sanitizeSupplierCaption strips those before any becomes public copy.
  const supplierLine = sanitizeSupplierCaption(caption);
  const description = [
    supplierLine || `${title} — ${catLabel.toLowerCase()} from the verified supplies channel, listed as provided by the source.`,
    `Ships across India with a 7-day replacement window if the item does not match the listing.`,
  ].join(" ");

  const faqs = [
    { q: `Is this ${catLabel.toLowerCase()} an original branded product?`, a: `No. This is imported first-copy, master-quality merchandise. MatzHub is not affiliated with, endorsed by or licensed by any original brand, and we state this openly on every listing.` },
    { q: "Who makes it?", a: "Our sourcing partners are verified but their identity is private — that's the agreement that keeps pricing honest. Every partner is quality-scored before their stock is listed." },
    { q: "How long does delivery take?", a: "Orders are dispatched within 24–48 hours. Metro cities receive in 2–4 days, rest of India in 4–7 days." },
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

/* ------------------------------------------------------------------ *
 * Category-aware captioning
 * ------------------------------------------------------------------ *
 * One generic template produces watch copy that talks about GSM and shoe
 * copy that talks about sapphire crystal. Each category gets its own
 * emphasis list, and every entry is something a supplier in that trade
 * actually writes. Anything not on the list is not asked for.
 */
const CATEGORY_EMPHASIS: Record<string, string> = {
  watches:
    "Dial colour and detail, strap or bracelet material, case size, movement, and only features the message states (chronograph, water resistance, display caseback). Never mention crystal type, jewel count, accuracy, or country of origin unless stated.",
  footwear:
    "Shoe type (sneaker, loafer, oxford, sandal, boot), colour, upper material, sole material, and the stated size run. Never mention arch support, cushioning technology, or width fitting unless stated.",
  apparel:
    "Garment type, fabric, colour, fit, and stated sizes. Never mention GSM unless the number is in the message. Never mention weave, stitching, shrinkage, or care instructions unless stated.",
  perfumes:
    "Fragrance name if given, stated notes, concentration (EDP/EDT/attar) and volume in ml. Never invent notes, longevity hours, projection, sillage, or season unless stated.",
  handbags:
    "Bag type (tote, sling, clutch, briefcase, backpack), material, colour, closure, compartment count and dimensions only if stated. Never mention lining, hardware finish, or laptop fit unless stated.",
  sunglasses:
    "Frame style (aviator, wayfarer, round, square), frame material, lens information (polarised, UV400) and colour. Never mention lens coating, hinge type, or prescription compatibility unless stated.",
};

const CATEGORY_TONE: Record<string, string> = {
  watches: "precise and technical, like a well-informed salesperson turning the watch over in their hand",
  footwear: "warm and descriptive about the finish, without overselling comfort",
  apparel: "simple and tactile, about how the fabric feels and drapes",
  perfumes: "evocative about the stated notes only, never about performance claims",
  handbags: "practical and structured, describing shape and carry",
  sunglasses: "graphic and clean, about silhouette and lens",
};

const ANTI_FABRICATION_RULES = `
HARD RULES - VIOLATION MAKES THE OUTPUT UNUSABLE:
1. You may ONLY rephrase information that is literally present in the supplier message. You are a copy editor, not a researcher.
2. NEVER invent, infer, extrapolate or "improve" any of: brand, model, material, movement, dimensions, weight, features, specifications, country of origin, warranty, authenticity, availability, quantity, condition, or any technical claim.
3. If a detail is absent from the message, OMIT it entirely. Do not write "premium", "high quality", "durable", "long lasting", "water resistant", "Japanese", "imported", "genuine" or any similar qualifier to fill a gap.
4. No marketing superlatives, no exclamation marks, no emoji, no ALL CAPS.
5. Every claim in your output must be traceable to a word or number in the message. When unsure, leave it out.
`;

const JSON_SHAPE =
  '{"title":string,"subtitle":string,"description":string,"shortAnswer":string,"categorySlug":"watches"|"handbags"|"footwear"|"sunglasses"|"apparel"|"perfumes","brand":string|null,"color":string|null,"material":string|null,"gender":"men"|"women"|"unisex","tags":string[],"specs":{},"faqs":[{"q":string,"a":string}],"seoTitle":string,"seoDescription":string,"altText":string,"variants":[{"label":string,"axis":"size"|"color"}],"costPrice":number,"mrp":number,"confidence":number}';

/**
 * Builds the prompt for one category. The attributes the deterministic
 * extractor already found are appended as grounding, so the model is never
 * asked to guess - it is shown exactly what it may describe.
 */
export function cleanProse(text: string, costPrice?: number): string {
  if (!text) return "";
  let t = text.replace(EMOJI_STRIP_RE, " ");

  const PROSE_BLOCKLIST = [
    /\b(?:with\s+original\s+box\s+as\s+shown\s+in\s+picture|with\s+box\s+as\s+shown\s+in\s+picture|as\s+shown\s+in\s+picture|as\s+shown\b|as\s+pictured\b)[,.]?/gi,
    /\b(?:with\s+(?:original\s+|branded\s+|safety\s+|magnetic\s+|double\s+|og\s+)?box|proper\s+box\s+packing|double\s+box\s+packing|box\s+packing|dust\s*bag\s*packing|with\s+dust\s*bag|with\s+bill|with\s+cards?|with\s+tags?|with\s+safety\s+box|with\s+carry\s+bag|proper\s+packing|double\s+box|magnetic\s+box|duty\s+free\s+packing|df\s+packing|dust\s*cover|original\s+dust\s*bag|free\s+original\s+box\s+kit|including\s+booklet\s+manual)[,.]?/gi,
    /\b(?:1st\s+time\s+in\s+india|first\s+time\s+in\s+india|1st\s+time|official\s+model|restocked\s*(?:on|in)?\s*high\s*demand|high\s*demand|guaranteed\s+orders\s+if\s+uploaded\s+on\s+reels|guaranteed\s+orders|available\s+for\s+the\s+first\s+time\s+in\s+india|quality\s+guaranteed|premium\s+quality\s+guaranteed|top\s+premium\s+quality|super\s+premium|very\s+premium|very\s+very\s+premium\s+stuff|superb\s+stuff|highend\s+store\s+collection|high-end\s+store\s+collection|store\s+collection|store\s+article|7aaa?\s+premium\s+collection|full\s+store\s+article|don['’]?t\s+compare\s+with\s+market(?:\s+quality)?|package\s+includes|book\s+fast|on\s+demand|highly\s+demanded\s+model|all\s+time\s+highly\s+demanded|aa\+)[,.]?/gi,
    /\b(?:cash\s+price\s+is\s*(?:₹|rs\.?|inr)?\s*\d+[\d,]*|cost\s+price\s+is\s*(?:₹|rs\.?|inr)?\s*\d+[\d,]*|price\s*[:=\-]\s*(?:₹|rs\.?|inr)?\s*\d+[\d,]*|cost\s*[:=\-]\s*(?:₹|rs\.?|inr)?\s*\d+[\d,]*|rate\s*[:=\-]\s*(?:₹|rs\.?|inr)?\s*\d+[\d,]*|updated\s+price|cod\s+available)[,.]?/gi,
    /\b(?:free\s+shipping\s+included|free\s+shipping|with\s+shipping|shipping\s+free|shipping\s+extra|same\s+day\s+shipping)[,.]?/gi,
    /\b(?:sizes?\s*[:-]?\s*(?:eur\s*)?\d+\s*(?:to|-|–|,)\s*\d+|sizes?\s*avail\s*\d+\s*to\s*\d+|size\s*eur\s*\d+\s*to\s*\d+)[,.]?/gi,
    /\b(?:product[- ]?(?:name|code)|model[- ]?(?:name|no)|feature\s+follows|features\s+follows|original\s+model)\s*[-:#]?/gi,
    /\b(?:as\s+comes\s+in\s+original|same\s+as\s+in\s+store|same\s+comes\s+in\s+original|all\s+original\s+detailing|with\s+full\s+detailing|will\s+be\s+delivered\s+same\s+as\s+in\s+pic\s*(?:&|and)\s*video|no\s+change\s+seen)[,.]?/gi,
    /\b(?:guaranteed\s+japan\s+movement|guaranteed\s+japanese\s+machinery|guaranteed\s+original\s+japanese\s+battery\s+operated\s+machinery|most\s+reliable\s+guaranteed)[,.]?/gi,
  ];

  for (const re of PROSE_BLOCKLIST) {
    t = t.replace(re, " ");
  }

  if (costPrice && costPrice > 0) {
    t = t.replace(new RegExp(String(costPrice), "g"), " ");
  }

  t = t.replace(/[()\[\]{}"'“”`~#*/\\]/g, " ");
  t = t.replace(/[-–—:;,.]{2,}/g, " ");
  t = t.replace(/\s+/g, " ").trim();
  t = t.replace(/\s+([,.;:])/g, "$1");
  t = t.replace(/[,;:\s]+$/g, "").trim();
  return t;
}

function buildPrompt(input: EnrichmentInput, grounded: Enrichment): string {
  const slug = grounded.categorySlug;
  const emphasis = CATEGORY_EMPHASIS[slug] ?? "Only the attributes explicitly present in the message.";
  const tone = CATEGORY_TONE[slug] ?? "clean, factual, restrained";

  const detected: Record<string, string> = {};
  if (grounded.brand) detected.brand = grounded.brand;
  if (grounded.color) detected.colour = grounded.color;
  if (grounded.material) detected.material = grounded.material;
  if (grounded.gender) detected.gender = grounded.gender;
  const sourceSpecs = Object.entries(grounded.specs).filter(
    ([k]) => k !== "Category" && k !== "Gender" && k !== "Delivery" && k !== "Sourcing",
  );
  if (sourceSpecs.length) detected.detectedAttributes = sourceSpecs.map(([k, v]) => `${k}: ${v}`).join("; ");

  return [
    `Category: ${slug}`,
    `Tone: ${tone}`,
    "",
    `Emphasise ONLY these attributes for this category: ${emphasis}`,
    "",
    "Facts already extracted from the message (the only attributes you may describe):",
    Object.keys(detected).length ? JSON.stringify(detected) : "(none beyond the message text itself)",
    "",
    "Supplier message (verbatim; may contain pricing and stock notes - never repeat those):",
    input.caption,
    "",
    `Return ONLY minified JSON matching exactly: ${JSON_SHAPE}`,
    "Constraints: title <= 80 chars, real concise product name without \"Product Name\", \"Model\", \"With Box\", \"As Shown\", packaging mentions, sizes, or emojis. description 70-120 words, clean luxury retail copy describing only the piece itself; NEVER mention boxes, dust bags, packaging, \"as shown\", \"as pictured\", shipping terms, prices, or reel slogans. shortAnswer is one 30-45 word paragraph answering \"what is this product\" for AI answer engines. seoTitle <= 60 chars. seoDescription <= 158 chars. 4 FAQs. costPrice is the lowest rupee figure in the message, mrp the highest. confidence 0-1 reflecting how complete the message was.",
  ].join("\n");
}

/**
 * Trade abbreviations a supplier actually writes, mapped to the wording a copy
 * editor would use, so a legitimate expansion counts as grounded: a caption
 * reading "Royal Oud EDP 100ml" may become "eau de parfum".
 */
const ABBREVIATION_EXPANSIONS: Array<{ re: RegExp; expansion: string }> = [
  { re: /\bedp\b/gi, expansion: "eau de parfum edp" },
  { re: /\bedt\b/gi, expansion: "eau de toilette edt" },
  { re: /\bedc\b/gi, expansion: "eau de cologne edc" },
  { re: /\bparfum\b/gi, expansion: "parfum eau de parfum" },
  { re: /\buv\s?400\b/gi, expansion: "uv400 uv 400 ultraviolet" },
  { re: /\buv\s?protected\b/gi, expansion: "uv protected ultraviolet" },
  { re: /\bpolaris(?:ed|z)ed\b/gi, expansion: "polarised polarized" },
  { re: /\bwr\s?(\d+)?\b/gi, expansion: "water resistant wr" },
  { re: /\bss\b/gi, expansion: "stainless steel ss" },
  { re: /\blth?r\b/gi, expansion: "leather lthr" },
  { re: /\bchrono\b/gi, expansion: "chronograph chrono" },
  { re: /\bauto\b/gi, expansion: "automatic auto" },
  { re: /\bgen\s+leather\b/gi, expansion: "genuine leather" },
];

function expandAbbreviations(text: string): string {
  let out = String(text || "");
  for (const { re, expansion } of ABBREVIATION_EXPANSIONS) out = out.replace(re, ` ${expansion} `);
  return out.toLowerCase();
}

/**
 * Prose grounding. groundSpecs() covers structured specs, but the model writes
 * prose too, and prose is where fabrication shows up: given "Casio watch black
 * dial stainless steel strap" the model volunteered "featuring a precise quartz
 * movement". This scans the vocabulary that carries a technical claim; if a
 * term is used that the supplier did not write, the caller discards the
 * model-authored text for that field.
 */
const TECHNICAL_CLAIM_TERMS: Array<string> = [
  "quartz", "automatic", "mechanical", "kinetic", "chronometer", "tourbillon", "skeleton", "chronograph",
  "sapphire crystal", "sapphire glass", "mineral crystal", "mineral glass", "hardlex", "gorilla glass", "scratch resistant", "scratch-resistant",
  "water resistant", "water-resistant", "waterproof", "water resistance", "atm", "ip65", "ip66", "ip67", "ip68",
  "shockproof", "shock resistant", "shock-resistant", "dustproof",
  "japanese", "swiss", "swiss made", "german made", "italian made", "made in japan", "made in italy", "made in switzerland",
  "warranty", "guarantee", "guaranteed", "lifetime", "1 year", "2 year", "certified", "hallmarked", "bis", "iso",
  "jewel", "jewels", "per day", "power reserve",
  "polarised", "polarized", "uv400", "uv 400", "anti reflective", "anti-reflective", "blue light",
  "gsm", "thread count", "pre shrunk", "pre-shrunk", "shrink resistant", "breathable",
  "long lasting", "long-lasting", "projection", "sillage", "parfum intensity",
  "full grain", "top grain", "genuine italian leather", "genuine leather", "pure leather", "real leather", "vegan leather", "vegetable tanned",
  "100% cotton", "pure cotton", "organic cotton", "sterling silver", "925 silver", "solid gold", "18k", "24k", "titanium", "carbon fiber", "ceramic", "cashmere",
  "orthopedic", "memory foam", "anti-slip", "non-slip", "laptop compatible", "macbook", "bluetooth", "gps", "nfc", "amoled", "solar", "hypoallergenic", "handcrafted", "handmade",
];

const claimTermPattern = (term: string) =>
  new RegExp(`(?<![a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9])`, "i");

const COMPILED_CLAIM_PATTERNS = TECHNICAL_CLAIM_TERMS.map((t) => ({ term: t, re: claimTermPattern(t) }));

const MEASUREMENT_RE = /\b(\d+(?:\.\d+)?)\s*(mm|cm|ml|gsm|atm|litre|liter|oz|inch|inches)\b|\b(\d+)\s*x\s*(\d+)(?:\s*x\s*(\d+))?\s*(?:cm|mm|in)?\b/gi;

/**
 * Returns any technical terms or explicit measurements used in `text` that are
 * absent from `caption`.
 */
export function ungroundedClaims(caption: string, text: string): string[] {
  const source = expandAbbreviations(caption);
  const haystack = String(text || "");
  const found: string[] = [];
  for (const { term, re } of COMPILED_CLAIM_PATTERNS) {
    if (re.test(haystack) && !re.test(source)) found.push(term);
  }
  const sourceNumbers = new Set((source.match(/\d+(?:\.\d+)?/g) ?? []).map((n) => n));
  let m: RegExpExecArray | null;
  const measureRegex = new RegExp(MEASUREMENT_RE.source, "gi");
  while ((m = measureRegex.exec(haystack))) {
    const nums = [m[1], m[3], m[4], m[5]].filter(Boolean);
    if (nums.some((n) => !sourceNumbers.has(n))) {
      found.push(m[0].trim().toLowerCase());
    }
  }
  return Array.from(new Set(found));
}

/**
 * Grounding filter - the real enforcement layer.
 *
 * Prompt rules alone cannot be trusted to stop fabrication. Any spec the model
 * returns is dropped unless its value is traceable to the source caption
 * (case- and punctuation-insensitive containment) and contains no ungrounded
 * technical claims. Policy rows (Category, Gender, Delivery, Sourcing) are
 * never accepted from untrusted LLM output; they are attached deterministically.
 */
const POLICY_SPEC_KEYS = new Set(["category", "gender", "delivery", "sourcing"]);
const FORBIDDEN_SPEC_KEY_RE = /supplier|manufacturer|factory|vendor|source|whatsapp|contact|phone|cost|price|mrp|margin|reseller|stock|qty|moq|warranty|guarantee|authenticity|origin/i;
const PLACEHOLDER_SPEC_VALUE_RE = /^(unknown|n\/a|na|none|null|undefined|not specified|not mentioned|tbd|-+|\?+)$/i;

export function groundSpecs(sourceCaption: string, specs: Record<string, string> | undefined): Record<string, string> {
  if (!specs || typeof specs !== "object") return {};
  const expandedCaption = expandAbbreviations(sourceCaption);
  const haystack = expandedCaption
    .replace(/[^a-z0-9x. ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const out: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(specs)) {
    const key = String(rawKey ?? "").trim().slice(0, 40);
    const value = String(rawValue ?? "").trim().slice(0, 120);
    if (!key || !value) continue;
    if (POLICY_SPEC_KEYS.has(key.toLowerCase())) continue;
    if (FORBIDDEN_SPEC_KEY_RE.test(key)) continue;
    if (PLACEHOLDER_SPEC_VALUE_RE.test(value)) continue;
    if (/\+?\d[\d\s-]{8,}/.test(value)) continue;
    if (ungroundedClaims(sourceCaption, value).length > 0) continue;

    const needle = expandAbbreviations(value)
      .replace(/[^a-z0-9x. ]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!needle) continue;
    const tokens = needle.split(" ").filter((t) => t.length > 1 && !STOPWORDS.has(t));
    const grounded =
      haystack.includes(needle) ||
      (tokens.length > 0 && tokens.every((tok) => new RegExp(`(?<![a-z0-9])${tok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9])`).test(haystack)));
    if (grounded) {
      out[titleCase(key)] = value;
    }
  }
  return out;
}

/* ------------- LLM captioning (GROQ text intelligence, Gemini visual + fallback) -------------
 * GROQ handles fast, low-cost text/product intelligence; Gemini handles visual
 * understanding/verification and optional fallback. Neither is mandatory.
 * Any failure returns null and the deterministic extractor has already produced
 * a complete, publishable record, so the product still ships (safe degradation).
 */

const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";
const GEMINI_DEFAULT_MODEL = "gemini-3.5-flash-lite";
const GROQ_DEFAULT_MODEL = "llama-3.1-8b-instant";
const GEMINI_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS) || 15000;
const GROQ_TIMEOUT_MS = Number(process.env.GROQ_TIMEOUT_MS) || 8000;

/**
 * Issue 6 — 7-day in-memory cache + concurrency semaphores + rate-limit cooldowns.
 * Protects free-tier GROQ and Gemini quotas from burst exhaustion and retry storms.
 */
const GEMINI_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const GEMINI_CACHE_MAX = 500;
const GEMINI_CONCURRENCY = 5;
const GROQ_CONCURRENCY = 5;
const RATE_LIMIT_COOLDOWN_MS = 60 * 1000;

type CachedEnrichment = { value: Partial<Enrichment>; modelUsed: string; expires: number };
const enrichmentCache = new Map<string, CachedEnrichment>();
let geminiInFlight = 0;
const geminiWaiters: Array<() => void> = [];
let groqInFlight = 0;
const groqWaiters: Array<() => void> = [];
let groqCooldownUntil = 0;
let geminiCooldownUntil = 0;

const quotaStats = {
  cacheHits: 0,
  skippedShortCaption: 0,
  groqCalls: 0,
  groqRateLimited: 0,
  geminiTextCalls: 0,
  geminiVisionCalls: 0,
  geminiRateLimited: 0,
  mediaCacheHits: 0,
};

export function getAiQuotaStats() {
  return {
    ...quotaStats,
    enrichmentCacheSize: enrichmentCache.size,
    mediaCacheSize: mediaVerificationCache.size,
    groqCoolingDown: groqCooldownUntil > Date.now(),
    geminiCoolingDown: geminiCooldownUntil > Date.now(),
  };
}

export function clearEnrichmentCache(): void {
  enrichmentCache.clear();
  mediaVerificationCache.clear();
  groqCooldownUntil = 0;
  geminiCooldownUntil = 0;
}

function parseRetryAfterMs(res: { headers?: { get?: (name: string) => string | null } }): number {
  const header = res.headers?.get?.("retry-after");
  if (!header) return RATE_LIMIT_COOLDOWN_MS;
  const secs = Number(header);
  if (Number.isFinite(secs) && secs > 0) return Math.min(300_000, Math.max(5_000, secs * 1000));
  return RATE_LIMIT_COOLDOWN_MS;
}

function enrichmentCacheKey(input: EnrichmentInput, grounded: Enrichment): string {
  const normalizedCaption = (input.caption || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  return `${grounded.categorySlug}::${normalizedCaption}::${grounded.costPrice}`;
}

function readEnrichmentCache(key: string): CachedEnrichment | undefined {
  const hit = enrichmentCache.get(key);
  if (!hit) return undefined;
  if (hit.expires < Date.now()) {
    enrichmentCache.delete(key);
    return undefined;
  }
  quotaStats.cacheHits += 1;
  return hit;
}

function rememberEnrichment(key: string, value: Partial<Enrichment>, modelUsed: string): void {
  if (enrichmentCache.size >= GEMINI_CACHE_MAX) {
    const oldest = enrichmentCache.keys().next().value;
    if (oldest !== undefined) enrichmentCache.delete(oldest);
  }
  enrichmentCache.set(key, { value, modelUsed, expires: Date.now() + GEMINI_CACHE_TTL_MS });
}

async function withGeminiSlot<T>(fn: () => Promise<T>): Promise<T> {
  while (geminiInFlight >= GEMINI_CONCURRENCY) {
    await new Promise<void>((resolve) => geminiWaiters.push(resolve));
  }
  geminiInFlight += 1;
  try {
    return await fn();
  } finally {
    geminiInFlight -= 1;
    geminiWaiters.shift()?.();
  }
}

async function withGroqSlot<T>(fn: () => Promise<T>): Promise<T> {
  while (groqInFlight >= GROQ_CONCURRENCY) {
    await new Promise<void>((resolve) => groqWaiters.push(resolve));
  }
  groqInFlight += 1;
  try {
    return await fn();
  } finally {
    groqInFlight -= 1;
    groqWaiters.shift()?.();
  }
}

/**
 * True only when the supplier caption contains enough non-commercial product
 * wording to justify an LLM copywriting call. Empty or price-only captions
 * ("900 only", "Rs 850/-") have no prose to rewrite and would only waste free
 * quota or tempt the LLM to invent details.
 */
function hasEnoughTextForLlm(caption: string): boolean {
  const tokens = normalizeTextForDedupe(caption)
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !STOPWORDS.has(w));
  return tokens.length >= 2;
}

async function llmEnrich(
  input: EnrichmentInput,
  grounded: Enrichment,
  timeoutMs = GEMINI_TIMEOUT_MS,
): Promise<{ data: Partial<Enrichment>; modelUsed: string } | null> {
  if (!hasEnoughTextForLlm(input.caption)) {
    quotaStats.skippedShortCaption += 1;
    return null;
  }
  const cacheKey = enrichmentCacheKey(input, grounded);
  const cached = readEnrichmentCache(cacheKey);
  if (cached) return { data: cached.value, modelUsed: cached.modelUsed };

  // GROQ is the dedicated text/product intelligence engine. When GROQ_API_KEY
  // is configured, never burn Gemini's visual quota on text copywriting.
  if (process.env.GROQ_API_KEY) {
    if (Date.now() < groqCooldownUntil) return null;
    const groqModel = process.env.GROQ_MODEL || GROQ_DEFAULT_MODEL;
    const groq = await withGroqSlot(() => callGroq(input, grounded, cacheKey, groqModel));
    return groq ? { data: groq, modelUsed: `groq:${groqModel}` } : null;
  }

  // Gemini text fallback only when GROQ_API_KEY is not configured.
  const key = process.env.GEMINI_API_KEY;
  if (!key || Date.now() < geminiCooldownUntil) return null;
  const geminiModel = process.env.GEMINI_MODEL || GEMINI_DEFAULT_MODEL;
  const gemini = await withGeminiSlot(() => callGemini(key, input, grounded, cacheKey, timeoutMs, geminiModel));
  if (gemini) return { data: gemini, modelUsed: `gemini:${geminiModel}` };
  return null;
}

async function callGroq(
  input: EnrichmentInput,
  grounded: Enrichment,
  cacheKey: string,
  model: string,
): Promise<Partial<Enrichment> | null> {
  const key = process.env.GROQ_API_KEY;
  if (!key) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GROQ_TIMEOUT_MS);
  try {
    quotaStats.groqCalls += 1;
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        temperature: 0.1,
        max_tokens: 900,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "You are MatzHub's fast product copy editor. Return ONLY valid minified JSON, no markdown." + ANTI_FABRICATION_RULES },
          { role: "user", content: buildPrompt(input, grounded) },
        ],
      }),
    });
    if (res.status === 429 || res.status === 503) {
      quotaStats.groqRateLimited += 1;
      groqCooldownUntil = Date.now() + parseRetryAfterMs(res);
      return null;
    }
    if (!res.ok) return null;
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const raw = json.choices?.[0]?.message?.content ?? "";
    if (!raw.trim()) return null;
    const parsed = JSON.parse(raw) as Partial<Enrichment>;
    parsed.specs = groundSpecs(input.caption, parsed.specs);
    rememberEnrichment(cacheKey, parsed, `groq:${model}`);
    return parsed;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function callGemini(
  key: string,
  input: EnrichmentInput,
  grounded: Enrichment,
  cacheKey: string,
  timeoutMs: number,
  model: string,
): Promise<Partial<Enrichment> | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    quotaStats.geminiTextCalls += 1;
    const res = await fetch(`${GEMINI_ENDPOINT}/${model}:generateContent`, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        generationConfig: { temperature: 0.1, responseMimeType: "application/json", maxOutputTokens: 900 },
        systemInstruction: {
          parts: [
            {
              text:
                "You are MatzHub's product copy editor. You receive one raw WhatsApp message from a manufacturer and rewrite it into clean, restrained, factual e-commerce copy." +
                ANTI_FABRICATION_RULES +
                "Your output is machine-parsed: return ONLY valid minified JSON, no markdown fence, no commentary.",
            },
          ],
        },
        contents: [{ role: "user", parts: [{ text: buildPrompt(input, grounded) }] }],
      }),
    });

    if (res.status === 429 || res.status === 503) {
      quotaStats.geminiRateLimited += 1;
      geminiCooldownUntil = Date.now() + parseRetryAfterMs(res);
      return null;
    }
    if (!res.ok) return null;

    const json = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const raw = json.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("") ?? "";
    const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    if (!cleaned) return null;

    const parsed = JSON.parse(cleaned) as Partial<Enrichment>;
    parsed.specs = groundSpecs(input.caption, parsed.specs);
    rememberEnrichment(cacheKey, parsed, `gemini:${model}`);
    return parsed;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const clampStr = (v: unknown, max: number, fallback: string) =>
  typeof v === "string" && v.trim().length > 0 ? v.trim().slice(0, max) : fallback;

const VALID_CATS = new Set(CATEGORY_RULES.map((r) => r.slug));

/**
 * True when `value` is present in the source caption (or is null/empty). Stops
 * the model substituting a brand, colour or material the supplier never wrote -
 * the single most damaging fabrication, because it turns a generic piece into a
 * branded one.
 */
export function traceableToSource(value: string | null | undefined, caption: string): boolean {
  if (value === null || value === undefined || String(value).trim() === "") return true;
  const haystack = expandAbbreviations(caption).replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  const needle = expandAbbreviations(String(value)).replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  if (!needle) return true;
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![a-z0-9])${esc(needle)}(?![a-z0-9])`).test(haystack);
}

/**
 * Ensures an LLM-generated title does not introduce ungrounded brands, colors,
 * materials, or technical claims that were absent from the source caption.
 */
function hasUngroundedEntityInText(caption: string, text: string): boolean {
  if (ungroundedClaims(caption, text).length > 0) return true;
  const lowerText = ` ${text.toLowerCase()} `;
  for (const b of BRAND_HINTS) {
    const esc = b.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(?<![a-z0-9])${esc}(?![a-z0-9])`).test(lowerText) && !traceableToSource(b, caption)) {
      return true;
    }
  }
  for (const m of MATERIALS) {
    const esc = m.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(?<![a-z0-9])${esc}(?![a-z0-9])`).test(lowerText) && !traceableToSource(m, caption)) {
      return true;
    }
  }
  return false;
}

function groundTags(caption: string, aiTags: unknown, baseTags: string[]): string[] {
  if (!Array.isArray(aiTags)) return baseTags;
  const allowed = new Set(baseTags.map((t) => t.toLowerCase()));
  for (const raw of aiTags) {
    if (typeof raw !== "string") continue;
    const t = raw.trim().toLowerCase();
    if (!t || t.length < 2 || t.length > 30) continue;
    if (STOPWORDS.has(t) || /^(premium|curated|luxury|authentic|original|genuine|guaranteed|best|new)$/.test(t)) continue;
    if (allowed.has(t) || (traceableToSource(t, caption) && !hasUngroundedEntityInText(caption, t))) {
      allowed.add(t);
    }
  }
  return Array.from(allowed).slice(0, 10);
}

function groundFaqs(
  caption: string,
  aiFaqs: unknown,
  baseFaqs: Array<{ q: string; a: string }>,
  costPrice: number,
): Array<{ q: string; a: string }> {
  if (!Array.isArray(aiFaqs)) return baseFaqs;
  const cleaned: Array<{ q: string; a: string }> = [];
  for (const item of aiFaqs) {
    if (!item || typeof item !== "object") continue;
    const rawQ = typeof (item as { q?: unknown }).q === "string" ? (item as { q: string }).q.trim() : "";
    const rawA = typeof (item as { a?: unknown }).a === "string" ? (item as { a: string }).a.trim() : "";
    if (!rawQ || !rawA || rawQ.length < 5 || rawA.length < 5) continue;
    const combined = `${rawQ} ${rawA}`;
    if (hasUngroundedEntityInText(caption, combined)) continue;
    const q = cleanProse(rawQ, costPrice).slice(0, 160);
    const a = cleanProse(rawA, costPrice).slice(0, 400);
    if (q && a) cleaned.push({ q: q.endsWith("?") ? q : `${q}?`, a });
  }
  return cleaned.length >= 2 ? cleaned.slice(0, 6) : baseFaqs;
}

function groundVariants(
  caption: string,
  aiVariants: unknown,
  baseVariants: Array<{ label: string; axis: "size" | "color" }>,
): Array<{ label: string; axis: "size" | "color" }> {
  if (!Array.isArray(aiVariants) || !aiVariants.length) return baseVariants;
  if (baseVariants.length > 0) return baseVariants;
  const valid: Array<{ label: string; axis: "size" | "color" }> = [];
  for (const v of aiVariants) {
    if (!v || typeof v !== "object") continue;
    const label = typeof (v as { label?: unknown }).label === "string" ? (v as { label: string }).label.trim().slice(0, 24) : "";
    const axis = (v as { axis?: unknown }).axis === "color" ? "color" : (v as { axis?: unknown }).axis === "size" ? "size" : null;
    if (!label || !axis) continue;
    if (traceableToSource(label, caption)) {
      valid.push({ label, axis });
    }
  }
  return valid.length ? valid.slice(0, 12) : baseVariants;
}

/** Main entrypoint: GROQ-first text intelligence with Gemini fallback + strict factual validation. */
export async function enrichProduct(input: EnrichmentInput): Promise<Enrichment> {
  const t0 = Date.now();
  const base = deterministicEnrich(input);
  // `base` is both the fallback and the grounding source: the model is shown
  // only the attributes already extracted from the caption.
  const llmResult = await llmEnrich(input, base);
  if (!llmResult) return { ...base, latencyMs: Date.now() - t0 };
  const { data: ai, modelUsed } = llmResult;

  // Prose & field grounding. Every field is checked for ungrounded technical
  // claims, ungrounded brands/materials, and commercial leaks. If the model
  // used a claim the supplier never wrote, that field falls back to `base`.
  const titleUngrounded = hasUngroundedEntityInText(input.caption, String(ai.title ?? ""));
  const descriptionUngrounded = hasUngroundedEntityInText(input.caption, String(ai.description ?? ""));
  const shortAnswerUngrounded = hasUngroundedEntityInText(input.caption, String(ai.shortAnswer ?? ""));
  const subtitleUngrounded = hasUngroundedEntityInText(input.caption, String(ai.subtitle ?? ""));
  const seoTitleUngrounded = hasUngroundedEntityInText(input.caption, String(ai.seoTitle ?? ""));
  const seoDescUngrounded = hasUngroundedEntityInText(input.caption, String(ai.seoDescription ?? ""));
  const altTextUngrounded = hasUngroundedEntityInText(input.caption, String(ai.altText ?? ""));

  const finalCat =
    typeof ai.categorySlug === "string" && VALID_CATS.has(ai.categorySlug) && base.confidence < 0.9
      ? ai.categorySlug
      : base.categorySlug;
  const finalBrand =
    typeof ai.brand === "string" && traceableToSource(ai.brand, input.caption)
      ? titleCase(ai.brand).slice(0, 40)
      : base.brand;
  const finalColor =
    typeof ai.color === "string" && traceableToSource(ai.color, input.caption)
      ? titleCase(ai.color).slice(0, 30)
      : base.color;
  const finalMaterial =
    typeof ai.material === "string" && traceableToSource(ai.material, input.caption)
      ? titleCase(ai.material).slice(0, 40)
      : base.material;

  const rawTitle = titleUngrounded ? base.title : clampStr(ai.title, 90, base.title);
  const finalTitle = cleanTitleText(rawTitle, finalCat, finalBrand) || base.title;

  const rawSub = subtitleUngrounded ? base.subtitle : clampStr(ai.subtitle, 120, base.subtitle);
  const finalSub = cleanProse(rawSub, base.costPrice) || base.subtitle;

  const rawDesc = descriptionUngrounded ? base.description : clampStr(ai.description, 2000, base.description);
  const finalDesc = cleanProse(rawDesc, base.costPrice) || base.description;

  const rawShort = shortAnswerUngrounded ? base.shortAnswer : clampStr(ai.shortAnswer, 600, base.shortAnswer);
  const finalShort = cleanProse(rawShort, base.costPrice) || base.shortAnswer;

  const groundedAiSpecs = groundSpecs(input.caption, ai.specs as Record<string, string> | undefined);
  const cleanSpecs: Record<string, string> = {
    ...base.specs,
    ...groundedAiSpecs,
  };
  if (finalBrand) cleanSpecs.Brand = finalBrand;
  else delete cleanSpecs.Brand;
  if (finalColor) cleanSpecs.Colour = finalColor;
  else delete cleanSpecs.Colour;
  if (finalMaterial) cleanSpecs.Material = finalMaterial;
  else delete cleanSpecs.Material;
  cleanSpecs.Category = titleCase(finalCat);
  cleanSpecs.Gender = base.specs.Gender;
  cleanSpecs.Delivery = base.specs.Delivery;
  cleanSpecs.Sourcing = base.specs.Sourcing;

  const finalGender =
    (ai.gender === "men" || ai.gender === "women") && base.gender !== "unisex"
      ? ai.gender
      : base.gender;

  const rawSeoTitle = seoTitleUngrounded ? base.seoTitle : clampStr(ai.seoTitle, 60, base.seoTitle);
  const rawSeoDesc = seoDescUngrounded ? base.seoDescription : clampStr(ai.seoDescription, 158, base.seoDescription);
  const rawAltText = altTextUngrounded ? base.altText : clampStr(ai.altText, 160, base.altText);

  const merged: Enrichment = {
    ...base,
    title: finalTitle,
    subtitle: finalSub,
    description: finalDesc,
    shortAnswer: finalShort,
    categorySlug: finalCat,
    brand: finalBrand,
    color: finalColor,
    material: finalMaterial,
    gender: finalGender,
    tags: groundTags(input.caption, ai.tags, base.tags),
    specs: cleanSpecs,
    faqs: groundFaqs(input.caption, ai.faqs, base.faqs, base.costPrice),
    seoTitle: cleanTitleText(rawSeoTitle, finalCat, finalBrand) || base.seoTitle,
    seoDescription: cleanProse(rawSeoDesc, base.costPrice) || base.seoDescription,
    altText: cleanTitleText(rawAltText, finalCat, finalBrand) || base.altText,
    variants: groundVariants(input.caption, ai.variants, base.variants),
    costPrice:
      Number.isFinite(ai.costPrice) &&
      Number(ai.costPrice) > 0 &&
      extractNumbers(input.caption).includes(Math.round(Number(ai.costPrice)))
        ? Math.round(Number(ai.costPrice))
        : base.costPrice,
    mrp: 0, // Always derived downstream by computePricing (cost × 1.40)
    confidence: Number.isFinite(ai.confidence) ? Math.min(1, Math.max(0, Number(ai.confidence))) : base.confidence,
    model: modelUsed,
    latencyMs: Date.now() - t0,
  };
  return { ...merged, qualityScore: qualityScore(merged, Boolean(input.imageUrl)) };
}

/* ---------------- Gemini visual verification & frame selection ---------------- */

export type MediaVerificationInput = {
  imageUrls?: string[];
  imageBuffers?: Array<{ buffer: Buffer; mimeType?: string }>;
  caption?: string;
  expectedCategory?: string | null;
};

export type MediaVerification = {
  usable: boolean;
  showsIntendedProduct: boolean;
  isBlurry: boolean;
  isObstructed: boolean;
  isMisleading: boolean;
  bestFrameIndex: number;
  usableIndices: number[];
  viewAngles: Array<"front" | "side" | "back" | "detail" | "angled" | "unknown">;
  detectedCategory: string | null;
  confidence: number;
  reason: string | null;
  model: string;
  cached: boolean;
};

const mediaVerificationCache = new Map<string, { value: MediaVerification; expires: number }>();

function isValidMediaUrl(url: string): boolean {
  if (!url || typeof url !== "string") return false;
  const trimmed = url.trim();
  if (!/^https?:\/\/[^\s]+$/i.test(trimmed)) return false;
  if (/\.(svg|gif|ico)(\?|$)/i.test(trimmed)) return false;
  return true;
}

/**
 * Verifies product media without ever modifying or generating pixels.
 *
 * 1. Runs zero-cost deterministic checks on URLs/buffers first.
 * 2. Caches verification results for 7 days by media key so repeated products
 *    or retries never re-consume Gemini quota.
 * 3. Uses Gemini multimodal (`GEMINI_API_KEY`) only when available and within
 *    free-quota concurrency/cooldown limits to verify product presence,
 *    detect blur/obstruction/misleading frames, and pick the cleanest primary frame.
 */
export async function verifyProductMedia(input: MediaVerificationInput): Promise<MediaVerification> {
  const urls = (input.imageUrls ?? []).map((u) => String(u || "").trim()).filter(Boolean);
  const buffers = input.imageBuffers ?? [];
  const totalCount = buffers.length || urls.length;

  if (totalCount === 0) {
    return {
      usable: false,
      showsIntendedProduct: false,
      isBlurry: false,
      isObstructed: false,
      isMisleading: false,
      bestFrameIndex: 0,
      usableIndices: [],
      viewAngles: [],
      detectedCategory: null,
      confidence: 1,
      reason: "no product media supplied",
      model: "deterministic-media-v1",
      cached: false,
    };
  }

  // Deterministic URL/buffer validation first (zero API cost).
  const validIndices: number[] = [];
  if (buffers.length > 0) {
    buffers.forEach((item, idx) => {
      if (item?.buffer && item.buffer.length >= 1024) validIndices.push(idx);
    });
  } else {
    urls.forEach((u, idx) => {
      if (isValidMediaUrl(u)) validIndices.push(idx);
    });
  }

  if (validIndices.length === 0) {
    return {
      usable: false,
      showsIntendedProduct: false,
      isBlurry: false,
      isObstructed: false,
      isMisleading: true,
      bestFrameIndex: 0,
      usableIndices: [],
      viewAngles: [],
      detectedCategory: null,
      confidence: 1,
      reason: "invalid or corrupt product media",
      model: "deterministic-media-v1",
      cached: false,
    };
  }

  const cacheKey = `${input.expectedCategory ?? "any"}::${urls.slice(0, 4).join("|")}::${buffers.length}`;
  const cached = mediaVerificationCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    quotaStats.mediaCacheHits += 1;
    return { ...cached.value, cached: true };
  }

  const deterministicDefault: MediaVerification = {
    usable: true,
    showsIntendedProduct: true,
    isBlurry: false,
    isObstructed: false,
    isMisleading: false,
    bestFrameIndex: validIndices[0] ?? 0,
    usableIndices: validIndices,
    viewAngles: validIndices.map(() => "front"),
    detectedCategory: input.expectedCategory ?? null,
    confidence: 0.8,
    reason: null,
    model: "deterministic-media-v1",
    cached: false,
  };

  // Only invoke Gemini Vision when GEMINI_API_KEY is configured and not cooling down.
  const key = process.env.GEMINI_API_KEY;
  if (!key || Date.now() < geminiCooldownUntil) {
    mediaVerificationCache.set(cacheKey, { value: deterministicDefault, expires: Date.now() + GEMINI_CACHE_TTL_MS });
    return deterministicDefault;
  }

  let resolvedBuffers = buffers.slice(0, 3);
  if (resolvedBuffers.length === 0 && urls.length > 0) {
    const fetched: Array<{ buffer: Buffer; mimeType?: string }> = [];
    for (const url of urls.slice(0, 2)) {
      if (/^https?:\/\/(x|example\.com|localhost)\b/i.test(url)) continue;
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
        if (!res.ok) continue;
        const ct = res.headers.get("content-type") || "image/webp";
        if (!ct.startsWith("image/")) continue;
        const ab = await res.arrayBuffer();
        if (ab.byteLength >= 1024 && ab.byteLength <= 4 * 1024 * 1024) {
          fetched.push({ buffer: Buffer.from(ab), mimeType: ct.split(";")[0] });
        }
      } catch {
        /* unreachable URL falls back to deterministic */
      }
    }
    resolvedBuffers = fetched;
  }

  if (resolvedBuffers.length === 0) {
    mediaVerificationCache.set(cacheKey, { value: deterministicDefault, expires: Date.now() + GEMINI_CACHE_TTL_MS });
    return deterministicDefault;
  }

  return withGeminiSlot(async () => {
    const model = process.env.GEMINI_VISION_MODEL || process.env.GEMINI_MODEL || GEMINI_DEFAULT_MODEL;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      quotaStats.geminiVisionCalls += 1;
      const candidateBuffers = resolvedBuffers.slice(0, 3);
      const parts: Array<Record<string, unknown>> = [
        {
          text: [
            "You are MatzHub's visual product verifier. Inspect the candidate product image(s)/frame(s).",
            `Expected category: ${input.expectedCategory || "unknown"}`,
            `Supplier caption: ${(input.caption || "").slice(0, 300)}`,
            "Rules:",
            "1. Verify whether the image(s) clearly show the actual physical product without heavy blur, severe obstruction, or misleading/unrelated content (e.g. text-only flyer, QR code, screenshot of chat, blank frame).",
            "2. Identify the view angle of each image ('front', 'side', 'back', 'detail', 'angled', 'unknown') and select bestFrameIndex (0-based) with the clearest, sharpest, unobstructed primary view of the product.",
            "3. Mark a frame unusable (exclude it from usableIndices) if it is packaging/box-only without the actual product visible, a promotional banner/poster or text-only graphic, or if the product is substantially obstructed (e.g. covered by a hand or other objects). Never prefer such frames as bestFrameIndex.",
            "4. Verify visual consistency across frames (all usable frames must show the same intended product).",
            'Return ONLY valid minified JSON: {"usable":boolean,"showsIntendedProduct":boolean,"isBlurry":boolean,"isObstructed":boolean,"isMisleading":boolean,"bestFrameIndex":number,"usableIndices":number[],"viewAngles":string[],"detectedCategory":string|null,"confidence":number,"reason":string|null}',
          ].join("\n"),
        },
      ];
      for (const item of candidateBuffers) {
        parts.push({
          inline_data: {
            mime_type: item.mimeType || "image/webp",
            data: item.buffer.toString("base64"),
          },
        });
      }

      const res = await fetch(`${GEMINI_ENDPOINT}/${model}:generateContent`, {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({
          generationConfig: { temperature: 0.1, responseMimeType: "application/json", maxOutputTokens: 400 },
          contents: [{ role: "user", parts }],
        }),
      });

      if (res.status === 429 || res.status === 503) {
        quotaStats.geminiRateLimited += 1;
        geminiCooldownUntil = Date.now() + parseRetryAfterMs(res);
        return deterministicDefault;
      }
      if (!res.ok) return deterministicDefault;

      const json = (await res.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      };
      const raw = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
      const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
      if (!cleaned) return deterministicDefault;

      const parsed = JSON.parse(cleaned) as Partial<MediaVerification>;
      const usableIndices = Array.isArray(parsed.usableIndices)
        ? parsed.usableIndices.filter((i) => Number.isInteger(i) && i >= 0 && i < totalCount)
        : validIndices;
      const bestFrameIndex =
        typeof parsed.bestFrameIndex === "number" &&
        parsed.bestFrameIndex >= 0 &&
        parsed.bestFrameIndex < totalCount
          ? parsed.bestFrameIndex
          : (usableIndices[0] ?? 0);
      const usable = Boolean(parsed.usable ?? true) && Boolean(parsed.showsIntendedProduct ?? true) && !parsed.isMisleading && usableIndices.length > 0;

      const result: MediaVerification = {
        usable,
        showsIntendedProduct: Boolean(parsed.showsIntendedProduct ?? usable),
        isBlurry: Boolean(parsed.isBlurry ?? false),
        isObstructed: Boolean(parsed.isObstructed ?? false),
        isMisleading: Boolean(parsed.isMisleading ?? false),
        bestFrameIndex,
        usableIndices: usable ? usableIndices : [],
        viewAngles: Array.isArray(parsed.viewAngles) ? (parsed.viewAngles.slice(0, totalCount) as MediaVerification["viewAngles"]) : deterministicDefault.viewAngles,
        detectedCategory: typeof parsed.detectedCategory === "string" ? parsed.detectedCategory : (input.expectedCategory ?? null),
        confidence: Number.isFinite(parsed.confidence) ? Math.min(1, Math.max(0, Number(parsed.confidence))) : 0.85,
        reason: typeof parsed.reason === "string" && parsed.reason.trim() ? parsed.reason.trim().slice(0, 200) : null,
        model: `gemini:${model}`,
        cached: false,
      };
      mediaVerificationCache.set(cacheKey, { value: result, expires: Date.now() + GEMINI_CACHE_TTL_MS });
      return result;
    } catch {
      return deterministicDefault;
    } finally {
      clearTimeout(timer);
    }
  });
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

/* imageHashSimilarity removed: hash-digest char similarity is not a visual signal; dedupe uses exact hash equality plus caption similarity. */

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

/* ==========================================================================
   AUTHORITATIVE SUPPLIER GROUPS
   ========================================================================== */

/**
 * The ONLY WhatsApp groups MatzHub treats as supplier sources.
 *
 * The paired account can see 19 groups. Every one of the nine real supplier
 * groups exists TWICE: once as the live reseller broadcast channel (165-1464
 * members) and once as a near-empty 2-3 member duplicate. There is also an
 * unrelated group ("Mfbuddy watch group 13") that is not ours.
 *
 * Identity is the JID, never the display name — two groups genuinely share a
 * name, so name-matching would merge a live channel with a dead duplicate.
 * The live channel is the authoritative one: real supplier traffic arrives
 * there (observed from Sunglasses 120363089280152472), and a 2-member group
 * cannot be a reseller broadcast channel.
 *
 * This list is deliberately CLOSED. Newly discovered groups are never added
 * automatically — adding one is an explicit edit here, reviewed in a PR.
 * `worker/group-mapping.json` mirrors these JIDs for the worker.
 */
/**
 * Sole source is src/lib/supplier-groups.ts (backed by worker/group-mapping.json).
 * Re-exported here for the deterministic ingestion and Telegram-routing test contracts.
 */
export const AUTHORITATIVE_GROUPS: ReadonlyArray<{
  jid: string;
  name: string;
  category: string;
}> = approvedSupplierGroups.map(({ jid, name, category }) => ({ jid, name, category }));

const AUTHORITATIVE_BY_JID = new Map(AUTHORITATIVE_GROUPS.map((g) => [g.jid, g]));

/** True only for a JID on the closed allowlist above. */
export function isAuthoritativeGroup(jid: string | null | undefined): boolean {
  return Boolean(jid && AUTHORITATIVE_BY_JID.has(jid));
}

export function authoritativeGroup(jid: string | null | undefined) {
  return jid ? AUTHORITATIVE_BY_JID.get(jid) ?? null : null;
}

/**
 * Collapses a discovered group list onto the allowlist.
 *
 * Deduplicates by JID (the stable identity), drops everything not on the
 * allowlist, and returns them in allowlist order so the Telegram selector is
 * stable between refreshes. Idempotent: running it twice yields the same nine.
 */
export function resolveAuthoritativeGroups<T extends { jid?: string | null }>(
  discovered: ReadonlyArray<T>,
): Array<T & { name: string; category: string }> {
  const seen = new Map<string, T>();
  for (const g of discovered) {
    if (!g?.jid || !AUTHORITATIVE_BY_JID.has(g.jid)) continue;
    if (!seen.has(g.jid)) seen.set(g.jid, g);
  }
  return AUTHORITATIVE_GROUPS.flatMap((a) => {
    const hit = seen.get(a.jid);
    return hit ? [{ ...hit, name: a.name, category: a.category }] : [];
  });
}
