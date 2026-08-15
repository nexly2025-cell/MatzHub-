"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { anonId, track } from "@/lib/client-store";

export default function Analytics() {
  const pathname = usePathname();
  useEffect(() => {
    anonId();
    if (pathname?.startsWith("/admin")) return;
    track("page_view", { path: pathname });
  }, [pathname]);
  return null;
}
