"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { getWishlist, subscribe, anonId, getCart } from "@/lib/client-store";

const NAV = [
  { href: "/", label: "Home" },
  { href: "/c/watches", label: "Watches" },
  { href: "/c/handbags", label: "Handbags" },
  { href: "/c/footwear", label: "Footwear" },
  { href: "/c/sunglasses", label: "Eyewear" },
  { href: "/c/apparel", label: "Apparel" },
  { href: "/c/perfumes", label: "Perfumes" },
  { href: "/about", label: "About" },
];

function Icon({ d, size = 19 }: { d: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  );
}

const ICONS = {
  menu: "M3 6h18M3 12h18M3 18h18",
  search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zm9.5 15.5-4-4",
  heart: "M20.8 5.6a5 5 0 00-7.1 0L12 7.3l-1.7-1.7a5 5 0 10-7.1 7.1L12 21.5l8.8-8.8a5 5 0 000-7.1z",
  x: "M6 6l12 12M18 6L6 18",
  track: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zm0-5v-4m0-4h.01",
  cart: "M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4H6z M3 6h18 M16 10a4 4 0 01-8 0",
};

type Suggestion = { slug: string; title: string; price: number; image: string };

export default function Header() {
  const pathname = usePathname();
  const router = useRouter();
  const [scrolled, setScrolled] = useState(false);
  const [menu, setMenu] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [q, setQ] = useState("");
  const [wish, setWish] = useState(0);
  const [cartCount, setCartCount] = useState(0);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const sync = () => {
      anonId();
      setWish(getWishlist().length);
      const cart = getCart();
      const count = cart.reduce((acc, item) => acc + item.qty, 0);
      setCartCount(count);
    };
    sync();
    const unsub = subscribe(sync);
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      unsub();
      window.removeEventListener("scroll", onScroll);
    };
  }, []);

  useEffect(() => {
    const t = setTimeout(() => {
      setMenu(false);
      setSearchOpen(false);
    }, 0);
    return () => clearTimeout(t);
  }, [pathname]);

  useEffect(() => {
    document.body.style.overflow = menu || searchOpen ? "hidden" : "";
    if (searchOpen) setTimeout(() => inputRef.current?.focus(), 90);
    return () => {
      document.body.style.overflow = "";
    };
  }, [menu, searchOpen]);

  const onSearchChange = (value: string) => {
    setQ(value);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (value.trim().length < 2) {
      setSuggestions([]);
      return;
    }
    searchTimer.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(value.trim())}&limit=5`);
        if (!res.ok) return;
        const data = (await res.json()) as { items?: Array<{ slug: string; title: string; price: number; image: string }> };
        setSuggestions((data.items ?? []).slice(0, 5));
      } catch {
        setSuggestions([]);
      }
    }, 220);
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!q.trim()) return;
    setSearchOpen(false);
    router.push(`/search?q=${encodeURIComponent(q.trim())}`);
  };

  if (pathname?.startsWith("/admin")) return null;

  return (
    <>


      <header
        className={`sticky top-0 z-50 transition-all duration-300 ${
          scrolled ? "border-b border-line bg-canvas/90 backdrop-blur-md" : "border-b border-transparent bg-canvas"
        }`}
      >
        <div className="mx-auto flex h-16 max-w-[1400px] items-center gap-3 px-4 sm:px-5 lg:px-10">
          <button aria-label="Open menu" aria-expanded={menu} onClick={() => setMenu(true)} className="-ml-2 grid h-10 w-10 place-items-center rounded-full text-ink lg:hidden">
            <Icon d={ICONS.menu} size={20} />
          </button>

          <Link href="/" aria-label="MatzHub home" className="flex items-center gap-2.5 shrink-0">
            <Image
              src="/web-app-manifest-512x512.png"
              alt="MatzHub"
              width={36}
              height={36}
              // Above the fold and tiny: decode it immediately rather than
              // lazily, so it never competes with the hero for LCP.
              priority
              sizes="36px"
              className="rounded"
            />
            <span className="font-display text-[19px] tracking-tight text-ink hidden sm:block">Matz<span className="text-accent">Hub</span></span>
          </Link>

          <nav className="hidden lg:flex items-center gap-1 mx-auto" aria-label="Collections">
            {NAV.map((n) => (
              <Link
                key={n.href}
                href={n.href}
                className={`px-3 py-2 text-[12.5px] tracking-wide transition-colors ${
                  pathname === n.href || (n.href !== "/" && pathname?.startsWith(n.href))
                    ? "text-ink border-b border-ink"
                    : "text-muted hover:text-ink"
                }`}
              >
                {n.label}
              </Link>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-1">
            <button aria-label="Search" onClick={() => setSearchOpen(true)} className="grid h-10 w-10 place-items-center rounded-full text-ink hover:bg-surface-2">
              <Icon d={ICONS.search} />
            </button>
            <Link href="/wishlist" aria-label={`Wishlist, ${wish} items`} className="relative grid h-10 w-10 place-items-center rounded-full text-ink hover:bg-surface-2">
              <Icon d={ICONS.heart} />
              {wish > 0 && <Badge n={wish} />}
            </Link>
            <Link href="/cart" aria-label={`Cart, ${cartCount} items`} className="relative grid h-10 w-10 place-items-center rounded-full text-ink hover:bg-surface-2">
              <Icon d={ICONS.cart} />
              {cartCount > 0 && <Badge n={cartCount} />}
            </Link>
            <ThemePicker />
          </div>
        </div>
      </header>

      {/* Mobile slide-over menu */}
      <div className={`fixed inset-0 z-50 lg:hidden ${menu ? "" : "pointer-events-none"}`} aria-hidden={!menu} inert={!menu}>
        <div className={`absolute inset-0 transition-opacity duration-300 ${menu ? "bg-scrim opacity-100" : "opacity-0"}`} style={{ background: "var(--c-scrim)" }} onClick={() => setMenu(false)} />
        <aside className={`absolute left-0 top-0 h-full w-[290px] bg-surface transition-transform duration-300 ${menu ? "translate-x-0" : "-translate-x-full"}`} role="dialog" aria-label="Menu">
          <div className="flex items-center justify-between border-b border-line p-4">
            <Link href="/" className="flex items-center gap-2" onClick={() => setMenu(false)}>
              <Image src="/web-app-manifest-512x512.png" alt="MatzHub" width={28} height={28} sizes="28px" className="rounded" />
              <span className="font-display text-lg text-ink">MatzHub</span>
            </Link>
            <button aria-label="Close menu" onClick={() => setMenu(false)} className="grid h-9 w-9 place-items-center rounded-full text-muted">
              <Icon d={ICONS.x} size={17} />
            </button>
          </div>
          <nav className="p-3" aria-label="Mobile collections">
            {NAV.map((n) => (
              <Link key={n.href} href={n.href} onClick={() => setMenu(false)} className="block rounded-lg px-4 py-3.5 text-[15px] text-ink hover:bg-surface-2">
                {n.label}
              </Link>
            ))}
            <div className="my-2 border-t border-line" />
            <Link href="/faq" onClick={() => setMenu(false)} className="block rounded-lg px-4 py-3.5 text-[15px] text-muted hover:bg-surface-2">
              Help & FAQ
            </Link>
          </nav>
        </aside>
      </div>

      {/* Full-screen search.
          Mounted only while open. It previously rendered permanently with an
          opaque bg-surface panel and only `pointer-events-none`, so a white
          "Search the catalogue" sheet sat over the top of every page on load.
          Conditional mounting also keeps the phrase out of the SSR HTML, where
          it competed with real page content for crawlers. */}
      {searchOpen && (
      <div className="fixed inset-0 z-50">
        <div className="absolute inset-0 transition-opacity duration-300 opacity-100" style={{ background: "var(--c-scrim)" }} onClick={() => setSearchOpen(false)} />
        <div className="relative bg-surface">
          <form onSubmit={submit} role="search" className="mx-auto max-w-3xl px-4 py-14 sm:px-6">
            <label htmlFor="mh-search" className="eyebrow mb-3 block">Search the catalogue</label>
            <input
              id="mh-search"
              ref={inputRef}
              value={q}
              onChange={(e) => onSearchChange(e.target.value)}
              type="search"
              placeholder="Watches, oud, handbags, sneakers…"
              className="w-full border-b border-linestrong bg-transparent pb-4 font-display text-[28px] outline-none placeholder:text-subtle sm:text-[38px]"
              autoComplete="off"
            />
            {suggestions.length > 0 && (
              <ul className="divide-y divide-line">
                {suggestions.map((s) => (
                  <li key={s.slug}>
                    <Link href={`/p/${s.slug}`} onClick={() => setSearchOpen(false)} className="flex items-center gap-3 py-3 hover:bg-surface-2">
                      <div className="relative h-12 w-10 shrink-0 overflow-hidden rounded bg-surface-3">
                        <Image src={s.image} alt="" fill sizes="40px" className="object-cover" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13px] text-ink">{s.title}</p>
                        <p className="text-[11px] text-muted">₹{s.price.toLocaleString("en-IN")}</p>
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </form>
        </div>
      </div>
      )}
    </>
  );
}

function Badge({ n }: { n: number }) {
  return (
    <span className="absolute -right-0.5 -top-0.5 grid h-4 min-w-[16px] place-items-center rounded-full bg-ink px-1 text-[9px] font-bold text-oninverse">
      {n > 99 ? "99+" : n}
    </span>
  );
}

/* ----------------------------- Theme picker ----------------------------- */

const THEMES: Array<{ id: string; name: string; swatch: [string, string, string] }> = [
  { id: "porcelain", name: "Porcelain", swatch: ["#F3F1EC", "#1F5F5B", "#15201E"] },
  { id: "clay", name: "Clay", swatch: ["#F8F4EF", "#A8552F", "#2A211B"] },
  { id: "atelier", name: "Atelier", swatch: ["#F2F3F5", "#27417E", "#14161C"] },
  { id: "maison", name: "Maison", swatch: ["#F4F1EE", "#6F1F2E", "#24191A"] },
  { id: "botanic", name: "Botanic", swatch: ["#F2F4F0", "#3E6428", "#1C2218"] },
  { id: "espresso", name: "Espresso", swatch: ["#161110", "#B98A4B", "#EFE9DF"] },
];

/**
 * Theme toggle — two themes only, Porcelain (light) and Espresso (dark).
 *
 * A plain toggle rather than a labelled menu: the swatch is the affordance and
 * the result is immediately visible, so a dropdown with names and descriptions
 * added a click and explanatory copy for no information gain.
 */
const THEME_LIGHT = "porcelain";
const THEME_DARK = "espresso";
const THEME_BG: Record<string, string> = { [THEME_LIGHT]: "#F3F1EC", [THEME_DARK]: "#161110" };

function ThemePicker() {
  const [theme, setTheme] = useState(THEME_LIGHT);

  useEffect(() => {
    const saved = typeof window !== "undefined" ? localStorage.getItem("mh_theme") : null;
    const initial = saved === THEME_DARK ? THEME_DARK : THEME_LIGHT;
    setTimeout(() => {
      setTheme(initial);
      document.documentElement.setAttribute("data-theme", initial);
    }, 0);
  }, []);

  const toggle = () => {
    const next = theme === THEME_LIGHT ? THEME_DARK : THEME_LIGHT;
    setTheme(next);
    localStorage.setItem("mh_theme", next);
    document.documentElement.setAttribute("data-theme", next);
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_BG[next]);
  };

  const dark = theme === THEME_DARK;
  return (
    <button
      onClick={toggle}
      aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
      className="grid h-11 w-11 place-items-center rounded-full text-ink transition-colors hover:bg-surface-2"
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden>
        {dark ? (
          <>
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
          </>
        ) : (
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
        )}
      </svg>
    </button>
  );
}
