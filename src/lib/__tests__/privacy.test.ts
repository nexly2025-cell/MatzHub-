// @vitest-environment node
import { describe, expect, it } from "vitest";
import { FORBIDDEN_PUBLIC_FIELDS, publicProduct, sanitizeSpecs } from "@/lib/privacy";

describe("publicProduct", () => {
  const raw = {
    id: "p1", slug: "x-watch", sku: "MH-A-1", title: "Watch",
    subtitle: null, description: "d", shortAnswer: "a", brand: null, color: null,
    material: null, gender: "unisex", specs: {}, tags: [], faqs: [], images: [],
    heroImage: "https://img", altText: "alt",
    // Correct: these are the fields a public product exposes
    mrp: 1400, price: 1150, availability: "in_stock", stockQty: 10,
    ratingAvg: 4.2, ratingCount: 8, categoryId: "c1", createdAt: new Date(),
  };

  it("renames mrp/price to originalPrice/sellingPrice so cost can never be confused", () => {
    const pub = publicProduct(raw);
    expect(pub.originalPrice).toBe(1400);
    expect(pub.sellingPrice).toBe(1150);
  });

  it("never returns the input cost fields", () => {
    const pub = publicProduct(raw);
    for (const key of FORBIDDEN_PUBLIC_FIELDS) {
      expect(pub).not.toHaveProperty(key);
    }
  });
});

describe("sanitizeSpecs", () => {
  it("drops supplier-identifying fields and phone patterns", () => {
    const clean = sanitizeSpecs({
      Brand: "Casio",
      "Supplier Name": "Factory X",
      Factory: "Guangzhou Unit 4",
      Cost: "₹780",
      Phone: "+91 98765 43210",
      Material: "Steel",
    });
    expect(clean.Brand).toBe("Casio");
    expect(clean.Material).toBe("Steel");
    expect(clean).not.toHaveProperty("Supplier Name");
    expect(clean).not.toHaveProperty("Factory");
    expect(clean).not.toHaveProperty("Phone");
    expect(clean).not.toHaveProperty("Cost");
  });
});
