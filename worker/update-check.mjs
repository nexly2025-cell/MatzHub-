/**
 * Baileys update watcher. Runs on worker start and every 24h.
 * If a newer Baileys version exists on npm, posts an ops task to the platform
 * so the operator updates manually. NEVER auto-upgrades — WhatsApp protocol
 * changes are breaking by design and need deliberate testing.
 */

const REGISTRY = "https://registry.npmjs.org/@whiskeysockets/baileys/latest";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

async function currentVersion() {
  const pkg = JSON.parse((await import("node:fs")).readFileSync(new URL("./package.json", import.meta.url), "utf8"));
  return pkg.dependencies["@whiskeysockets/baileys"].replace(/[^\d.]/g, "");
}

function isNewer(latest, current) {
  const p = (v) => v.split(".").map((n) => parseInt(n, 10) || 0);
  const L = p(latest), C = p(current);
  for (let i = 0; i < 3; i += 1) {
    if ((L[i] ?? 0) > (C[i] ?? 0)) return true;
    if ((L[i] ?? 0) < (C[i] ?? 0)) return false;
  }
  return false;
}

export async function checkForUpdates(log) {
  try {
    const res = await fetch(REGISTRY, { signal: AbortSignal.timeout(8000) });
    const json = await res.json();
    const latest = json.version;
    const current = await currentVersion();
    if (isNewer(latest, current)) {
      const api = process.env.MATZHUB_API_URL || "http://localhost:3000";
      const token = process.env.INGEST_TOKEN || "";
      await fetch(`${api.replace(/\/$/, "")}/api/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "worker_outdated",
          props: { current, latest, action: "update Baileys manually: cd worker && npm install @whiskeysockets/baileys@latest" },
        }),
      }).catch(() => undefined);
      log("baileys_update_available", { current, latest, action: "manual update required" });
    } else {
      log("baileys_current", { current });
    }
  } catch (e) {
    log("update_check_failed", { error: e.message });
  }
}

export function startUpdateWatcher(log) {
  void checkForUpdates(log);
  setInterval(() => void checkForUpdates(log), CHECK_INTERVAL_MS).unref();
}
