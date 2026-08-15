import type { Metadata } from "next";
import WishlistView from "@/components/WishlistView";

export const metadata: Metadata = { title: "Saved items", robots: { index: false, follow: false } };

export default function WishlistPage() {
  return (
    <div className="shell py-10">
      <h1 className="display text-[clamp(1.8rem,4.5vw,2.8rem)] mb-2">Saved items</h1>
      <p className="mb-8 text-sm text-muted">We track price drops on everything you save here.</p>
      <WishlistView />
    </div>
  );
}
