import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/**
 * The homepage search hero was removed three times and returned twice, once
 * because it was rendered permanently behind `pointer-events-none` with an
 * opaque background — invisible to grep for interactivity, fully visible to a
 * user. These assertions make its return a build failure.
 */
describe("homepage never regains a search hero", () => {
  it("contains no search input or catalogue-search copy", async () => {
    const src = await readFile("src/app/page.tsx", "utf8");
    expect(src).not.toMatch(/Search the catalogue/i);
    expect(src).not.toMatch(/type="search"/);
    expect(src).not.toMatch(/<input/);
  });

  it("leads with categories, not search", async () => {
    const src = await readFile("src/app/page.tsx", "utf8");
    // The collections anchor must exist and precede any product listing.
    expect(src).toContain('id="collections"');
    expect(src.indexOf('id="collections"')).toBeLessThan(src.indexOf("Featured"));
  });

  it("has no search bar in the header either", async () => {
    const src = await readFile("src/components/Header.tsx", "utf8");
    // The storefront is browse-first: six categories, no free-text search.
    // The header previously carried a full-screen search overlay that
    // contradicted that and painted over the page on load. It is gone; these
    // assertions make its return a build failure.
    expect(src).not.toContain("searchOpen");
    expect(src).not.toMatch(/<input/);
    expect(src).not.toMatch(/type="search"/i);
    expect(src).not.toMatch(/Search the catalogue/i);
  });
});
