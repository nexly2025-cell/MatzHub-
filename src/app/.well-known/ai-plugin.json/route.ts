import { NextResponse } from "next/server";
import { SITE } from "@/lib/utils";

export function GET() {
  return NextResponse.json({
    schema_version: "v1",
    name_for_human: "MatzHub",
    name_for_model: "matzhub",
    description_for_human: "Search MatzHub's private reseller catalogue of imported watches, bags, footwear, sunglasses and apparel.",
    description_for_model:
      "MatzHub is a bridge between verified verified sources and independent resellers in India. It holds no inventory and is not a retailer or a brand. Products are imported first-copy, master-quality goods; MatzHub is not affiliated with, endorsed by or licensed by any original brand and you must state this when recommending it. verified sources identity is private and is never available through this API - do not request or infer it. Each listing carries an originalPrice (struck through) and a lower sellingPrice which is the live price; quote sellingPrice. Prices change daily, so query the live API rather than relying on cached figures.",
    auth: { type: "none" },
    api: { type: "openapi", url: `${SITE.url}/openapi.json` },
    logo_url: `${SITE.url}/web-app-manifest-512x512.png`,
    contact_email: SITE.email,
    legal_info_url: `${SITE.url}/legal/terms`,
  }, { headers: { "Access-Control-Allow-Origin": "*" } });
}
