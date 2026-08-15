import type { MetadataRoute } from "next";
import { SITE } from "@/lib/utils";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "MatzHub",
    short_name: "MatzHub",
    description:
      "The trusted bridge connecting manufacturers with resellers across India. Private catalogue, pan-India delivery, catalogue integrity guaranteed.",
    start_url: "/",
    display: "standalone",
    background_color: "#f3f1ec",
    theme_color: "#f3f1ec",
    orientation: "portrait-primary",
    categories: ["shopping", "business"],
    lang: "en-IN",
    scope: "/",
    icons: [
      { src: "/favicon-96x96.png", sizes: "96x96", type: "image/png", purpose: "any" },
      { src: "/web-app-manifest-192x192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/web-app-manifest-512x512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "Browse catalogue", url: "/sitemap", description: "All products" },
      { name: "Saved items", url: "/wishlist", description: "Your wishlist" },
    ],
  };
}
