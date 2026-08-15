"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getWishlist, subscribe } from "@/lib/client-store";
import { ProductGrid } from "@/components/ProductCard";
import type { ProductCard as PC } from "@/lib/queries";

export default function WishlistView() {
  const [items, setItems] = useState<PC[] | null>(null);

  useEffect(() => {
    const load = async () => {
      const ids = getWishlist();
      if (!ids.length) return setItems([]);
      const res = await fetch(`/api/products/by-ids?ids=${ids.join(",")}`);
      const data = (await res.json()) as { items: PC[] };
      setItems(data.items);
    };
    void load();
    return subscribe(() => void load()) as unknown as () => void;
  }, []);

  if (items === null) return <div className="skeleton h-64 rounded-2xl" />;
  if (!items.length)
    return (
      <div className="surface py-20 text-center">
        <p className="display text-2xl mb-2">Nothing saved yet</p>
        <p className="mb-6 text-sm text-muted">Tap the heart on any product to keep an eye on it.</p>
        <Link href="/" className="btn btn-primary">Browse the catalogue</Link>
      </div>
    );

  return <ProductGrid items={items} />;
}
