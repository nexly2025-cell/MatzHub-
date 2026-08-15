/** Cheap in-process token bucket. Per-instance; enough for API hardening on a single-node
 *  deploy or serverless concurrent instances (each instance has its own bucket).
 *  Rotate instances freely — the limit is per instance, not global. */
const buckets = new Map<string, { count: number; resetAt: number }>();

export function rateLimit(
  key: string,
  opts: { max: number; windowMs: number },
): { ok: boolean; remaining: number; resetIn: number } {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || now > b.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + opts.windowMs });
    return { ok: true, remaining: opts.max - 1, resetIn: opts.windowMs };
  }
  if (b.count >= opts.max) {
    return { ok: false, remaining: 0, resetIn: Math.max(0, b.resetAt - now) };
  }
  b.count += 1;
  return { ok: true, remaining: opts.max - b.count, resetIn: b.resetAt - now };
}

export function clientKey(request: Request): string {
  return (
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
    "unknown"
  );
}
