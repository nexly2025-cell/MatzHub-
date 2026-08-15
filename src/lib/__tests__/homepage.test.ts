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

  it("keeps the header search overlay conditionally mounted", async () => {
    const src = await readFile("src/components/Header.tsx", "utf8");
    // Mounting only when open is what stops the panel painting over the page.
    expect(src).toContain("{searchOpen && (");
    // aria-hidden alone is not sufficient; it leaves the panel painted.
    expect(src).not.toMatch(/aria-hidden=\{!searchOpen\}/);
  });
});
