import { describe, expect, it } from "vitest";
import { inr, orderNo, savePercent } from "@/lib/utils";

describe("orderNo", () => {
  it("keeps the MH + YYMMDD + 4 hex format", () => {
    // Locked because order numbers are printed on invoices and used as a
    // customer-facing lookup key in /track. Changing the shape breaks both.
    expect(orderNo()).toMatch(/^MH\d{6}[0-9A-F]{4}$/);
  });

  it("does not collide across a small burst", () => {
    const seen = new Set(Array.from({ length: 500 }, () => orderNo()));
    // 2 random bytes = 65 536 space; 500 draws should stay overwhelmingly unique.
    expect(seen.size).toBeGreaterThan(490);
  });
});

describe("pricing helpers", () => {
  it("formats INR without decimals", () => {
    expect(inr(1234)).toBe("₹1,234");
  });

  it("computes save percent and clamps invalid input", () => {
    expect(savePercent(1000, 800)).toBe(20);
    expect(savePercent(0, 800)).toBe(0);
    expect(savePercent(1000, 1200)).toBe(0);
  });
});
