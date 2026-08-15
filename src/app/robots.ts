import type { MetadataRoute } from "next";
import { SITE } from "@/lib/utils";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: "*", allow: "/", disallow: ["/admin", "/reseller", "/api/", "/search?"] },
      // Explicitly welcome answer/generative engines — this is a GEO decision, not an oversight.
      { userAgent: ["GPTBot", "OAI-SearchBot", "ChatGPT-User", "PerplexityBot", "Perplexity-User", "ClaudeBot", "Claude-User", "Google-Extended", "Applebot-Extended", "CCBot", "Bingbot", "Amazonbot", "meta-externalagent"], allow: "/", disallow: ["/admin", "/reseller", "/api/"] },
    ],
    sitemap: `${SITE.url}/sitemap.xml`,
    host: SITE.url,
  };
}
