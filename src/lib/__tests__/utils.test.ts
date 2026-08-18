import { describe, expect, it } from "vitest";
import { inr, orderNo, savePercent } from "@/lib/utils";

describe("orderNo", () => {
  it("keeps the MH + YYMMDD + 10 hex format", () => {
    // The readable prefix remains compatible with invoices; the larger suffix
    // makes collisions impractical as order volume grows.
    expect(orderNo()).toMatch(/^MH\d{6}[0-9A-F]{10}$/);
  });

  it("does not collide across a small burst", () => {
    const seen = new Set(Array.from({ length: 500 }, () => orderNo()));
    // 5 random bytes gives more than one trillion possible suffixes per day.
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
