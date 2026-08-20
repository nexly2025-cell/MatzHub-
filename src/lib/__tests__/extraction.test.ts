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
