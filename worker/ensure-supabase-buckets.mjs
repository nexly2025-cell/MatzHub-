#!/usr/bin/env node
// Ensure required Supabase buckets exist: products, product-media, wa-sessions
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing; skipping bucket ensure');
  process.exit(0);
}
const buckets = ['products', 'product-media', 'wa-sessions'];
// `apikey` is mandatory alongside the bearer token for sb_secret_* keys.
// Without it Supabase Storage answers 400 and every bucket check "fails open".
const authHeaders = (extra = {}) => ({
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  ...extra,
});
(async () => {
  try {
    for (const b of buckets) {
      const res = await fetch(`${SUPABASE_URL}/storage/v1/bucket/${b}`, {
        headers: authHeaders(),
      });
      if (res.status === 200) {
        console.log('bucket exists', b);
        continue;
      }
      if (res.status !== 404) {
        console.error('bucket-check-failed', b, res.status, await res.text());
        continue;
      }
      const cre = await fetch(`${SUPABASE_URL}/storage/v1/bucket`, {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ name: b, public: false }),
      });
      if (cre.ok) console.log('created bucket', b);
      else console.error('failed to create', b, await cre.text());
    }
  } catch (e) {
    console.error('ensure-buckets-error', e.message);
  }
})();
