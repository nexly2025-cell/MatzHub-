"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { getRecent, subscribe } from "@/lib/client-store";
import { inr } from "@/lib/utils";

type Item = { id: string; slug: string; title: string; heroImage: string; price: number; altText: string };

export default function RecentlyViewed({ excludeId }: { excludeId?: string }) {
  const [items, setItems] = useState<Item[]>([]);

  useEffect(() => {
    const load = async () => {
      const ids = getRecent().filter((i) => i !== excludeId);
      if (!ids.length) return setItems([]);
      try {
        const res = await fetch(`/api/products/by-ids?ids=${ids.join(",")}`);
        if (!res.ok) return;
        const data = (await res.json()) as { items: Item[] };
        const order = new Map(ids.map((id, i) => [id, i]));
        setItems(data.items.sort((a, b) => (order.get(a.id) ?? 99) - (order.get(b.id) ?? 99)).slice(0, 8));
      } catch {
        /* silent */
      }
    };
    void load();
    return subscribe(() => void load()) as unknown as () => void;
  }, [excludeId]);

  if (items.length < 2) return null;

  return (
    <section className="shell py-12" aria-labelledby="recent-heading">
      <h2 id="recent-heading" className="font-display text-[24px] mb-6 text-ink">
        Recently viewed
      </h2>
      <div className="flex gap-3 overflow-x-auto no-scrollbar pb-2">
        {items.map((p) => (
          <Link
            key={p.id}
            href={`/p/${p.slug}`}
            className="w-[150px] shrink-0 overflow-hidden rounded-xl border border-line bg-surface sm:w-[180px] card-lift"
          >
            <div className="relative aspect-[4/5] bg-surface-3">
              <Image src={p.heroImage} alt={p.altText || p.title} fill sizes="180px" className="object-cover" />
            </div>
            <div className="p-3">
              <p className="line-clamp-2 text-[12px] leading-snug text-ink">{p.title}</p>
              <p className="mt-1.5 font-display text-[15px] text-ink">{inr(p.price)}</p>
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}
