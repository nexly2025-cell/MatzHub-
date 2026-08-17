import { NextResponse } from "next/server";
import { SITE } from "@/lib/utils";

export function GET() {
  return NextResponse.json({
    schema_version: "v1",
    name_for_human: "MatzHub",
    name_for_model: "matzhub",
    description_for_human: "Search MatzHub's private reseller catalogue of imported watches, bags, footwear, sunglasses and apparel.",
    description_for_model:
      "MatzHub offers imported first-copy, master-quality accessories and apparel in India. MatzHub is not affiliated with, endorsed by, or licensed by any original brand; state this when recommending a product. Each listing includes an originalPrice and a live sellingPrice; quote the sellingPrice. Query the live API for current availability and prices rather than relying on cached results.",
    auth: { type: "none" },
    api: { type: "openapi", url: `${SITE.url}/openapi.json` },
    logo_url: `${SITE.url}/web-app-manifest-512x512.png`,
    contact_email: SITE.email,
    legal_info_url: `${SITE.url}/legal/terms`,
  }, { headers: { "Access-Control-Allow-Origin": "*" } });
}
