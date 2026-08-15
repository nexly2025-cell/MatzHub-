import { describe, expect, it } from "vitest";
import { rateLimit } from "@/lib/rate-limit";

describe("rateLimit", () => {
  it("allows requests within the window", () => {
    const key = `test:${Math.random()}`;
    for (let i = 0; i < 5; i += 1) {
      const r = rateLimit(key, { max: 5, windowMs: 60000 });
      expect(r.ok).toBe(true);
    }
  });

  it("rejects requests beyond the window", () => {
    const key = `test:${Math.random()}`;
    for (let i = 0; i < 3; i += 1) rateLimit(key, { max: 3, windowMs: 60000 });
    const r = rateLimit(key, { max: 3, windowMs: 60000 });
    expect(r.ok).toBe(false);
    expect(r.resetIn).toBeGreaterThan(0);
  });
});
