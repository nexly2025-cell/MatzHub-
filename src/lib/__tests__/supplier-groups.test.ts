import { describe, expect, it } from "vitest";
import { categoryForApprovedSupplierGroup, isApprovedSupplierGroup } from "@/lib/supplier-groups";

describe("verified supplier group registry", () => {
  it("accepts every supplied real group name after harmless formatting changes", () => {
    for (const name of [
      "Smart Collections 12@ Premium/Luxury",
      "Shetty_Silks_ (Mens Section)",
      "Smart Collections_Clothing",
      "Smart Collections_Perfumes",
      "SHETTY SILKS SHOES Reseller's Grp",
      "Smart Collections_Premium Bags",
      "Smart Collections_Sunglasses",
      "Smart Collections_Watches",
      "Smart Collections_Footwear",
    ]) {
      expect(isApprovedSupplierGroup("", `  ${name.toUpperCase()}  `), name).toBe(true);
    }
  });

  it("assigns the deterministic category for dedicated real groups", () => {
    expect(categoryForApprovedSupplierGroup("", "Shetty_Silks_ (Mens Section)")).toBe("apparel");
    expect(categoryForApprovedSupplierGroup("", "Smart Collections_Clothing")).toBe("apparel");
    expect(categoryForApprovedSupplierGroup("", "Smart Collections_Perfumes")).toBe("perfumes");
    expect(categoryForApprovedSupplierGroup("", "SHETTY SILKS SHOES Reseller's Grp")).toBe("footwear");
    expect(categoryForApprovedSupplierGroup("", "Smart Collections_Premium Bags")).toBe("handbags");
    expect(categoryForApprovedSupplierGroup("", "Smart Collections_Sunglasses")).toBe("sunglasses");
    expect(categoryForApprovedSupplierGroup("", "Smart Collections_Watches")).toBe("watches");
    expect(categoryForApprovedSupplierGroup("", "Smart Collections_Footwear")).toBe("footwear");
  });

  it("lets the premium/luxury group classify from its real product caption", () => {
    expect(categoryForApprovedSupplierGroup("", "Smart Collections 12@ Premium/Luxury")).toBeNull();
  });

  it("rejects an unapproved group", () => {
    expect(isApprovedSupplierGroup("120000000000000000@g.us", "Unrelated Wholesale Group")).toBe(false);
  });
});
