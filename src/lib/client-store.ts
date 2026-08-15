"use client";


const WISH_KEY = "mh_wish_v1";
const RECENT_KEY = "mh_recent_v1";
const AID_KEY = "mh_aid";

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
