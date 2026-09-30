import { describe, expect, it } from "vitest";
import { deterministicEnrich, normalizeCategoryAlias } from "@/lib/ai";
import { contentFingerprint } from "@/lib/ingest";

const msg = (caption: string) => ({ caption, imageUrl: "https://x/i.webp", groupName: null, defaultCategory: null, category: null });

describe("category-specific extraction", () => {
  it("footwear: pulls size run, sole, type", () => {
    const e = deterministicEnrich(msg("Black leather oxford formal shoes for men, EVA sole. size 6 to 11. Rs 890/-"));
    expect(e.categorySlug).toBe("footwear");
    expect(e.specs["Size run"]).toBeDefined();
    expect(e.specs["Size run"]).toContain("6");
    expect(e.specs["Type"]).toMatch(/oxford/i);
  });

  it("watches: pulls movement, case size, strap material", () => {
    const e = deterministicEnrich(msg("Silver chronograph watch, genuine leather strap, 42mm case, quartz movement. Rs 1150"));
    expect(e.categorySlug).toBe("watches");
    expect(e.specs.Movement).toMatch(/chrono|quartz|automatic/i);
    expect(e.specs["Case size"]).toContain("42");
    expect(e.specs.Material).toMatch(/leather/i);
  });

  it("handbags: pulls type, dimensions, material", () => {
    const e = deterministicEnrich(msg("Brown leather tote bag with 3 compartments, genuine leather, 30x22x12 cm, laptop compatible. Rs 640"));
    expect(e.categorySlug).toBe("handbags");
    expect(e.specs.Type).toMatch(/tote/i);
    expect(e.specs.Dimensions).toBeDefined();
    expect(e.specs.Compartments).toContain("3");
  });

  it("perfumes: pulls volume, concentration, profile", () => {
    const e = deterministicEnrich(msg("Royal Oud EDP 100ml for men, long lasting amber musky. Rs 480"));
    expect(e.categorySlug).toBe("perfumes");
    expect(e.specs.Volume).toContain("100");
    expect(e.specs.Concentration).toMatch(/edp|perfume|parfum/i);
    expect(e.specs.Profile).toBeDefined();
  });

  it("sunglasses: pulls UV400, polarised, frame shape", () => {
    const e = deterministicEnrich(msg("Classic black aviator sunglasses, metal frame, polarised lens, UV400. Rs 265"));
    expect(e.categorySlug).toBe("sunglasses");
    expect(e.specs["Lens rating"]).toMatch(/uv.?400/i);
    expect(e.specs.Polarisation).toBeDefined();
    expect(e.specs.Shape).toMatch(/aviator/i);
  });

  it("apparel: pulls GSM, fit, material", () => {
    const e = deterministicEnrich(msg("Premium cotton t-shirt 220 GSM, slim fit, sizes S M L XL. Rs 240"));
    expect(e.categorySlug).toBe("apparel");
    expect(e.specs.GSM).toBe("220");
    expect(e.specs.Fit).toMatch(/slim/i);
  });
});

describe("caption duplicate fingerprints", () => {
  it("does not fingerprint empty image-only captions", () => {
    expect(contentFingerprint("")).toBeNull();
    expect(contentFingerprint("   \n  ")).toBeNull();
  });

  it("keeps a stable semantic fingerprint for meaningful captions", () => {
    expect(contentFingerprint("Premium watch Rs 1200")).toBe(contentFingerprint("premium watch Rs 999"));
  });
});

describe("category alias normalization", () => {
  it("maps worker slugs to canonical", () => {
    expect(normalizeCategoryAlias("bags")).toBe("handbags");
    expect(normalizeCategoryAlias("shoes")).toBe("footwear");
    expect(normalizeCategoryAlias("clothing")).toBe("apparel");
    expect(normalizeCategoryAlias("perfume")).toBe("perfumes");
    expect(normalizeCategoryAlias("watches")).toBe("watches");
  });
});

/**
 * Price parsing for real supplier phrasing.
 *
 * Indian supplier groups overwhelmingly write the figure BEFORE the word
 * "only" — "900 only", "1,250/- only". Every existing pattern expected the
 * word first ("only 640"), so these captions yielded no figure at all,
 * costPrice fell to 0, and computePricing's Math.max(1, ...) floor published
 * a live, orderable product priced at Rs 1.
 */
describe("supplier price phrasing", () => {
  it("reads a price written as '<amount> only'", async () => {
    const { enrichProduct } = await import("@/lib/ai");
    const e = await enrichProduct({
      caption: "New stock\nAviator sunglasses UV400 polarized\nMetal frame gradient lens\n900 only",
      groupName: "Smart Collections_Sunglasses",
    });
    expect(e.costPrice).toBe(900);
  });

  it("handles '1,250/- only' and still supports 'only 640'", async () => {
    const { enrichProduct } = await import("@/lib/ai");
    const a = await enrichProduct({ caption: "Leather handbag tan\n1,250/- only", groupName: "Smart Collections_Premium Bags" });
    expect(a.costPrice).toBe(1250);
    const b = await enrichProduct({ caption: "Running sneakers\nonly 640", groupName: "Smart Collections_Footwear" });
    expect(b.costPrice).toBe(640);
  });

  it("does not mistake a spec number for a price", async () => {
    const { enrichProduct } = await import("@/lib/ai");
    // UV400 is a lens rating, not Rs 400.
    const e = await enrichProduct({ caption: "Aviator sunglasses UV400 polarized", groupName: "Smart Collections_Sunglasses" });
    expect(e.costPrice).toBe(0);
  });

  it("never derives a sellable price from an unparsed caption", async () => {
    const { computePricing } = await import("@/lib/ai");
    // The Rs 1 floor is the landmine: it satisfies a naive `price > 0` gate.
    expect(computePricing({ costPrice: 0 }).price).toBe(1);
    expect(computePricing({ costPrice: 900 }).price).toBeGreaterThan(900);
  });
});

describe("title uses the descriptive line", () => {
  it("skips a filler opening line", async () => {
    const { enrichProduct } = await import("@/lib/ai");
    const e = await enrichProduct({
      caption: "New stock\nAviator sunglasses UV400 polarized\n900 only",
      groupName: "Smart Collections_Sunglasses",
    });
    expect(e.title.toLowerCase()).toContain("aviator");
    expect(e.title.toLowerCase()).not.toBe("sunglass");
  });

  it("keeps the first line when it is already descriptive", async () => {
    const { enrichProduct } = await import("@/lib/ai");
    const e = await enrichProduct({
      caption: "Leather shoulder handbag tan\n1250 only",
      groupName: "Smart Collections_Premium Bags",
    });
    expect(e.title.toLowerCase()).toContain("handbag");
  });
});

describe("non-negotiable factual grounding (text intelligence)", () => {
  it("detects ungrounded technical claims, materials, warranties, and fabricated dimensions", async () => {
    const { ungroundedClaims, groundSpecs } = await import("@/lib/ai");

    const caption = "Casio watch black dial stainless steel strap Rs 1150";
    // Supported claims in caption
    expect(ungroundedClaims(caption, "Casio watch with black dial and stainless steel strap")).toEqual([]);

    // Unsupported claims invented by AI
    const invented = ungroundedClaims(
      caption,
      "Featuring a precise Japanese quartz movement, sapphire crystal, 42mm case, waterproof 5 ATM, and 1 year warranty.",
    );
    expect(invented).toContain("japanese");
    expect(invented).toContain("quartz");
    expect(invented).toContain("sapphire crystal");
    expect(invented).toContain("waterproof");
    expect(invented).toContain("1 year");
    expect(invented.some((c) => c.includes("42mm"))).toBe(true);

    // Spec table grounding drops fabricated specs & policy overrides while keeping grounded ones
    const specs = groundSpecs(caption, {
      Strap: "Stainless steel",
      Movement: "Japanese Quartz",
      Glass: "Sapphire Crystal",
      "Case size": "44mm",
      Material: "Genuine Italian Leather",
      Warranty: "2 Years",
      Supplier: "Factory 9",
      Weight: "Unknown",
    });
    expect(specs.Strap).toBe("Stainless steel");
    expect(specs.Movement).toBeUndefined();
    expect(specs.Glass).toBeUndefined();
    expect(specs["Case size"]).toBeUndefined();
    expect(specs.Material).toBeUndefined();
    expect(specs.Warranty).toBeUndefined();
    expect(specs.Supplier).toBeUndefined();
    expect(specs.Weight).toBeUndefined();
  });

  it("allows GROQ to rewrite supported facts while stripping fabricated claims, brands, tags, FAQs, and variants", async () => {
    const { enrichProduct, clearEnrichmentCache } = await import("@/lib/ai");
    clearEnrichmentCache();

    const origGroqKey = process.env.GROQ_API_KEY;
    const origFetch = globalThis.fetch;
    process.env.GROQ_API_KEY = "test-groq-key";

    try {
      // 1) Supported rewrite survives cleanly
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    title: "Casio Black Dial Stainless Steel Watch",
                    subtitle: "Casio · Black · Watches",
                    description:
                      "This Casio timepiece pairs a clean black dial with a brushed stainless steel bracelet for structured everyday wear.",
                    shortAnswer:
                      "Casio black dial watch with a stainless steel strap, available through MatzHub.",
                    categorySlug: "watches",
                    brand: "Casio",
                    color: "Black",
                    material: "Stainless Steel",
                    gender: "men",
                    tags: ["watches", "casio", "black", "stainless steel", "waterproof", "swiss", "premium"],
                    specs: { Strap: "Stainless Steel", Movement: "Automatic Tourbillon" },
                    faqs: [
                      { q: "What strap does this Casio watch use?", a: "It comes with a stainless steel strap and black dial." },
                      { q: "Does it have a Swiss sapphire crystal?", a: "Yes, it uses a Swiss made sapphire crystal with 1 year warranty." },
                    ],
                    variants: [{ label: "42mm", axis: "size" }],
                    costPrice: 1200,
                    confidence: 0.9,
                  }),
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )) as typeof fetch;

      const supported = await enrichProduct({
        caption: "Casio watch for men black dial stainless steel strap\n1200 only",
        groupName: "Smart Collections_Watches",
      });

      expect(supported.title).toBe("Casio Black Dial Stainless Steel Watch");
      expect(supported.description).toContain("clean black dial");
      expect(supported.description).not.toContain("1200");
      expect(supported.specs.Strap).toBe("Stainless Steel");
      // Fabricated spec, tags, FAQ, and variant are rejected
      expect(supported.specs.Movement).toBeUndefined();
      expect(supported.tags).not.toContain("waterproof");
      expect(supported.tags).not.toContain("swiss");
      expect(supported.tags).not.toContain("premium");
      expect(supported.variants).toEqual([]);
      expect(supported.faqs.some((f) => /sapphire|swiss/i.test(f.a))).toBe(false);
      expect(supported.model).toMatch(/^groq:/);

      // 2) Hallucinated brand, material, and prose claims fall back to deterministic grounded facts
      clearEnrichmentCache();
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    title: "Rolex Automatic Sapphire Waterproof Watch",
                    subtitle: "Swiss Made 42mm Quartz",
                    description: "Crafted from genuine leather with a Japanese quartz movement and 5 ATM water resistance.",
                    shortAnswer: "A waterproof 42mm Rolex watch with sapphire crystal.",
                    categorySlug: "watches",
                    brand: "Rolex",
                    color: "Gold",
                    material: "Genuine Leather",
                    gender: "men",
                    costPrice: 9999,
                  }),
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )) as typeof fetch;

      const grounded = await enrichProduct({
        caption: "Black dial watch with metal strap for men\n850 only",
        groupName: "Smart Collections_Watches",
      });

      expect(grounded.brand).toBeNull();
      expect(grounded.color).toBe("Black");
      expect(grounded.material).toBe("Metal");
      expect(grounded.title.toLowerCase()).not.toContain("rolex");
      expect(grounded.title.toLowerCase()).not.toContain("automatic");
      expect(grounded.description.toLowerCase()).not.toContain("japanese");
      expect(grounded.description.toLowerCase()).not.toContain("quartz");
      expect(grounded.description.toLowerCase()).not.toContain("850");
      expect(grounded.costPrice).toBe(850);
    } finally {
      process.env.GROQ_API_KEY = origGroqKey;
      globalThis.fetch = origFetch;
    }
  });
});

describe("media processing & visual verification (image + video frame safety)", () => {
  it("preserves product colour, geometry, and pattern while trimming only outer uniform border and rejecting bad media", async () => {
    const sharp = (await import("sharp")).default;
    // @ts-expect-error -- ESM worker module imported directly in node test
    const mediaEngine = (await import("../../../worker/media-engine.mjs")).default;

    // 1. Create a realistic sharp product image (400x400) with a distinct central
    // crimson product body (R=190, G=35, B=45) and high-contrast inner pattern/logo bars,
    // surrounded by a 20px white border.
    const width = 400;
    const height = 400;
    const rawPixels = Buffer.alloc(width * height * 3, 255); // white background
    for (let y = 20; y < 380; y += 1) {
      for (let x = 20; x < 380; x += 1) {
        const idx = (y * width + x) * 3;
        if (x >= 90 && x < 310 && y >= 90 && y < 310) {
          // Product body with crisp emblem grid lines every 16px
          const isPattern = (x % 16 < 3) || (y % 16 < 3);
          rawPixels[idx] = isPattern ? 245 : 190;
          rawPixels[idx + 1] = isPattern ? 245 : 35;
          rawPixels[idx + 2] = isPattern ? 245 : 45;
        } else {
          // Neutral studio surface around product
          rawPixels[idx] = 235;
          rawPixels[idx + 1] = 235;
          rawPixels[idx + 2] = 235;
        }
      }
    }
    const validProductPng = await sharp(rawPixels, { raw: { width, height, channels: 3 } }).png().toBuffer();

    const quality = await mediaEngine.assessImageQuality(validProductPng);
    expect(quality.usable).toBe(true);
    expect(quality.sharpness).toBeGreaterThan(2.5);

    const cleanedWebp = await mediaEngine.optimiseImage(validProductPng);
    const outMeta = await sharp(cleanedWebp).metadata();
    expect(outMeta.format).toBe("webp");
    // Geometry & aspect ratio preserved (square 1:1)
    expect(Math.abs((outMeta.width ?? 0) - (outMeta.height ?? 0))).toBeLessThanOrEqual(2);

    // Verify central product colour is preserved without colour shift compared to source
    // (20px outer white border was cleanly trimmed: 400x400 -> 360x360, so (140,140) maps to (120,120))
    expect(outMeta.width).toBe(360);
    expect(outMeta.height).toBe(360);
    const origCenter = await sharp(validProductPng)
      .extract({ left: 140, top: 140, width: 120, height: 120 })
      .stats();
    const centerCrop = await sharp(cleanedWebp)
      .extract({ left: 120, top: 120, width: 120, height: 120 })
      .stats();
    expect(centerCrop.channels[0].mean).toBeGreaterThan(centerCrop.channels[1].mean + 25);
    expect(Math.abs(centerCrop.channels[0].mean - origCenter.channels[0].mean)).toBeLessThan(15);
    expect(Math.abs(centerCrop.channels[1].mean - origCenter.channels[1].mean)).toBeLessThan(15);
    expect(Math.abs(centerCrop.channels[2].mean - origCenter.channels[2].mean)).toBeLessThan(15);

    // 2. Reject blank/solid image
    const blankBuf = await sharp({
      create: { width: 400, height: 400, channels: 3, background: { r: 240, g: 240, b: 240 } },
    }).png().toBuffer();
    const blankCheck = await mediaEngine.assessImageQuality(blankBuf);
    expect(blankCheck.usable).toBe(false);
    expect(blankCheck.reason).toBe("blank_or_uniform_frame");

    // 3. Reject tiny icon (< 160px)
    const tinyBuf = await sharp(validProductPng).resize(80, 80).png().toBuffer();
    const tinyCheck = await mediaEngine.assessImageQuality(tinyBuf);
    expect(tinyCheck.usable).toBe(false);
    expect(tinyCheck.reason).toBe("resolution_too_low");

    // 4. Reject severely blurred frame
    const blurryBuf = await sharp(validProductPng).blur(25).png().toBuffer();
    const blurryCheck = await mediaEngine.assessImageQuality(blurryBuf);
    expect(blurryCheck.usable).toBe(false);
    expect(blurryCheck.reason).toBe("blurry_frame");

    // 5. Multi-image / video-frame selection: given [blurryBuf, validProductPng, duplicate validProductPng],
    // rejects blurry & duplicate frames and promotes the sharp valid frame to cover.
    const processedList = await mediaEngine.processImages([blurryBuf, validProductPng, validProductPng, blankBuf]);
    expect(processedList.length).toBe(1);

    // If ALL candidate frames are unusable, returns [] rather than publishing bad media
    const allBad = await mediaEngine.processImages([blurryBuf, blankBuf, tinyBuf]);
    expect(allBad).toEqual([]);
  });

  it("true background cleanup repaints only exterior backdrop and keeps every product pixel byte-identical", async () => {
    const sharp = (await import("sharp")).default;
    // @ts-expect-error -- ESM worker module imported directly in node test
    const mediaEngine = (await import("../../../worker/media-engine.mjs")).default;

    const W = 480;
    const H = 400;
    type Kind = "studio" | "clutter" | "white" | "greyleak";
    const scene = (kind: Kind) => {
      const d = Buffer.alloc(W * H * 3);
      const prod = new Uint8Array(W * H);
      for (let y = 0; y < H; y += 1) {
        for (let x = 0; x < W; x += 1) {
          const i = (y * W + x) * 3;
          const base = kind === "white" ? 248 : kind === "greyleak" ? 150 : 200 + Math.round((30 * y) / H);
          let r = base;
          let g = base;
          let b = base;
          if (kind === "clutter") {
            if (y > H * 0.7) { r = 120 + ((x * 7) % 40); g = 80; b = 50; } // table
            if (x < 60) { r = 200; g = 150; b = 120; } // wall/hand at frame edge
          }
          const dx = x - 240;
          const dy = y - 200;
          const sr = Math.hypot(dx - 14, dy - 16);
          if (sr < 150) { const k = Math.round(30 * (1 - sr / 150)); r -= k; g -= k; b -= k; } // soft drop shadow
          if (Math.abs(dx) < 100 && Math.abs(dy) < 90) {
            prod[y * W + x] = 1;
            r = (((x * 13) ^ (y * 7)) % 160) + 40; // textured product with logo-like pattern
            g = ((x * 5) % 120) + 30;
            b = ((y * 11) % 200) + 20;
            if (dx > 40 && dy < -40) { const v = kind === "white" ? 250 : kind === "greyleak" ? 150 : 245; r = v; g = v; b = v; } // label
          }
          d[i] = r; d[i + 1] = g; d[i + 2] = b;
        }
      }
      return { d, prod };
    };
    const toPng = (d: Buffer) => sharp(d, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();

    // 1. Studio/gradient backdrop with shadow → backdrop removed, product untouched.
    const studio = scene("studio");
    const res = await mediaEngine.cleanBackground(await toPng(studio.d));
    expect(res.applied).toBe(true);
    const { data } = await sharp(res.buffer).raw().toBuffer({ resolveWithObject: true });
    let changed = 0;
    let bgTotal = 0;
    let bgWhite = 0;
    for (let i = 0; i < W * H; i += 1) {
      const a = i * 3;
      if (studio.prod[i]) {
        if (data[a] !== studio.d[a] || data[a + 1] !== studio.d[a + 1] || data[a + 2] !== studio.d[a + 2]) changed += 1;
      } else {
        bgTotal += 1;
        if (data[a] === 255 && data[a + 1] === 255 && data[a + 2] === 255) bgWhite += 1;
      }
    }
    expect(changed).toBe(0); // geometry, colour, texture, label: byte-identical
    expect(bgWhite / bgTotal).toBeGreaterThan(0.85); // real removal, not a border crop
    const meta = await sharp(res.buffer).metadata();
    expect([meta.width, meta.height]).toEqual([W, H]); // no crop / resample in the cleanup step

    // 2. Unsafe scenes are left exactly as supplied.
    const clutter = await toPng(scene("clutter").d);
    const c = await mediaEngine.cleanBackground(clutter);
    expect(c.applied).toBe(false);
    expect(c.reason).toBe("cluttered_background");
    expect(c.buffer).toBe(clutter);
    expect((await mediaEngine.cleanBackground(await toPng(scene("white").d))).reason).toBe("light_backdrop_already_clean");
    expect((await mediaEngine.cleanBackground(await toPng(scene("greyleak").d))).reason).toBe("product_resembles_backdrop");
    expect((await mediaEngine.cleanBackground(Buffer.from("not an image"))).applied).toBe(false);

    // 3. The standard pipeline (images + video frames share optimiseImage) applies it.
    const cornerMean = async (img: Buffer) => {
      const px = await sharp(img).extract({ left: 0, top: 0, width: 8, height: 8 }).removeAlpha().raw().toBuffer();
      return px.reduce((sum: number, v: number) => sum + v, 0) / px.length;
    };
    const webp = await mediaEngine.optimiseImage(await toPng(studio.d));
    expect(await cornerMean(webp)).toBeGreaterThan(250);
    const plain = await mediaEngine.optimiseImage(await toPng(studio.d), { removeBackground: false });
    expect(await cornerMean(plain)).toBeLessThan(230);
  });

  it("uses Gemini Vision for frame selection and misleading-media rejection when configured", async () => {
    const { verifyProductMedia, clearEnrichmentCache } = await import("@/lib/ai");
    clearEnrichmentCache();

    const origGeminiKey = process.env.GEMINI_API_KEY;
    const origFetch = globalThis.fetch;
    process.env.GEMINI_API_KEY = "test-gemini-key";

    try {
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        usable: true,
                        showsIntendedProduct: true,
                        isBlurry: false,
                        isObstructed: false,
                        isMisleading: false,
                        bestFrameIndex: 1,
                        usableIndices: [1],
                        viewAngles: ["unknown", "front"],
                        detectedCategory: "watches",
                        confidence: 0.94,
                        reason: null,
                      }),
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )) as typeof fetch;

      const fakeBuffer = Buffer.alloc(2048, 42);
      const res = await verifyProductMedia({
        imageUrls: ["https://cdn.example.org/frame0.webp", "https://cdn.example.org/frame1.webp"],
        imageBuffers: [{ buffer: fakeBuffer }, { buffer: fakeBuffer }],
        caption: "Casio silver chrono watch 1200 only",
        expectedCategory: "watches",
      });

      expect(res.usable).toBe(true);
      expect(res.bestFrameIndex).toBe(1);
      expect(res.usableIndices).toEqual([1]);
      expect(res.model).toMatch(/^gemini:/);
      expect(res.cached).toBe(false);

      // Second call with identical media hits cache without another API call
      const second = await verifyProductMedia({
        imageUrls: ["https://cdn.example.org/frame0.webp", "https://cdn.example.org/frame1.webp"],
        imageBuffers: [{ buffer: fakeBuffer }, { buffer: fakeBuffer }],
        caption: "Casio silver chrono watch 1200 only",
        expectedCategory: "watches",
      });
      expect(second.cached).toBe(true);
    } finally {
      process.env.GEMINI_API_KEY = origGeminiKey;
      globalThis.fetch = origFetch;
    }
  });
});

describe("free-quota & caching efficiency", () => {
  it("caches identical captions, skips LLM on price-only messages, and backs off on HTTP 429", async () => {
    const { enrichProduct, clearEnrichmentCache, getAiQuotaStats } = await import("@/lib/ai");
    clearEnrichmentCache();

    const origGroqKey = process.env.GROQ_API_KEY;
    const origFetch = globalThis.fetch;
    process.env.GROQ_API_KEY = "test-groq-key";

    let apiCallCount = 0;
    try {
      globalThis.fetch = (async () => {
        apiCallCount += 1;
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    title: "Leather Tote Bag Brown",
                    description: "Brown leather tote bag with three compartments.",
                    shortAnswer: "Brown leather tote bag with three compartments.",
                    categorySlug: "handbags",
                    color: "Brown",
                    material: "Leather",
                    costPrice: 890,
                  }),
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }) as typeof fetch;

      // 1. Price-only / empty caption skips LLM entirely
      await enrichProduct({ caption: "890 only", groupName: "Smart Collections_Premium Bags" });
      expect(apiCallCount).toBe(0);
      expect(getAiQuotaStats().skippedShortCaption).toBeGreaterThanOrEqual(1);

      // 2. Meaningful caption calls GROQ once, then serves from cache on repeat
      const caption = "Brown leather tote bag with 3 compartments\n890 only";
      await enrichProduct({ caption, groupName: "Smart Collections_Premium Bags" });
      expect(apiCallCount).toBe(1);

      await enrichProduct({ caption: "  Brown leather tote bag with 3 compartments   890 only ", groupName: "Smart Collections_Premium Bags" });
      expect(apiCallCount).toBe(1); // Cache hit!

      // 3. HTTP 429 rate limit activates cooldown so subsequent calls don't hammer the API
      clearEnrichmentCache();
      apiCallCount = 0;
      globalThis.fetch = (async () => {
        apiCallCount += 1;
        return new Response("Too Many Requests", { status: 429, headers: { "retry-after": "30" } });
      }) as typeof fetch;

      const fallback1 = await enrichProduct({
        caption: "Silver chronograph watch leather strap 1100 only",
        groupName: "Smart Collections_Watches",
      });
      expect(apiCallCount).toBe(1);
      expect(fallback1.model).toBe("matzhub-rules-v2");
      expect(getAiQuotaStats().groqCoolingDown).toBe(true);

      // Next product during cooldown immediately uses deterministic rules without calling fetch
      await enrichProduct({
        caption: "Black wayfarer sunglasses polarised UV400 450 only",
        groupName: "Smart Collections_Sunglasses",
      });
      expect(apiCallCount).toBe(1);
    } finally {
      clearEnrichmentCache();
      process.env.GROQ_API_KEY = origGroqKey;
      globalThis.fetch = origFetch;
    }
  });
});
