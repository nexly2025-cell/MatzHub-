#!/usr/bin/env node
import "dotenv/config";
import pg from "pg";
const { Pool } = pg;

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  console.error("DATABASE_URL is missing in environment!");
  process.exit(1);
}

const isLocal = /(localhost|127\.0\.0\.1)/.test(dbUrl);
const pool = new Pool({
  connectionString: dbUrl,
  ssl: isLocal ? undefined : { rejectUnauthorized: false },
});

async function seed() {
  console.log("Seeding storefront placeholders...");
  try {
    // 1. Get all categories
    const { rows: cats } = await pool.query("select id, slug from categories");
    const catBySlug = new Map(cats.map((c) => [c.slug, c.id]));
    console.log("Found categories:", [...catBySlug.keys()]);

    // 2. Get/Create a default manufacturer
    let mfrId;
    const { rows: mfrs } = await pool.query("select id from manufacturers limit 1");
    if (mfrs.length > 0) {
      mfrId = mfrs[0].id;
    } else {
      const newMfrId = "11111111-2222-3333-4444-555555555555";
      await pool.query(
        "insert into manufacturers (id, name, slug, status) values ($1, $2, $3, $4)",
        [newMfrId, "Premium Curated Sourcing", "premium-curated-sourcing", "active"]
      );
      mfrId = newMfrId;
    }
    console.log("Using manufacturer ID:", mfrId);

    // 3. Clear existing placeholder products to prevent unique constraints
    await pool.query("delete from products where sku in ($1, $2, $3, $4, $5)", [
      "MH-WTCH-01",
      "MH-BAG-01",
      "MH-FOOT-01",
      "MH-GLASS-01",
      "MH-APP-01",
    ]);

    // 4. Draft realistic products
    const placeholders = [
      {
        slug: "premium-analog-steel-chronograph-watch",
        sku: "MH-WTCH-01",
        title: "Premium Steel Chronograph Watch",
        subtitle: "Edition-01 Masterpiece",
        description: "An elegant, master-quality analog timepiece crafted with durable 316L stainless steel. Features sub-dials for seconds, minutes, and 24-hour display. Japanese quartz movement guarantees absolute precision. The mineral glass is scratch-resistant and water-resistant up to 3ATM, protecting it against everyday splashes and rain. Suitable for office wear, formal evenings, and daily coordination.",
        shortAnswer: "Steel analog chronograph watch with Japanese quartz movement, 3ATM splash resistance, 316L stainless steel bracelet, and scratch-resistant glass.",
        categorySlug: "watches",
        brand: "Vanguard",
        color: "Silver & Navy",
        material: "Stainless Steel",
        gender: "unisex",
        costPrice: 2800,
        mrp: 3640, // cost * 1.30
        price: 3220, // cost * 1.15
        resellerPrice: 3220,
        stockQty: 45,
        images: [
          "https://images.pexels.com/photos/190819/pexels-photo-190819.jpeg?auto=compress&cs=tinysrgb&w=800",
          "https://images.pexels.com/photos/277390/pexels-photo-277390.jpeg?auto=compress&cs=tinysrgb&w=800",
        ],
        heroImage: "https://images.pexels.com/photos/190819/pexels-photo-190819.jpeg?auto=compress&cs=tinysrgb&w=800",
        specs: {
          Movement: "Japanese Quartz Chronograph",
          "Case Material": "316L Stainless Steel",
          "Case Diameter": "41mm",
          "Water Resistance": "3ATM (Splash Resistant)",
          "Glass Type": "Scratch-Resistant Mineral Crystal",
          Warranty: "1-Year Manufacturer Warranty",
        },
        faqs: [
          { q: "Is the watch safe to wear in the shower?", a: "No. While it has 3ATM water resistance, which easily handles rain and hand-washing, hot steam and high pressure can compromise the rubber gaskets. We recommend taking it off before showering or swimming." },
          { q: "Does the package include a box?", a: "Yes. Every watch is shipped inside a premium padded gift box, complete with a microfiber cleaning cloth and a manual." }
        ],
      },
      {
        slug: "classic-designer-leather-shoulder-bag",
        sku: "MH-BAG-01",
        title: "Classic Designer Shoulder Bag",
        subtitle: "Premium Daily Tote",
        description: "A beautifully structured designer tote meticulously hand-crafted from genuine top-grain calf leather. Features gold-tone alloy hardware with premium zippers designed to pull smoothly for years. The spacious interior is lined with durable canvas and organized into three slip pockets and one secured zipper pocket, making it the perfect daily companion for carrying your phone, cards, cosmetics, and a 13-inch laptop.",
        shortAnswer: "Genuine top-grain calf leather shoulder bag with gold-tone alloy zippers, canvas lining, and multi-pocket interior storage.",
        categorySlug: "handbags",
        brand: "Sartorial",
        color: "Camel Brown",
        material: "Genuine Leather",
        gender: "female",
        costPrice: 3500,
        mrp: 4550,
        price: 4025,
        resellerPrice: 4025,
        stockQty: 25,
        images: [
          "https://images.pexels.com/photos/1152077/pexels-photo-1152077.jpeg?auto=compress&cs=tinysrgb&w=800",
          "https://images.pexels.com/photos/904350/pexels-photo-904350.jpeg?auto=compress&cs=tinysrgb&w=800",
        ],
        heroImage: "https://images.pexels.com/photos/1152077/pexels-photo-1152077.jpeg?auto=compress&cs=tinysrgb&w=800",
        specs: {
          Material: "Genuine Calf Leather",
          Lining: "Canvas Lining",
          Hardware: "Gold-Tone Rust-Resistant Alloy",
          Dimensions: "35cm x 28mm x 12cm",
          Capacity: "Spacious enough for a 13-inch laptop",
        },
        faqs: [
          { q: "How should I clean this genuine leather bag?", a: "Wipe it gently with a soft, slightly damp cloth. Avoid harsh chemicals or alcohol-based wipes, and apply leather conditioner once every six months to maintain its suppleness." }
        ],
      },
      {
        slug: "retro-sports-running-sneakers",
        sku: "MH-FOOT-01",
        title: "Retro Sports Running Sneakers",
        subtitle: "Ultra-Light Performance",
        description: "Engineered for maximum comfort and style. These retro-inspired sneakers combine an athletic mesh upper for ultimate breathability with premium suede overlays for durability. The dual-density EVA midsole cushions shock and returns energy with every stride, while the textured rubber outsole provides high-wear traction on any street surface. Stitched cup-sole construction prevents separation over years of daily wear.",
        shortAnswer: "Breathable retro running sneakers with athletic mesh upper, premium suede overlays, responsive EVA cushioning, and stitched cup-sole.",
        categorySlug: "footwear",
        brand: "AeroAthletic",
        color: "Off-White & Forest Green",
        material: "Mesh & Suede",
        gender: "unisex",
        costPrice: 2200,
        mrp: 2860,
        price: 2530,
        resellerPrice: 2530,
        stockQty: 60,
        images: [
          "https://images.pexels.com/photos/1598505/pexels-photo-1598505.jpeg?auto=compress&cs=tinysrgb&w=800",
          "https://images.pexels.com/photos/2529148/pexels-photo-2529148.jpeg?auto=compress&cs=tinysrgb&w=800",
        ],
        heroImage: "https://images.pexels.com/photos/1598505/pexels-photo-1598505.jpeg?auto=compress&cs=tinysrgb&w=800",
        specs: {
          Upper: "Double-Layer Athletic Mesh & Suede",
          Midsole: "Dual-Density Cushioned EVA",
          Outsole: "High-Wear Rubber Grip",
          Construction: "Stitched Cup-Sole",
          Sizes: "UK 6 to 11",
        },
        faqs: [
          { q: "Are these sneakers machine-washable?", a: "We don't recommend machine washing because of the suede overlays. Instead, clean the mesh with a soft brush and soap, and use a specialized suede block to clean the suede panels." }
        ],
      },
      {
        slug: "uv400-polarized-wayfarer-sunglasses",
        sku: "MH-GLASS-01",
        title: "UV400 Polarized Sunglasses",
        subtitle: "Classic Wayfarer Style",
        description: "The ultimate classic wayfarer frame, reimagined. Crafted from lightweight, impact-resistant premium acetate that is hand-polished for a beautiful, rich gloss finish. Outfitted with high-definition polarized tri-acetate cellulose (TAC) lenses that block 100% of UVA, UVB, and UVC up to 400nm (UV400 rating), cutting road and water glare dramatically for safe driving and outdoor leisure. Features a five-barrel metal hinge that opens and closes with smooth resistance.",
        shortAnswer: "Polarized TAC lenses with UV400 rating, high-gloss hand-polished acetate frames, and durable five-barrel metal hinges.",
        categorySlug: "sunglasses",
        brand: "Eclipse",
        color: "Piano Black",
        material: "Acetate",
        gender: "unisex",
        costPrice: 1500,
        mrp: 1950,
        price: 1725,
        resellerPrice: 1725,
        stockQty: 100,
        images: [
          "https://images.pexels.com/photos/46710/pexels-photo-46710.jpeg?auto=compress&cs=tinysrgb&w=800",
          "https://images.pexels.com/photos/701877/pexels-photo-701877.jpeg?auto=compress&cs=tinysrgb&w=800",
        ],
        heroImage: "https://images.pexels.com/photos/46710/pexels-photo-46710.jpeg?auto=compress&cs=tinysrgb&w=800",
        specs: {
          "Lens Type": "Polarized TAC (Tri-Acetate Cellulose)",
          "UV Protection": "UV400 (100% UVA & UVB Blocked)",
          "Frame Material": "Hand-Polished Premium Acetate",
          Hinge: "Durable Five-Barrel Metal Hinge",
          FrameWidth: "142mm",
        },
        faqs: [
          { q: "What does polarization do?", a: "Polarized lenses filter horizontal light waves, which eliminates glare reflecting off shiny surfaces like wet roads, car bonnets, and water. This enhances contrast and reduces eye strain significantly." }
        ],
      },
      {
        slug: "heavyweight-cotton-fleece-pullover-hoodie",
        sku: "MH-APP-01",
        title: "Heavyweight Fleece Pullover Hoodie",
        subtitle: "Signature Comfort Fit",
        description: "Crafted from incredibly dense, premium 400 GSM heavyweight knit cotton-polyester blend fleece. Features a dense loopback knit with a lightly brushed interior, producing a cloud-like softness that resists pilling. Design details include a double-layered hood that holds its structure, ribbed side-gussets for flexible motion, and a spacious front kangaroo pouch. Garment-dyed and pre-shrunk, so it retains its color and boxy relaxed fit forever.",
        shortAnswer: "Heavyweight 400 GSM loopback cotton fleece blend hoodie with double-layer hood, brushed interior, and pre-shrunk fit.",
        categorySlug: "apparel",
        brand: "Monochrome",
        color: "Heather Gray",
        material: "Cotton Fleece",
        gender: "unisex",
        costPrice: 2400,
        mrp: 3120,
        price: 2760,
        resellerPrice: 2760,
        stockQty: 50,
        images: [
          "https://images.pexels.com/photos/11832668/pexels-photo-11832668.jpeg?auto=compress&cs=tinysrgb&w=800",
        ],
        heroImage: "https://images.pexels.com/photos/11832668/pexels-photo-11832668.jpeg?auto=compress&cs=tinysrgb&w=800",
        specs: {
          Weight: "Heavyweight 400 GSM",
          Composition: "80% Organic Cotton, 20% Polyester",
          Interior: "Lightly Brushed Fleece (Anti-Pilling)",
          Hood: "Double-Layer Structuring (No Drawstring)",
          Fit: "Boxy, Slightly Relaxed Fit",
        },
        faqs: [
          { q: "Will the hoodie shrink in the dryer?", a: "No. The garment is pre-shrunk during the dyeing process. However, to keep the fleece ultra-soft, we recommend washing on cold and tumble drying on low or flat air-drying." }
        ],
      },
    ];

    for (const p of placeholders) {
      const catId = catBySlug.get(p.categorySlug);
      if (!catId) {
        console.warn(`Category slug '${p.categorySlug}' not found; skipping ${p.title}`);
        continue;
      }

      await pool.query(
        `insert into products (
          slug, sku, title, subtitle, description, short_answer,
          category_id, manufacturer_id, brand, color, material, gender,
          cost_price, mrp, price, reseller_price, margin_percent,
          stock_qty, availability, status, quality_score, confidence,
          images, hero_image, specs, faqs, views, published_at
        ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, 0, now())`,
        [
          p.slug,
          p.sku,
          p.title,
          p.subtitle,
          p.description,
          p.shortAnswer,
          catId,
          mfrId,
          p.brand,
          p.color,
          p.material,
          p.gender,
          p.costPrice,
          p.mrp,
          p.price,
          p.resellerPrice,
          15,
          p.stockQty,
          "in_stock",
          "published", // published so they show up directly!
          95, // quality score
          0.98, // confidence
          JSON.stringify(p.images),
          p.heroImage,
          JSON.stringify(p.specs),
          JSON.stringify(p.faqs),
        ]
      );
      console.log(`  ✓ Inserted placeholder product: ${p.title} (SKU: ${p.sku})`);
    }

    console.log("Seeding completed successfully!");
  } catch (err) {
    console.error("Seeding failed:", err);
  } finally {
    await pool.end();
  }
}

seed();
