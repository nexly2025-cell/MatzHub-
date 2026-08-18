import { describe, expect, it } from "vitest";
import {
  approvedSupplierGroupNames,
  categoryForApprovedSupplierGroup,
  isApprovedSupplierGroup,
  selectAuthoritativeLiveGroups,
} from "@/lib/supplier-groups";

describe("verified supplier group registry", () => {
  it("contains exactly nine unique configured supplier names", () => {
    expect(approvedSupplierGroupNames).toHaveLength(9);
    expect(new Set(approvedSupplierGroupNames)).toHaveLength(9);
  });

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

  it("deduplicates repeated delivery of the same canonical JID", () => {
    const selected = selectAuthoritativeLiveGroups([
      { jid: "120000000000000001@g.us", subject: "Smart Collections_Watches" },
      { jid: "120000000000000001@g.us", subject: "Smart Collections_Watches" },
    ]);
    expect(selected.groups).toHaveLength(1);
    expect(selected.groups[0].canonicalName).toBe("Smart Collections_Watches");
    expect(selected.ambiguousNames).toEqual([]);
  });

  it("withholds same-name different-JID aliases until explicitly pinned", () => {
    const selected = selectAuthoritativeLiveGroups([
      { jid: "120000000000000001@g.us", subject: "Smart Collections_Watches" },
      { jid: "120000000000000002@g.us", subject: "Smart Collections_Watches" },
    ]);
    expect(selected.groups).toHaveLength(0);
    expect(selected.ambiguousNames).toEqual(["Smart Collections_Watches"]);
  });
});
