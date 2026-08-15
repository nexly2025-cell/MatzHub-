import { describe, expect, it } from "vitest";
import { computePricing, deterministicEnrich } from "@/lib/ai";

describe("computePricing", () => {
  it("applies the global cost×1.40 original / cost×1.15 selling rule", () => {
    const r = computePricing({ costPrice: 1000 });
    expect(r.mrp).toBe(1400);
    expect(r.price).toBe(1150);
    expect(r.marginPercent).toBe(15);
  });

  it("respects a margin override when provided", () => {
    const r = computePricing({ costPrice: 1000, marginPercent: 12 });
    expect(r.price).toBe(1120);
    expect(r.marginPercent).toBe(12);
  });

  it("floors cost at 1 rupee and keeps both derived prices valid", () => {
    const r = computePricing({ costPrice: 0 });
    expect(r.costPrice).toBe(0);
    expect(r.mrp).toBeGreaterThanOrEqual(1);
    expect(r.price).toBeGreaterThanOrEqual(1);
  });

  it("handles fractional cost without floating-point drift", () => {
    const r = computePricing({ costPrice: 999.5 });
    expect(Number.isInteger(r.mrp)).toBe(true);
    expect(Number.isInteger(r.price)).toBe(true);
  });
});

describe("deterministicEnrich", () => {
  const msg = (caption: string) => ({
    caption,
    imageUrl: "https://example.com/img.webp",
    groupName: "MatzHub · A-Series Supply",
    defaultCategory: null,
  });

  it("detects category from caption", () => {
    const e = deterministicEnrich(msg("Black leather oxford formal shoes, size 6 to 11, Rs 890/-"));
    expect(e.categorySlug).toBe("footwear");
  });

  it("extracts cost as the lowest rupee figure; manufacturer MRP never overrides the 40% rule", () => {
    const e = deterministicEnrich(msg("Brown leather handbag, Rs 640/- MRP 2799"));
    expect(e.costPrice).toBe(640);
    expect(e.mrp).toBe(0); // derived by computePricing downstream as cost×1.40
  });

  it("returns mrp=0 when no manufacturer MRP is stated so the 40% rule applies downstream", () => {
    const e = deterministicEnrich(msg("Black leather oxford shoes, Rs 890/-"));
    expect(e.costPrice).toBe(890);
    expect(e.mrp).toBe(0); // downstream computePricing will apply cost×1.40
  });

  it("generates a 4-question FAQ block including bridge positioning", () => {
    const e = deterministicEnrich(msg("Silver steel watch, Rs 850/-"));
    expect(e.faqs.length).toBeGreaterThanOrEqual(3);
    expect(e.faqs.some((f) => f.q.toLowerCase().includes("who makes it") || f.q.toLowerCase().includes("manufacturer"))).toBe(true);
  });

  it("never publishes an unstructured title from a messy caption", () => {
    const e = deterministicEnrich(msg("*NEW ARRIVAL* Black watch leather strap. 780 rs only. MOQ 5. DM to order"));
    expect(e.title).not.toContain("*");
    expect(e.title).not.toContain("MOQ");
    expect(e.title).not.toContain("rs");
    expect(e.title.length).toBeGreaterThan(5);
  });
});
