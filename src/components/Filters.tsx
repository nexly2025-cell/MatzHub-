"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useTransition } from "react";

type Facets = {
  brands: Array<{ v: string | null; c: number }>;
  colors: Array<{ v: string | null; c: number }>;
  range: { min: number; max: number };
};

const SORTS = [
  { v: "trending", l: "Trending" },
  { v: "new", l: "Newest" },
  { v: "price_asc", l: "Price ↑" },
  { v: "price_desc", l: "Price ↓" },
  { v: "discount", l: "Most reduced" },
];

const BANDS = [
  { l: "Under ₹500", min: "", max: "500" },
  { l: "₹500–₹1,000", min: "500", max: "1000" },
  { l: "₹1,000–₹2,000", min: "1000", max: "2000" },
  { l: "₹2,000+", min: "2000", max: "" },
];

/**
 * Issue 2 — every chip writes a real query-string change via router.push.
 * Category is a first-class URL param (`?category=watches`) so the products
 * API, /products and /search all stay in sync.
 */
export default function Filters({
  basePath,
  facets,
  current,
  categories,
}: {
  basePath: string;
  facets: Facets;
  current: { sort?: string; brand?: string; color?: string; min?: string; max?: string; category?: string };
  categories?: Array<{ slug: string; name: string }>;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  const push = useCallback(
    (patch: Record<string, string | undefined>) => {
      const u = new URLSearchParams(params.toString());
      Object.entries(patch).forEach(([k, v]) => {
        if (v && v.length) u.set(k, v);
        else u.delete(k);
      });
      u.delete("page");
      const s = u.toString();
      startTransition(() => {
        router.push(`${basePath}${s ? `?${s}` : ""}`, { scroll: false });
      });
    },
    [basePath, params, router],
  );

  const active = Boolean(current.brand || current.color || current.min || current.max || current.category);

  return (
    <div className="surface p-4" aria-busy={pending}>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        {categories && categories.length > 0 && (
          <Group label="Category">
            {categories.map((c) => (
              <button
                key={c.slug}
                type="button"
                className="chip"
                data-on={current.category === c.slug}
                onClick={() => push({ category: current.category === c.slug ? undefined : c.slug })}
              >
                {c.name}
              </button>
            ))}
          </Group>
        )}

        <Group label="Sort">
          {SORTS.map((s) => (
            <button key={s.v} type="button" className="chip" data-on={current.sort === s.v} onClick={() => push({ sort: s.v })}>
              {s.l}
            </button>
          ))}
        </Group>

        <Group label="Price">
          {BANDS.map((b) => (
            <button
              key={b.l}
              type="button"
              className="chip"
              data-on={current.min === b.min && current.max === b.max && (b.min !== "" || b.max !== "")}
              onClick={() => push({ min: b.min || undefined, max: b.max || undefined })}
            >
              {b.l}
            </button>
          ))}
        </Group>

        {facets.brands.length > 0 && (
          <Group label="Brand">
            {facets.brands.slice(0, 6).map((b) => (
              <button
                key={b.v}
                type="button"
                className="chip"
                data-on={current.brand === b.v}
                onClick={() => push({ brand: current.brand === b.v ? undefined : b.v! })}
              >
                {b.v} <span className="opacity-50">{b.c}</span>
              </button>
            ))}
          </Group>
        )}

        {facets.colors.length > 0 && (
          <Group label="Colour">
            {facets.colors.slice(0, 7).map((c) => (
              <button
                key={c.v}
                type="button"
                className="chip"
                data-on={current.color === c.v}
                onClick={() => push({ color: current.color === c.v ? undefined : c.v! })}
              >
                {c.v}
              </button>
            ))}
          </Group>
        )}

        {active && (
          <button
            type="button"
            className="ml-auto text-xs text-danger underline"
            onClick={() =>
              push({ brand: undefined, color: undefined, min: undefined, max: undefined, category: undefined })
            }
          >
            Clear filters
          </button>
        )}
      </div>
    </div>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="eyebrow shrink-0 text-[10px]">{label}</span>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  );
}
