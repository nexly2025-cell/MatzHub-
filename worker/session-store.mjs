/**
 * Persists the Baileys auth session directory to Supabase Storage so a container
 * restart does NOT demand a fresh QR scan.
 * Bucket: wa-sessions (private). Path: primary/<session-file>
 */

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const BUCKET = "wa-sessions";
const PREFIX = "primary";

function enabled() {
  return Boolean(SUPABASE_URL && SUPABASE_KEY);
}

function encodeObjectPath(parts) {
  return ["storage", "v1", "object", BUCKET, ...parts.map(encodeURIComponent)].join("/");
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
    for (const file of files) {
      const relativePath = path.relative(sessionDir, file).replace(/\\/g, "/");
      const destPath = `${PREFIX}/${relativePath}`;
      const body = fs.readFileSync(file);
      const res = await fetch(`${SUPABASE_URL}/${encodeObjectPath([destPath])}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${SUPABASE_KEY}`,
          "Content-Type": contentTypeForFile(file),
          "x-upsert": "true",
        },
        body,
      });
      if (res.ok) {
        uploaded += 1;
        bytes += body.length;
      } else {
        log("session_backup_file_failed", { file: relativePath, status: res.status });
      }
    }
    if (uploaded) log("session_backed_up", { files: uploaded, bytes });
  } catch (e) {
    log("session_backup_failed", { error: e.message });
  }
}

export async function restoreCreds(log) {
  if (!enabled()) return false;
  try {
    const fs = await import("node:fs");
    const fsp = await import("node:fs/promises");
    const path = await import("node:path");
    const sessionDir = process.env.WA_SESSION_DIR || ".wa-session";
    if (fs.existsSync(sessionDir) && (await fsp.readdir(sessionDir)).length) return true;

    const listUrl = new URL(`${SUPABASE_URL}/storage/v1/object/list/${BUCKET}`);
    listUrl.searchParams.set("prefix", `${PREFIX}/`);
    const listRes = await fetch(listUrl.toString(), {
      headers: { Authorization: `Bearer ${SUPABASE_KEY}` },
    });
    if (!listRes.ok) return false;
    const list = await listRes.json();
    const items = Array.isArray(list) ? list : list?.data || [];
    if (!items.length) return false;

    await fsp.mkdir(sessionDir, { recursive: true });
    let restored = 0;
    let bytes = 0;
    for (const item of items) {
      const objectPath = item.name || item.path || item.id;
      if (!objectPath || !objectPath.startsWith(`${PREFIX}/`)) continue;
      const relativePath = objectPath.slice(PREFIX.length + 1);
      const filePath = path.join(sessionDir, relativePath);
      await fsp.mkdir(path.dirname(filePath), { recursive: true });
      const res = await fetch(`${SUPABASE_URL}/${encodeObjectPath([objectPath])}`, {
        headers: { Authorization: `Bearer ${SUPABASE_KEY}` },
      });
      if (!res.ok) continue;
      const body = Buffer.from(await res.arrayBuffer());
      await fsp.writeFile(filePath, body);
      restored += 1;
      bytes += body.length;
    }
    if (restored) {
      log("session_restored", { files: restored, bytes });
      return true;
    }
    return false;
  } catch (e) {
    log("session_restore_failed", { error: e.message });
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
    const listUrl = new URL(`${SUPABASE_URL}/storage/v1/object/list/${BUCKET}`);
    const listRes = await fetch(listUrl.toString(), {
      method: "POST",
      headers: { Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ prefix: `${PREFIX}/`, limit: 1000 }),
    });
    if (!listRes.ok) return { purged: 0, error: `list ${listRes.status}` };

    const list = await listRes.json();
    const items = Array.isArray(list) ? list : list?.data || [];
    const names = items.map((i) => `${PREFIX}/${i.name}`).filter(Boolean);
    if (!names.length) return { purged: 0 };

    const delRes = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ prefixes: names }),
    });
    if (!delRes.ok) return { purged: 0, error: `delete ${delRes.status}` };

    log?.("session_remote_purged", { files: names.length });
    return { purged: names.length };
  } catch (e) {
    return { purged: 0, error: e.message };
  }
}
