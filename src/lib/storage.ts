/**
 * Issue 1 — public media URLs.
 *
 * Signed Supabase URLs expire in ~1 hour. The storefront caches product rows
 * far longer than that, so 40–60% of catalogue images 404 for returning
 * visitors. We never persist or render a signed URL: every path is rewritten
 * to the public `/object/public/` form which does not expire.
 *
 * `getPublicUrl()` matches the supabase-js Storage API so call sites stay
 * portable if the SDK is introduced later. No extra dependency required.
 */

const SIGNED_MARKERS = [
  "/storage/v1/object/sign/",
  "/storage/v1/object/authenticated/",
] as const;

function supabaseOrigin(): string {
  const raw =
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    process.env.SUPABASE_URL ||
    "";
  return raw.replace(/\/$/, "");
}

/** Build a never-expiring public object URL for a bucket path. */
export function getPublicUrl(bucket: string, objectPath: string): string {
  const base = supabaseOrigin();
  const clean = String(objectPath || "").replace(/^\/+/, "");
  if (!base || !bucket || !clean) return "";
  return `${base}/storage/v1/object/public/${bucket}/${clean}`;
}

/**
 * Convert any stored media URL to a public, cache-safe URL.
 * Leaves non-Supabase URLs (Pexels, Cloudinary, local) untouched.
 */
export function toPublicMediaUrl(url: string | null | undefined): string {
  if (!url) return "";
  const trimmed = url.trim();
  if (!trimmed) return "";

  let next = trimmed;
  for (const marker of SIGNED_MARKERS) {
    if (next.includes(marker)) {
      next = next.replace(marker, "/storage/v1/object/public/");
    }
  }

  try {
    const parsed = new URL(next);
    parsed.searchParams.delete("token");
    parsed.searchParams.delete("X-Amz-Algorithm");
    parsed.searchParams.delete("X-Amz-Credential");
    parsed.searchParams.delete("X-Amz-Date");
    parsed.searchParams.delete("X-Amz-Expires");
    parsed.searchParams.delete("X-Amz-SignedHeaders");
    parsed.searchParams.delete("X-Amz-Signature");
    return parsed.toString();
  } catch {
    return next.split("?")[0];
  }
}

export function toPublicMediaList(urls: Array<string | null | undefined> | null | undefined): string[] {
  if (!urls?.length) return [];
  return urls.map((u) => toPublicMediaUrl(u)).filter(Boolean);
}
