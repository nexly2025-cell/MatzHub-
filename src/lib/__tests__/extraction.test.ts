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
