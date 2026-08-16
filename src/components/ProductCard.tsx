"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";
import type { ProductCard as PC } from "@/lib/queries";
import { getWishlist, subscribe, toggleWishlist, track } from "@/lib/client-store";
import { inr } from "@/lib/utils";

export default function ProductCard({ p, priority = false }: { p: PC; priority?: boolean }) {
  const [saved, setSaved] = useState(false);
  const off = p.mrp > p.price ? Math.round(((p.mrp - p.price) / p.mrp) * 100) : 0;

  useEffect(() => {
    const sync = () => setSaved(getWishlist().includes(p.id));
    sync();
    return subscribe(sync) as unknown as () => void;
  }, [p.id]);

  return (
    <article className="group">
      <Link href={`/p/${p.slug}`} className="block" aria-label={p.title}>
        <div className="relative overflow-hidden rounded-xl border border-line bg-surface transition-all duration-500 group-hover:border-linestrong group-hover:shadow-lift">
          <div className="relative aspect-[4/5] overflow-hidden bg-surface-3">
            <Image
              src={p.heroImage}
              alt={p.altText || p.title}
              fill
              sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 25vw"
              className="object-cover transition-transform duration-700 group-hover:scale-[1.04]"
              priority={priority}
            />
          </div>

          {/* One quiet label per card. More badges = discount bin. */}
          {off > 0 && (
            <span className="label absolute left-3 top-3 rounded-full bg-surface/92 px-2.5 py-1 text-ink backdrop-blur-sm text-accent font-medium">
              -{off}%
            </span>
          )}
          {p.availability === "low_stock" && (
            <span className="label absolute left-3 top-3 rounded-full bg-surface/92 px-2.5 py-1 text-ink backdrop-blur-sm">
              Nearly gone
            </span>
          )}

          <button
            type="button"
            aria-label={saved ? "Remove from wishlist" : "Save to wishlist"}
            aria-pressed={saved}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              toggleWishlist(p.id);
            }}
            className={`absolute right-3 top-3 grid h-8 w-8 place-items-center rounded-full border backdrop-blur-sm transition-all duration-300 ${
              saved ? "border-ink bg-inverse text-oninverse" : "border-line bg-surface/92 text-muted hover:text-ink"
            }`}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill={saved ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.6" aria-hidden>
              <path d="M20.8 5.6a5 5 0 00-7.1 0L12 7.3l-1.7-1.7a5 5 0 10-7.1 7.1L12 21.5l8.8-8.8a5 5 0 000-7.1z" />
            </svg>
          </button>

        </div>

        <div className="space-y-1.5 pt-3.5">
          <p className="label text-subtle">{p.sku}</p>
          <h3 className="line-clamp-1 text-[13.5px] font-medium text-ink sm:text-sm">{p.title}</h3>
          <p className="line-clamp-1 text-[12px] text-muted">{[p.brand, p.color].filter(Boolean).join(" · ")}</p>
          {/* Single honest price on the grid. The comparison lives on the detail page. */}
          <p className="pt-0.5 font-display text-[19px] text-ink">{inr(p.price)}</p>
        </div>
      </Link>
    </article>
  );
}

export function ProductGrid({ items, priorityCount = 4 }: { items: PC[]; priorityCount?: number }) {
  if (!items.length) {
    return (
      <div className="surface grid place-items-center py-20 text-center">
        <p className="font-display text-xl text-ink">Nothing here yet</p>
        <p className="mt-1 text-[13px] text-muted">New stock lists continuously. Check in a couple of hours.</p>
      </div>
    );
  }
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-3 sm:gap-x-5 lg:grid-cols-4 lg:gap-x-6">
      {items.map((p, i) => (
        <ProductCard key={p.id} p={p} priority={i < priorityCount} />
      ))}
    </div>
  );
}

export function ProductRail({ items, heading }: { items: PC[]; heading?: string }) {
  if (!items.length) return null;
  return (
    <section className="py-12">
      <div className="mb-6 flex items-end justify-between gap-4 px-4 sm:px-6 lg:px-10">
        {heading && <h2 className="font-display text-2xl text-ink sm:text-3xl">{heading}</h2>}
      </div>
      <div className="no-scrollbar flex gap-4 overflow-x-auto px-4 pb-2 sm:gap-5 sm:px-6 lg:px-10">
        {items.map((p, i) => (
          <div key={p.id} className="w-[180px] shrink-0 sm:w-[210px]">
            <ProductCard p={p} priority={i < 3} />
          </div>
        ))}
      </div>
    </section>
  );
}
