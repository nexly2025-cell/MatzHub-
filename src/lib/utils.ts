export const SITE = {
  name: "MatzHub",
  legalName: "MatzHub Retail",
  tagline: "Imported, master-quality accessories and apparel — priced without the middleman.",
  url: process.env.NEXT_PUBLIC_SITE_URL || "https://matzhub.com",
  whatsapp: process.env.NEXT_PUBLIC_CUSTOMER_WHATSAPP || "9187412133", // Customer-facing sales number
  email: "hello@matzhub.com",
  country: "IN",
  currency: "INR",
  founded: "2017",
  instagram: "https://www.instagram.com/_matzhub_?igsh=Z2d6YXJidGpxcHR1",
  // Co-founder, listed on the About page only. No personal contact details.
  cofounder: {
    name: "Salman Khan",
    role: "Co-founder",
    instagram: "https://www.instagram.com/salman_khan_ga?igsh=MWQyM2t5b284djU3ZA==",
  },
  gstin: "29ACGFM1394B1Z5",
  address: "Shop No. 11 & 12, 1st Floor, MK Complex, Melekote Main Road, Sadashivanagar",
  city: "Bengaluru",
  registeredCity: "Tumakuru",
  state: "Karnataka",
  pincode: "572101",
};

/**
 * Delivery + cart rules. ONE definition, shared by the client cart, the
 * WhatsApp order message and the server-side order validator, so a customer
 * can never be quoted one total in the UI and charged another in the record.
 */
export const FREE_DELIVERY_OVER = 999;
export const DELIVERY_FEE = 59;
/** Per-line ceiling, enforced client-side and re-enforced on the server. */
export const MAX_QTY_PER_LINE = 10;

export const inr = (n: number) => `₹${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(n)}`;

export const savePercent = (mrp: number, price: number) =>
  mrp > 0 && price < mrp ? Math.round(((mrp - price) / mrp) * 100) : 0;

export const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" ");

/**
 * Order number: MH + YYMMDD + 4 random hex chars.
 *
 * Uses the Web Crypto global (Node 18+, Edge and browsers all provide it)
 * rather than `node:crypto`. A top-level `node:crypto` import here pulled a
 * ~439 KB `crypto-browserify` polyfill into the client bundle, because seven
 * client components import other helpers from this module.
 */
export const orderNo = () => {
  const b = crypto.getRandomValues(new Uint8Array(5));
  const rand = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("").toUpperCase();
  return `MH${new Date().toISOString().slice(2, 10).replace(/-/g, "")}${rand}`;
};

export const waLink = (text: string) => `https://wa.me/${SITE.whatsapp}?text=${encodeURIComponent(text)}`;

export const relativeTime = (d: Date | string | null | undefined) => {
  if (!d) return "never";
  const ms = Date.now() - new Date(d).getTime();
  const mins = Math.round(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
};

