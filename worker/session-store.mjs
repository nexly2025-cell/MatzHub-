/**
 * Persists the Baileys auth session directory to Supabase Storage so a
 * container restart or redeploy does NOT demand a fresh QR scan.
 *
 * Bucket: wa-sessions (private, service-role access only)
 * Path:   primary/<session-file>
 *
 * This is the ONLY persistent-state mechanism for the WhatsApp session.
 * Do not add a second (local disk survives inside a container, but not across
 * redeploys; Supabase Storage is the source of truth).
 */

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const BUCKET = "wa-sessions";
const PREFIX = "primary";

function enabled() {
  return Boolean(SUPABASE_URL && SUPABASE_KEY);
}

/**
 * Supabase Storage auth headers.
 *
 * `Authorization: Bearer <key>` ALONE IS NOT ENOUGH. Supabase's newer API key
 * format (`sb_secret_…`) is rejected with HTTP 400 unless the `apikey` header
 * is sent as well. Every call in this file previously omitted it, so
 * uploadCreds() silently 400'd on every file and restoreCreds() got a 400 on
 * the list and returned false.
 *
 * Net effect: the WhatsApp session was NEVER persisted to Supabase, which is
 * precisely why a fresh QR scan was demanded after every redeploy. Verified
 * against the live project: without apikey → 400, with apikey → 200.
 */
function authHeaders(extra = {}) {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    ...extra,
  };
}

function encodeObjectPath(parts) {
  return ["storage", "v1", "object", BUCKET, ...parts.map(encodeURIComponent)].join("/");
}

/**
 * Bounded-concurrency map.
 *
 * A live Baileys session is ~150 small files (pre-keys dominate). Doing them
 * one request at a time took ~4 minutes against Supabase from a cold start,
 * during which /health reports "starting" — long enough for Docker's
 * healthcheck and deploy-worker.sh to declare the worker dead and roll back.
 * Eight in flight keeps an e2-micro's CPU and socket count comfortable while
 * cutting that to a few seconds.
 */
async function mapLimit(items, limit, fn) {
  const results = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

async function walkDir(root) {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const entries = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      entries.push(fullPath);
    }
  }
  return entries;
}

function contentTypeForFile(name) {
  if (name.endsWith(".json")) return "application/json";
  if (name.endsWith(".txt")) return "text/plain";
  return "application/octet-stream";
}

export async function uploadCreds(log) {
  if (!enabled()) return;
  try {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const sessionDir = process.env.WA_SESSION_DIR || ".wa-session";
    if (!fs.existsSync(sessionDir)) return;
    const files = await walkDir(sessionDir);
    if (!files.length) return;

    let uploaded = 0;
    let bytes = 0;
    await mapLimit(files, 8, async (file) => {
      const relativePath = path.relative(sessionDir, file).replace(/\\/g, "/");
      const destPath = `${PREFIX}/${relativePath}`;
      // Baileys consumes pre-keys while we are uploading, so a file listed a
      // moment ago can be gone by the time we read it. That is normal, not an
      // error — but an uncaught ENOENT here aborted the WHOLE backup, leaving
      // the Supabase copy progressively staler until a redeploy demanded a new
      // QR. Skip the vanished file and keep going.
      let body;
      try {
        body = fs.readFileSync(file);
      } catch (err) {
        if (err?.code !== "ENOENT") log("session_backup_file_failed", { file: relativePath, error: err?.code || String(err) });
        return;
      }
      const res = await fetch(`${SUPABASE_URL}/${encodeObjectPath([destPath])}`, {
        method: "POST",
        headers: authHeaders({
          "Content-Type": contentTypeForFile(file),
          "x-upsert": "true",
        }),
        body,
      });
      if (res.ok) {
        uploaded += 1;
        bytes += body.length;
      } else {
        log("session_backup_file_failed", { file: relativePath, status: res.status });
      }
    });
    if (uploaded) log("SESSION_BACKUP", { files: uploaded, bytes });
  } catch (e) {
    log("SESSION_BACKUP_FAILED", { error: e.message });
  }
}

export async function restoreCreds(log) {
  if (!enabled()) return false;
  const fsp = await import("node:fs/promises");
  const fs = await import("node:fs");
  const path = await import("node:path");
  const sessionDir = process.env.WA_SESSION_DIR || ".wa-session";
  const stagingDir = `${sessionDir}.restoring`;

  try {
    // creds.json is the only file that proves a usable session. Testing for
    // "directory is non-empty" treated a half-finished restore — or a stray
    // whatsapp-qr.png — as a complete one, so the worker booted on a partial
    // key set, failed to decrypt, and demanded a fresh pairing.
    if (fs.existsSync(path.join(sessionDir, "creds.json"))) return true;

    // Supabase Storage list is a POST with a JSON body. A GET returns 404.
    const listRes = await fetch(`${SUPABASE_URL}/storage/v1/object/list/${BUCKET}`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ prefix: `${PREFIX}/`, limit: 1000 }),
    });
    if (!listRes.ok) {
      log("SESSION_RESTORE_FAILED", { status: listRes.status });
      return false;
    }
    const list = await listRes.json();
    const items = Array.isArray(list) ? list : list?.data || [];
    if (!items.length) return false;

    // Download into staging, then promote. A crash mid-restore leaves the real
    // session directory untouched instead of half-written.
    await fsp.rm(stagingDir, { recursive: true, force: true });
    await fsp.mkdir(stagingDir, { recursive: true });

    let bytes = 0;
    const written = await mapLimit(items, 8, async (item) => {
      // Supabase returns names relative to the prefix argument, so prepend it.
      const objectName = item.name || item.path || item.id;
      if (!objectName) return false;
      const objectPath = objectName.startsWith(`${PREFIX}/`) ? objectName : `${PREFIX}/${objectName}`;
      const relativePath = objectPath.slice(PREFIX.length + 1);
      // Reject anything that would escape the session directory.
      if (!relativePath || relativePath.includes("..")) return false;
      const filePath = path.join(stagingDir, relativePath);
      if (!path.resolve(filePath).startsWith(path.resolve(stagingDir))) return false;
      const res = await fetch(`${SUPABASE_URL}/${encodeObjectPath([objectPath])}`, {
        headers: authHeaders(),
      });
      if (!res.ok) return false;
      const body = Buffer.from(await res.arrayBuffer());
      await fsp.mkdir(path.dirname(filePath), { recursive: true });
      await fsp.writeFile(filePath, body);
      bytes += body.length;
      return true;
    });
    const restored = written.filter(Boolean).length;

    // Without creds.json the remaining key material is useless. Discard the
    // staging copy rather than promote a session that cannot authenticate.
    if (!restored || !fs.existsSync(path.join(stagingDir, "creds.json"))) {
      await fsp.rm(stagingDir, { recursive: true, force: true });
      log("SESSION_RESTORE_INCOMPLETE", { files: restored, expected: items.length });
      return false;
    }

    await fsp.mkdir(sessionDir, { recursive: true });
    for (const name of await fsp.readdir(stagingDir)) {
      await fsp.rename(path.join(stagingDir, name), path.join(sessionDir, name));
    }
    await fsp.rm(stagingDir, { recursive: true, force: true });

    log("SESSION_RESTORED", { files: restored, bytes });
    return true;
  } catch (e) {
    log("SESSION_RESTORE_FAILED", { error: e.message });
    return false;
  }
}

/**
 * Deletes the remote session backup.
 *
 * Required by /relink. Without it the local wipe is undone on the next start:
 * restoreCreds sees an empty session directory, pulls the previous account's
 * credentials back down from storage, and the "removed" WhatsApp account
 * silently reconnects. Exactly one active session is the invariant.
 */
export async function purgeRemote(log) {
  if (!enabled()) return { purged: 0, skipped: "storage not configured" };
  try {
    const listRes = await fetch(`${SUPABASE_URL}/storage/v1/object/list/${BUCKET}`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ prefix: `${PREFIX}/`, limit: 1000 }),
    });
    if (!listRes.ok) return { purged: 0, error: `list ${listRes.status}` };

    const list = await listRes.json();
    const items = Array.isArray(list) ? list : list?.data || [];
    const names = items
      .map((i) => {
        const n = i.name || i.path || i.id;
        if (!n) return null;
        return n.startsWith(`${PREFIX}/`) ? n : `${PREFIX}/${n}`;
      })
      .filter(Boolean);
    if (!names.length) return { purged: 0 };

    const delRes = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}`, {
      method: "DELETE",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ prefixes: names }),
    });
    if (!delRes.ok) return { purged: 0, error: `delete ${delRes.status}` };

    log?.("session_remote_purged", { files: names.length });
    return { purged: names.length };
  } catch (e) {
    return { purged: 0, error: e.message };
  }
}
