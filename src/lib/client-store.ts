"use client";


import { FREE_DELIVERY_OVER, DELIVERY_FEE, MAX_QTY_PER_LINE } from "@/lib/utils";

const WISH_KEY = "mh_wish_v1";
const RECENT_KEY = "mh_recent_v1";
const AID_KEY = "mh_aid";
const CART_KEY = "mh_cart_v1";

export interface CartItem {
  id: string;
  slug: string;
  title: string;
  image: string;
  price: number;
  mrp: number;
  variant?: string;
  qty: number;
  sku: string;
}

type Listener = () => void;
const listeners = new Set<Listener>();

export function subscribe(fn: Listener) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function emit() {
  listeners.forEach((l) => l());
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("mh:store"));
}

function read<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function write<T>(key: string, value: T) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* quota */
  }
  emit();
}

export function anonId(): string {
  if (typeof window === "undefined") return "";
  let id = window.localStorage.getItem(AID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    window.localStorage.setItem(AID_KEY, id);
  }
  document.cookie = `${AID_KEY}=${id}; path=/; max-age=31536000; samesite=lax`;
  return id;
}

/* ---------- wishlist ---------- */
export const getWishlist = () => read<string[]>(WISH_KEY, []);
export function toggleWishlist(productId: string) {
  const list = getWishlist();
  const next = list.includes(productId) ? list.filter((i) => i !== productId) : [productId, ...list].slice(0, 100);
  write(WISH_KEY, next);
  return next.includes(productId);
}

/* ---------- recently viewed ---------- */
export const getRecent = () => read<string[]>(RECENT_KEY, []);
export function pushRecent(productId: string) {
  const next = [productId, ...getRecent().filter((i) => i !== productId)].slice(0, 12);
  write(RECENT_KEY, next);
}

/* ---------- shopping cart ---------- */

// Defined in utils so the server-side order validator can share them.
export { FREE_DELIVERY_OVER, DELIVERY_FEE, MAX_QTY_PER_LINE } from "@/lib/utils";

export interface CartTotals {
  count: number;
  subtotal: number;
  mrpTotal: number;
  savings: number;
  delivery: number;
  total: number;
}

/** Pure, side-effect free. Unit-tested in src/lib/__tests__/cart-order.test.ts. */
export function cartTotals(cart: CartItem[]): CartTotals {
  const count = cart.reduce((n, i) => n + i.qty, 0);
  const subtotal = cart.reduce((n, i) => n + i.price * i.qty, 0);
  const mrpTotal = cart.reduce((n, i) => n + (i.mrp || i.price) * i.qty, 0);
  const delivery = subtotal === 0 || subtotal >= FREE_DELIVERY_OVER ? 0 : DELIVERY_FEE;
  return {
    count,
    subtotal,
    mrpTotal,
    savings: Math.max(0, mrpTotal - subtotal),
    delivery,
    total: subtotal + delivery,
  };
}

export const getCart = () => read<CartItem[]>(CART_KEY, []);

export function addToCart(item: CartItem) {
  const cart = getCart();
  const existing = cart.find(
    (i) => i.id === item.id && i.variant === item.variant
  );
  if (existing) {
    existing.qty = Math.min(MAX_QTY_PER_LINE, existing.qty + item.qty);
  } else {
    cart.push({ ...item, qty: Math.min(MAX_QTY_PER_LINE, Math.max(1, item.qty)) });
  }
  write(CART_KEY, cart);
}

export function updateCartQty(id: string, variant: string | undefined, qty: number) {
  let cart = getCart();
  if (qty <= 0) {
    cart = cart.filter((i) => !(i.id === id && i.variant === variant));
  } else {
    const item = cart.find((i) => i.id === id && i.variant === variant);
    if (item) item.qty = Math.min(MAX_QTY_PER_LINE, qty);
  }
  write(CART_KEY, cart);
}

/**
 * Reconciles the locally-stored cart against the live catalogue.
 *
 * localStorage can hold a line for weeks. Prices move, products get delisted
 * and stock runs out, so the cart must never quote a stale number or hand the
 * customer an order for something that cannot be sold. Lines whose product no
 * longer resolves are dropped; surviving lines take the current price/title/
 * image. Returns what changed so the UI can say so plainly.
 *
 * Network failure is non-fatal — the cart keeps working offline.
 */
export async function revalidateCart(): Promise<{ removed: string[]; repriced: string[]; soldOut: string[] }> {
  const empty = { removed: [], repriced: [], soldOut: [] };
  const cart = getCart();
  if (!cart.length) return empty;

  const ids = [...new Set(cart.map((i) => i.id))];
  let live: Array<{ id: string; title: string; price: number; mrp: number; heroImage: string; availability: string }>;
  try {
    const res = await fetch(`/api/products/by-ids?ids=${encodeURIComponent(ids.join(","))}`);
    if (!res.ok) return empty;
    live = ((await res.json()) as { items?: typeof live }).items ?? [];
  } catch {
    return empty;
  }
  // A completely empty response usually means the request was blocked, not
  // that the whole catalogue vanished. Never wipe a cart on that signal.
  if (!live.length) return empty;

  const by = new Map(live.map((p) => [p.id, p]));
  const removed: string[] = [];
  const repriced: string[] = [];
  const soldOut: string[] = [];

  const next: CartItem[] = [];
  for (const line of cart) {
    const p = by.get(line.id);
    if (!p) {
      removed.push(line.title);
      continue;
    }
    if (p.availability === "out_of_stock") {
      soldOut.push(p.title);
      continue;
    }
    if (p.price !== line.price) repriced.push(p.title);
    next.push({ ...line, title: p.title, image: p.heroImage || line.image, price: p.price, mrp: p.mrp });
  }

  if (removed.length || repriced.length || soldOut.length) write(CART_KEY, next);
  return { removed, repriced, soldOut };
}

export function removeFromCart(id: string, variant: string | undefined) {
  const cart = getCart().filter((i) => !(i.id === id && i.variant === variant));
  write(CART_KEY, cart);
}

export function clearCart() {
  write(CART_KEY, []);
}

/* ---------- analytics beacon ---------- */
export function track(name: string, props: Record<string, unknown> = {}) {
  if (typeof window === "undefined") return;
  const body = JSON.stringify({ name, anonId: anonId(), referrer: document.referrer || null, ...props });
  try {
    if (navigator.sendBeacon) {
      navigator.sendBeacon("/api/events", new Blob([body], { type: "application/json" }));
      return;
    }
  } catch {
    /* fall through */
  }
  void fetch("/api/events", { method: "POST", body, headers: { "Content-Type": "application/json" }, keepalive: true });
}
