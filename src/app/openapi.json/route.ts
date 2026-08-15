import { NextResponse } from "next/server";
import { SITE } from "@/lib/utils";

export const revalidate = 86400;

/** OpenAPI 3.1 — lets AI agents and partners query the catalogue programmatically. */
export function GET() {
  return NextResponse.json({
    openapi: "3.1.0",
    info: {
      title: "MatzHub Catalogue API",
      version: "1.0.0",
      description: "Read-only access to MatzHub's curated imports catalogue. No authentication required. Prices in INR.",
      contact: { name: "MatzHub", url: SITE.url, email: SITE.email },
      license: { name: "Data may be cited with attribution to matzhub.com" },
    },
    servers: [{ url: SITE.url }],
    paths: {
      "/api/search": {
        get: {
          operationId: "searchProducts",
          summary: "Search the published catalogue",
          parameters: [
            { name: "q", in: "query", schema: { type: "string" }, description: "Free-text query across title, description, brand, colour and tags" },
            { name: "category", in: "query", schema: { type: "string", enum: ["watches", "handbags", "footwear", "sunglasses", "apparel"] } },
            { name: "min", in: "query", schema: { type: "integer" }, description: "Minimum price in INR" },
            { name: "max", in: "query", schema: { type: "integer" }, description: "Maximum price in INR" },
            { name: "sort", in: "query", schema: { type: "string", enum: ["trending", "new", "price_asc", "price_desc", "discount"] } },
            { name: "limit", in: "query", schema: { type: "integer", maximum: 50, default: 20 } },
          ],
          responses: { "200": { description: "Matching products", content: { "application/json": { schema: { $ref: "#/components/schemas/SearchResult" } } } } },
        },
      },
      "/products.json": {
        get: { operationId: "getFullCatalogue", summary: "Full published catalogue as schema.org ItemList", responses: { "200": { description: "ItemList of Product objects" } } },
      },
    },
    components: {
      schemas: {
        Product: {
          type: "object",
          properties: {
            sku: { type: "string" }, slug: { type: "string" }, title: { type: "string" },
            description: { type: "string" }, price: { type: "integer" }, mrp: { type: "integer" },
            savePercent: { type: "integer" }, currency: { type: "string", const: "INR" },
            availability: { type: "string", enum: ["in_stock", "low_stock", "out_of_stock"] },
            category: { type: "string" }, brand: { type: "string", nullable: true },
            image: { type: "string", format: "uri" }, url: { type: "string", format: "uri" },
          },
        },
        SearchResult: {
          type: "object",
          properties: { query: { type: "string" }, total: { type: "integer" }, items: { type: "array", items: { $ref: "#/components/schemas/Product" } } },
        },
      },
    },
  }, { headers: { "Access-Control-Allow-Origin": "*" } });
}
