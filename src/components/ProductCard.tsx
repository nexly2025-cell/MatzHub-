"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";
import type { ProductCard as PC } from "@/lib/queries";
import { getWishlist, subscribe, toggleWishlist } from "@/lib/client-store";
import { toPublicMediaUrl } from "@/lib/storage";
import { inr } from "@/lib/utils";

const FALLBACK = "/images/product-fallback.jpg";
const BLUR_DATA_URL =
  "data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 4 5'%3E%3Crect width='4' height='5' fill='%23ebe8e1'/%3E%3C/svg%3E";

export default function ProductCard({ p, priority = false }: { p: PC; priority?: boolean }) {
  const [saved, setSaved] = useState(false);
  // Issue 1 + 11: public URL (never a signed URL) rendered through next/image.
  const [src, setSrc] = useState(() => toPublicMediaUrl(p.heroImage) || FALLBACK);
  const off = p.mrp > p.price ? Math.round(((p.mrp - p.price) / p.mrp) * 100) : 0;

  useEffect(() => {
    setSrc(toPublicMediaUrl(p.heroImage) || FALLBACK);
  }, [p.heroImage]);

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
              src={src}
              alt={p.altText || p.title}
              fill
              sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 25vw"
              className="object-cover transition-transform duration-700 group-hover:scale-[1.04]"
              priority={priority}
              loading={priority ? "eager" : "lazy"}
              placeholder="blur"
              blurDataURL={BLUR_DATA_URL}
              onError={() => setSrc(FALLBACK)}
            />
          </div>

          {/* Both labels used to be pinned to the same corner, so a
              discounted low-stock piece rendered them on top of each other.
              They stack now, and availability wins the eye when it matters. */}
          <div className="pointer-events-none absolute left-3 top-3 flex flex-col items-start gap-1.5">
            {p.availability === "out_of_stock" ? (
              <span className="label rounded-full bg-surface/92 px-2.5 py-1 text-muted backdrop-blur-sm">
                Sold out
              </span>
            ) : (
              <>
                {off > 0 && (
                  <span className="label rounded-full bg-surface/92 px-2.5 py-1 font-medium text-accent backdrop-blur-sm">
                    -{off}%
                  </span>
                )}
                {p.availability === "low_stock" && (
                  <span className="label rounded-full bg-surface/92 px-2.5 py-1 text-ink backdrop-blur-sm">
                    Nearly gone
                  </span>
                )}
              </>
            )}
          </div>

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

        <div className="pt-3">
          {/* Reserve two lines so a long title cannot stagger the grid rows. */}
          <h3 className="flex h-[2.6em] items-start text-[13.5px] font-medium leading-[1.3] text-ink sm:text-sm">
            <span className="line-clamp-2">{p.title}</span>
          </h3>

          <div className="mt-1 flex min-h-[1.1rem] items-center gap-1.5">
            {[p.brand, p.color].filter(Boolean).length > 0 && (
              <p className="line-clamp-1 text-[11.5px] uppercase tracking-[0.06em] text-subtle">
                {[p.brand, p.color].filter(Boolean).join(" · ")}
              </p>
            )}
            {/* Real aggregate rating only. ratingCount is 0 for a product with
                no published reviews, so this never shows a fabricated score. */}
            {p.ratingCount > 0 && (
              <p className="ml-auto shrink-0 text-[11px] text-muted tabular-nums">
                <span className="text-accent">★</span> {p.ratingAvg.toFixed(1)}
                <span className="text-subtle"> ({p.ratingCount})</span>
              </p>
            )}
          </div>

          {/* Single honest price on the grid; comparison lives on the detail
              page. tabular-nums aligns a column of prices optically. */}
          <p className="mt-2 font-display text-[19px] leading-none text-ink tabular-nums">{inr(p.price)}</p>
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

/** Issue 12 — luxury skeleton used by Suspense boundaries on catalogue routes. */
export function ProductGridSkeleton({ count = 8 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-3 sm:gap-x-5 lg:grid-cols-4 lg:gap-x-6" aria-hidden>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i}>
          <div className="skeleton aspect-[4/5] rounded-xl" />
          <div className="skeleton mt-3 h-4 w-4/5 rounded" />
          <div className="skeleton mt-2 h-3 w-1/2 rounded" />
          <div className="skeleton mt-3 h-5 w-1/3 rounded" />
        </div>
      ))}
    </div>
  );
}

export function ProductRail({ items, heading, tight = false }: { items: PC[]; heading?: string; tight?: boolean }) {
  if (!items.length) return null;
  return (
    /* `tight` is for rails whose parent section already owns the vertical
       rhythm and heading - the product page does both, so a fixed py-12 stacked
       ~96px of dead air above the cards. */
    <section className={tight ? "pb-10 pt-1" : "py-12"}>
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
