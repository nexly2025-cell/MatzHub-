import { NextResponse } from "next/server";
import { getProductsByIds } from "@/lib/queries";

export async function GET(request: Request) {
  const ids = (new URL(request.url).searchParams.get("ids") ?? "")
    .split(",").map((s) => s.trim()).filter((s) => /^[0-9a-f-]{36}$/i.test(s)).slice(0, 50);
  if (!ids.length) return NextResponse.json({ items: [] });
  return NextResponse.json({ items: await getProductsByIds(ids) });
}
