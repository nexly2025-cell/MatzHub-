import Link from "next/link";
import { getCategories } from "@/lib/queries";

export default async function NotFound() {
  const cats = await getCategories().catch(() => []);
  return (
    <div className="shell grid min-h-[70vh] place-items-center py-20 text-center">
      <div>
        <p className="eyebrow mb-4">404 · MatzHub</p>
        <h1 className="display mb-4 text-[clamp(2rem,6vw,3.5rem)]">This page moved on.</h1>
        <p className="mx-auto mb-8 max-w-md text-sm leading-relaxed text-muted">
          Products archive when a manufacturer stops confirming a line, so old links do expire. Everything live is a tap away.
        </p>
        <div className="flex flex-wrap justify-center gap-2">
          <Link href="/" className="btn btn-solid">
            Home
          </Link>
          <Link href="/products" className="btn btn-outline">
            All products
          </Link>
          {cats.map((c) => (
            <Link key={c.id} href={`/c/${c.slug}`} className="chip py-3">
              {c.name}
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
