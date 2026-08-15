import { describe, expect, it } from "vitest";
import { sanitizeSupplierCaption } from "@/lib/privacy";

/**
 * Supplier captions are written for a private trade group, not for customers.
 * They routinely contain our buying price and the supplier's stock count.
 *
 * A live product page was published containing "Cost 2400 Stock 5" verbatim,
 * disclosing both the wholesale price and inventory. These assertions are the
 * boundary that prevents that recurring.
 */
describe("supplier caption sanitiser", () => {
  it("removes the exact leak that reached production", () => {
    const out = sanitizeSupplierCaption("Chronograph Steel 42mm sapphire\nCost 2400\nStock 5");
    expect(out).not.toMatch(/cost/i);
    expect(out).not.toMatch(/2400/);
    expect(out).not.toMatch(/stock/i);
    expect(out).toContain("Chronograph Steel 42mm sapphire");
  });

  it("strips every common way a supplier writes a price", () => {
    for (const line of [
      "Cost 2400", "cost:1850", "Price 999", "Rate 1200/-", "rs 450", "INR 3000",
      "₹2,400", "MRP 5999", "2400/-", "1850 rs", "net 900", "deal 700",
      "wholesale 1200", "dealer price 800", "per piece 340", "margin 15",
    ]) {
      const out = sanitizeSupplierCaption(`Leather Tote Bag\n${line}`);
      expect(out, `leaked: ${line}`).toBe("Leather Tote Bag");
    }
  });

  it("strips inventory and trade terms", () => {
    for (const line of ["Stock 12", "qty 40", "MOQ 10 pcs", "20 pairs available", "min order 5"]) {
      const out = sanitizeSupplierCaption(`Running Sneakers\n${line}`);
      expect(out, `leaked: ${line}`).toBe("Running Sneakers");
    }
  });

  it("strips supplier-group solicitation and phone numbers", () => {
    for (const line of ["DM to order", "whatsapp 9876543210", "+91 98765 43210", "Book now", "Limited stock"]) {
      const out = sanitizeSupplierCaption(`Aviator Sunglasses\n${line}`);
      expect(out, `leaked: ${line}`).toBe("Aviator Sunglasses");
    }
  });

  it("keeps genuine product description intact", () => {
    const out = sanitizeSupplierCaption(
      "Premium Chronograph Watch\nRose gold 42mm case, sapphire glass\nJapanese quartz movement, 3ATM water resistant\nCost 2400\nStock 9",
    );
    expect(out).toContain("Rose gold 42mm case, sapphire glass");
    expect(out).toContain("Japanese quartz movement, 3ATM water resistant");
    expect(out).not.toMatch(/2400|Cost|Stock/i);
  });

  it("does not mistake sizes or measurements for prices", () => {
    // "42mm", "UK 6-11" and "100ml" must survive; they describe the product.
    const out = sanitizeSupplierCaption("Derby Shoes\nGenuine leather UK 6-11\nInsole 27.5 cm");
    expect(out).toContain("UK 6-11");
    expect(out).toContain("Insole 27.5 cm");
  });

  it("returns empty rather than leaking when a caption is only commercial", () => {
    expect(sanitizeSupplierCaption("Cost 2400\nStock 5\nDM to order")).toBe("");
  });
});
