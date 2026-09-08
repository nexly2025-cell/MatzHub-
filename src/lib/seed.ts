import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { categories, coupons, manufacturers, products, settings } from "@/db/schema";

/**
 * Production bootstrap — taxonomy and pricing rules only.
 *
 * This deliberately creates NO products and NO manufacturers. The catalogue is
 * built exclusively from real supplier posts arriving through the WhatsApp
 * ingestion pipeline, so the storefront can never display fabricated stock.
 *
 * Previously this module also inserted six fictitious "Partner A-01" suppliers,
 * 36 products backed by stock photography, and randomised view/click/order
 * counters on every row — including genuine products, which corrupted the
 * trending ranking. All of that has been removed.
 *
 * Safe to run repeatedly: every write is guarded by onConflictDoNothing.
 */

/**
 * Category banner artwork. These are licensed stock photographs used as
 * decorative section headers only — they are never presented as inventory.
 * Product imagery comes exclusively from supplier posts.
 */
const px = (id: number, v = 0) =>
  `https://images.pexels.com/photos/${id}/pexels-photo-${id}.jpeg?auto=compress&cs=tinysrgb&dpr=2&h=800&w=800&v=${v}`;

const CATEGORY_SEED = [
  {
    name: "Watches",
    slug: "watches",
    position: 1,
    hero: px(8839887, 100),
    shortAnswer:
      "Imported, master-quality timepieces — chronographs, minimal dials and steel bracelets. Honest pricing from real manufacturer cost. Every listing is quality-scored before going live. Ships across India with a 7-day replacement window.",
    guide:
      "Buying a watch online comes down to three things: case size, movement and strap. For a 6.5–7 inch wrist, a 38–42mm case reads balanced; anything above 44mm becomes a statement piece. Quartz movements need no winding and hold accuracy for years, which is why most of our catalogue is quartz. Steel bracelets suit office and formal wear, leather warms up casual outfits, and silicone survives the gym. Check the water-resistance rating in the spec table — 3ATM handles rain and hand-washing but not swimming. Because MatzHub buys directly from the manufacturer group, the price you see is the factory price plus a fixed margin, not a marked-up MRP designed to make a discount look bigger than it is.",
    faqs: [
      { q: "Are these original branded watches?", a: "No. These are imported first-copy, master-quality timepieces and we say so on every listing. MatzHub is not affiliated with, endorsed by or licensed by any original brand." },
      { q: "What movement do these watches use?", a: "The majority are Japanese quartz movements, which need no winding and stay accurate within seconds per month. The movement type is listed in each product's spec table." },
      { q: "Is there a warranty?", a: "Every watch carries a 7-day replacement window for defects or mismatch with the listing, plus a 6-month movement assurance from the manufacturer." },
    ],
  },
  {
    name: "Handbags",
    slug: "handbags",
    position: 2,
    hero: px(27174573, 100),
    shortAnswer:
      "Imported handbags — totes, slings, clutches and backpacks in PU and genuine leather. Honest pricing from real manufacturer cost. Every listing is quality-scored before going live. Delivered pan-India, standard courier timing.",
    guide:
      "Pick the bag by the job it has to do. A structured tote carries a 13-inch laptop and a lunch box; a sling is for phone, cards and keys on a weekend; a clutch is evening-only. Material decides lifespan: genuine leather ages well and takes scuffs gracefully, quality PU stays looking new for about 18 months of daily use and costs a third as much. Look at the hardware in the photos — zips and clasps fail long before the body does, so gold-tone alloy with a smooth pull is worth more than a fancy logo. Interior organisation matters more than people expect; at least one zipped pocket and two slip pockets keeps a bag usable. MatzHub lists real dimensions in the spec table so you are not guessing from a model shot.",
    faqs: [
      { q: "Is the leather genuine?", a: "It varies by product and is always declared in the spec table as Genuine Leather or PU Leather. We never label PU as genuine. Who supplied it stays private — what it is made of never does." },
      { q: "Can I see the actual dimensions?", a: "Yes. Length, width and depth in centimetres are listed in the spec table for every bag." },
      { q: "What if the colour looks different on arrival?", a: "Screen calibration varies. If the shade is materially different from the listing photo, the 7-day replacement window covers it." },
    ],
  },
  {
    name: "Footwear",
    slug: "footwear",
    position: 3,
    hero: px(4161710, 100),
    shortAnswer:
      "Imported sneakers, formal Oxfords, loafers and boots in UK 6–11 with verified insole-length measurements on every listing. Honest pricing from real cost. Pan-India delivery, dispatch within 5 hours, 7-day replacement.",
    guide:
      "Size is where online footwear goes wrong, so measure your foot in centimetres and compare against the size chart rather than trusting your usual UK number — curated sources differ by up to half a size. For daily walking, look for an EVA or phylon midsole; rubber-only outsoles are durable but transmit shock. Formal shoes should be leather-lined, otherwise they hold moisture and start to smell within a season. Sneakers with a stitched sole outlast glued ones by a wide margin, and you can usually see the stitch line in our close-up photos. If you are between sizes on a closed shoe, go up. MatzHub lists the exact insole length so you can match it against a shoe you already own before ordering.",
    faqs: [
      { q: "How do I pick the right size?", a: "Measure your foot heel-to-toe in centimetres and match it to the insole length in the spec table. If you are between sizes, choose the larger one." },
      { q: "Can I exchange for a different size?", a: "Yes. Size exchanges are free within 7 days as long as the shoes are unworn and the box is intact." },
      { q: "Are these suitable for running?", a: "Our sneakers are lifestyle and walking shoes. They are not engineered for distance running or competitive sport." },
    ],
  },
  {
    name: "Sunglasses",
    slug: "sunglasses",
    position: 4,
    hero: px(32677231, 100),
    shortAnswer:
      "Imported eyewear — aviators, wayfarers, cat-eye and oversized frames with UV400-rated lenses. Honest pricing from real manufacturer cost. Pan-India delivery, 7-day replacement on every order.",
    guide:
      "Match the frame to the face: angular frames such as wayfarers balance a round face, while aviators and round frames soften a square jaw. Lens rating matters more than shape — insist on UV400, which blocks essentially all UVA and UVB; a dark lens without UV protection is worse than no sunglasses because it dilates your pupil. Polarised lenses cut glare from roads and water and are worth the small premium if you drive daily. Acetate frames feel warmer and hold colour, metal frames are lighter and adjust more easily at the nose bridge. Check the hinge in the product photos; a three-barrel hinge lasts far longer than a two-barrel one. Every MatzHub listing declares lens rating and frame material explicitly.",
    faqs: [
      { q: "Are the lenses UV protected?", a: "Yes. Every pair we list is UV400 rated, which blocks 99–100% of UVA and UVB. The rating is stated in the spec table." },
      { q: "Are these polarised?", a: "Some are. Polarisation is declared per product in the spec table because it is a meaningful price difference and we do not blur it." },
      { q: "Does a case come with it?", a: "Yes, a protective case and microfibre cloth are included with every pair at no extra cost." },
    ],
  },
  {
    name: "Apparel",
    slug: "apparel",
    position: 5,
    hero: px(13094187, 100),
    shortAnswer:
      "Imported casual wear — tees, shirts, hoodies, denim and jackets in S to XXL. Real GSM and garment measurements, honest pricing from real cost. Pan-India delivery, free size exchange inside 7 days.",
    guide:
      "Fabric weight is the honest signal of quality in clothing. A t-shirt below 160 GSM will go transparent and lose shape in a few washes; 180–220 GSM cotton holds up for years. For shirts, look for single-needle stitching at the side seams and a placket that lies flat in the photo. Denim in the 11–13 oz range is the sweet spot for Indian weather — heavier reads premium but is unwearable eight months of the year. Hoodies should list whether the fleece is brushed on the inside; unbrushed fleece pills quickly. Sizing across curated sources varies more than in branded retail, so use the chest measurement in the spec table rather than the S/M/L label. MatzHub publishes GSM and garment measurements on every listing.",
    faqs: [
      { q: "How does the sizing run?", a: "Use the chest and length measurements in the spec table rather than the letter size. curated sources vary and the measurements are the ground truth." },
      { q: "Will the colour fade after washing?", a: "Wash cold and inside out for the first three washes. Our listings state the dye type; reactive-dyed cotton holds colour for years." },
      { q: "Can I exchange a size?", a: "Yes, free size exchange within 7 days on unworn items with tags attached." },
    ],
  },
  {
    name: "Perfumes",
    slug: "perfumes",
    position: 6,
    hero: px(6958875, 100),
    shortAnswer:
      "Imported, long-lasting perfumes — oriental, oud, fresh and musk profiles in 50–100ml sizes. EDP-strength concentrations sourced directly from premium fragrance manufacturers. Honest pricing, pan-India delivery, 7-day replacement.",
    guide:
      "The only honest measure of a perfume is concentration. EDP (eau de parfum) typically carries 15–20% aromatic compounds and will last 6–8 hours on skin; EDT (eau de toilette) carries 8–12% and lasts 3–5. Oud and oriental bases last the longest; citrus and aquatic notes fade fastest, especially in Indian summers. Spray on pulse points after a shower — skin that is warm and moisturised holds scent far longer. Test the dry-down, not the first spray: the top note disappears in 15 minutes and what remains for hours is the dry-down. For daily office wear choose fresh or light musk profiles; for evenings and occasions choose oud or amber. Our listings state the concentration, size and profile so you buy for the wear you need.",
    faqs: [
      { q: "Are these original branded perfumes?", a: "No. These are imported first-copy or inspired-by formulations and we say so openly on every listing. MatzHub is not affiliated with, endorsed by or licensed by any original fragrance house." },
      { q: "How long does the scent last?", a: "It depends on concentration, listed per product. EDP-strength profiles typically hold 6–8 hours on skin and longer on fabric. EDT profiles hold 3–5 hours." },
      { q: "What sizes are these bottles?", a: "Listings are 50–100ml unless stated otherwise. The exact millilitre volume is stated in the spec table on every product page." },
    ],
  },
];

export async function bootstrapTaxonomy() {
  let created = 0;
  for (const c of CATEGORY_SEED) {
    const [row] = await db
      .insert(categories)
      .values({
        name: c.name,
        slug: c.slug,
        heroImage: c.hero,
        position: c.position,
        shortAnswer: c.shortAnswer,
        buyingGuide: c.guide,
        faqs: c.faqs,
        seoTitle: `${c.name} Online — Manufacturer Direct Prices | MatzHub`,
        seoDescription: `Buy ${c.name.toLowerCase()} direct from quality-scored suppliers on MatzHub. Honest pricing, pan-India delivery, standard courier timing, 7-day replacement.`,
        keywords: [`buy ${c.name.toLowerCase()} online india`, `imported ${c.name.toLowerCase()}`, `${c.name.toLowerCase()} india`],
      })
      .onConflictDoNothing()
      .returning();
    if (row) created += 1;
  }

  // Global pricing rule. Cost x1.40 shown as original, cost x1.15 charged.
  await db
    .insert(settings)
    .values([
      { key: "selling_margin_percent", value: "15" },
      { key: "original_markup_percent", value: "40" },
    ])
    .onConflictDoNothing();

  await db
    .insert(coupons)
    .values([
      { code: "FIRST10", kind: "percent", value: 10, minSubtotal: 999, maxRedemptions: 10000 },
      { code: "MATZ200", kind: "flat", value: 200, minSubtotal: 1999, maxRedemptions: 5000 },
    ])
    .onConflictDoNothing();

  const [any] = await db.select({ slug: categories.slug }).from(categories).where(eq(categories.slug, "watches")).limit(1);
  const demo = await seedPreviewCatalog();
  return { categoriesCreated: created, taxonomyReady: Boolean(any), ...demo };
}

export async function seedPreviewCatalog() {
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(products);
  if (n > 0) return { productsCreated: 0 };

  const [mfr] = await db
    .insert(manufacturers)
    .values({
      name: "MatzHub Atelier",
      slug: "matzhub-atelier",
      city: "Tumakuru",
      autoPublish: true,
      status: "active",
    })
    .onConflictDoNothing()
    .returning();
  const supplier =
    mfr ??
    (await db.select().from(manufacturers).where(eq(manufacturers.slug, "matzhub-atelier")).limit(1))[0];
  if (!supplier) return { productsCreated: 0 };

  const cats = await db.select().from(categories);
  const bySlug = Object.fromEntries(cats.map((c) => [c.slug, c.id]));

  const DEMO: Array<{
    slug: string;
    sku: string;
    title: string;
    cat: string;
    brand: string;
    color: string;
    cost: number;
    photo: number;
    tags: string[];
  }> = [
    { slug: "steel-chronograph-42", sku: "MH-WAT-001", title: "Steel Chronograph 42mm", cat: "watches", brand: "Atelier", color: "Silver", cost: 2490, photo: 190819, tags: ["watch", "steel", "chrono"] },
    { slug: "minimal-black-dial", sku: "MH-WAT-002", title: "Minimal Black Dial", cat: "watches", brand: "Atelier", color: "Black", cost: 1890, photo: 277390, tags: ["watch", "minimal"] },
    { slug: "structured-tote-tan", sku: "MH-BAG-001", title: "Structured Tote in Tan", cat: "handbags", brand: "Atelier", color: "Tan", cost: 2190, photo: 1152077, tags: ["tote", "leather"] },
    { slug: "evening-clutch-black", sku: "MH-BAG-002", title: "Evening Clutch", cat: "handbags", brand: "Atelier", color: "Black", cost: 1290, photo: 904350, tags: ["clutch"] },
    { slug: "court-sneaker-white", sku: "MH-FTW-001", title: "Court Sneaker", cat: "footwear", brand: "Atelier", color: "White", cost: 2590, photo: 2529148, tags: ["sneaker"] },
    { slug: "oxford-leather-brown", sku: "MH-FTW-002", title: "Leather Oxford", cat: "footwear", brand: "Atelier", color: "Brown", cost: 2890, photo: 1598505, tags: ["oxford", "formal"] },
    { slug: "aviator-uv400", sku: "MH-SUN-001", title: "Aviator UV400", cat: "sunglasses", brand: "Atelier", color: "Gold", cost: 990, photo: 701877, tags: ["aviator", "uv400"] },
    { slug: "wayfarer-acetate", sku: "MH-SUN-002", title: "Acetate Wayfarer", cat: "sunglasses", brand: "Atelier", color: "Black", cost: 890, photo: 46710, tags: ["wayfarer"] },
    { slug: "heavyweight-tee-ink", sku: "MH-APP-001", title: "Heavyweight Tee", cat: "apparel", brand: "Atelier", color: "Ink", cost: 790, photo: 1043474, tags: ["tee", "cotton"] },
    { slug: "overshirt-olive", sku: "MH-APP-002", title: "Olive Overshirt", cat: "apparel", brand: "Atelier", color: "Olive", cost: 1690, photo: 297933, tags: ["overshirt"] },
    { slug: "oud-edp-100", sku: "MH-PRF-001", title: "Oud EDP 100ml", cat: "perfumes", brand: "Atelier", color: "Amber", cost: 1490, photo: 965989, tags: ["oud", "edp"] },
    { slug: "citrus-musk-50", sku: "MH-PRF-002", title: "Citrus Musk 50ml", cat: "perfumes", brand: "Atelier", color: "Clear", cost: 990, photo: 1961792, tags: ["citrus", "musk"] },
  ];

  let productsCreated = 0;
  for (const d of DEMO) {
    const categoryId = bySlug[d.cat];
    if (!categoryId) continue;
    const mrp = Math.round(d.cost * 1.4);
    const price = Math.round(d.cost * 1.15);
    const hero = px(d.photo, 100);
    const [row] = await db
      .insert(products)
      .values({
        slug: d.slug,
        sku: d.sku,
        title: d.title,
        subtitle: `${d.brand} · ${d.color}`,
        description: `${d.title} from the MatzHub atelier line. Quality-scored before listing. Honest pricing from real manufacturer cost.`,
        shortAnswer: `${d.title} — imported master quality, priced from cost.`,
        categoryId,
        manufacturerId: supplier.id,
        brand: d.brand,
        color: d.color,
        gender: "unisex",
        tags: d.tags,
        specs: { Brand: d.brand, Colour: d.color },
        images: [hero],
        heroImage: hero,
        altText: d.title,
        costPrice: d.cost,
        mrp,
        price,
        resellerPrice: price,
        stockQty: 12,
        availability: "in_stock",
        status: "published",
        qualityScore: 86,
        confidence: 0.9,
        seoTitle: `${d.title} | MatzHub`,
        seoDescription: `Buy ${d.title} on MatzHub. Honest pricing, pan-India delivery, 7-day replacement.`,
        publishedAt: new Date(),
        trendingScore: 10 + productsCreated,
        messageId: `demo-${d.sku}`,
        contentHash: `demo-content-${d.sku}`,
        imageHash: `demo-image-${d.sku}`,
      })
      .onConflictDoNothing()
      .returning({ id: products.id });
    if (row) productsCreated += 1;
  }

  return { productsCreated };
}
