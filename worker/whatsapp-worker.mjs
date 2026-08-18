#!/usr/bin/env node
/**
 * MatzHub WhatsApp Ingestion Worker
 * =================================
 * Listens to your manufacturer WhatsApp groups and POSTs every new product
 * message to the MatzHub ingestion API. Also exposes /send so the platform can
 * push order confirmations back out over the same session.
 *
 * Why Baileys and not Puppeteer:
 *   - Speaks the WhatsApp multi-device protocol directly. No Chromium, no DOM
 *     selectors, no 400MB browser, no breakage when WhatsApp ships a UI change.
 *   - Session persists to disk. A restart reconnects silently instead of
 *     demanding a fresh QR scan.
 *   - Roughly 80MB RAM instead of ~700MB.
 *
 * Run:  node whatsapp-worker.mjs
 * Scan the QR once. After that it is unattended.
 */

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import NodeCache from "@cacheable/node-cache";
import QRCode from "qrcode";
import mediaEngine from "./media-engine.mjs";
import * as sessionStore from "./session-store.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function saveQr(qr) {
  const qrPng = path.join(CONFIG.sessionDir, "whatsapp-qr.png");
  const buffer = await QRCode.toBuffer(qr, { type: "png", width: 400 });
  await fs.promises.mkdir(path.dirname(qrPng), { recursive: true });
  await fs.promises.writeFile(qrPng, buffer);
  log("qr_png_saved", { path: qrPng });
}

const CONFIG = {
  apiUrl: (process.env.MATZHUB_API_URL || "http://localhost:3000").replace(/\/$/, ""),
  ingestToken: process.env.INGEST_TOKEN || "",
  sessionDir: process.env.WA_SESSION_DIR || path.join(__dirname, ".wa-session"),
  port: Number(process.env.WA_WORKER_PORT || 8081),
  workerToken: process.env.WA_WORKER_TOKEN || "",
  cronSecret: process.env.CRON_SECRET || "",
  // Optional group-name filters. Exact JIDs below are the production boundary.
  groups: (process.env.WA_GROUPS || "").split(",").map((g) => g.trim()).filter(Boolean),
  groupIds: (process.env.WA_GROUP_IDS || "").split(",").map((group) => group.trim()).filter(Boolean),
  maxImageBytes: 5 * 1024 * 1024,
  // Force history sync even on an already-synced session. Normally unnecessary:
  // the flag below auto-enables it whenever the session has never received a
  // history payload. Set WA_BACKFILL=0 to opt out entirely.
  backfill: process.env.WA_BACKFILL !== "0",
};

/* mapping is loaded after `log` is defined */

const log = (event, data = {}) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...data }));

// Baileys uses this cache to bound retry receipts for missing sender keys.
// It is intentionally process-local: actual sender-key material remains in the
// persistent multi-file auth state and is backed up by session-store.mjs.
const msgRetryCounterCache = new NodeCache({ stdTTL: 60 * 60 * 1000, useClones: false, maxKeys: 5_000 });
const recentMessages = new Map();
const groupMetadataCache = new Map();
const canonicalJidBindings = new Map();
const decryptFailures = new Map();
const RECENT_MESSAGE_LIMIT = 1_000;

function messageCacheKey(key) {
  return `${key?.remoteJid || ""}:${key?.id || ""}`;
}

function rememberMessage(message) {
  const key = messageCacheKey(message?.key);
  if (!key || key === ":") return;
  recentMessages.set(key, message?.message);
  if (recentMessages.size > RECENT_MESSAGE_LIMIT) recentMessages.delete(recentMessages.keys().next().value);
}

function rememberGroupMetadata(metadata) {
  if (metadata?.id) groupMetadataCache.set(metadata.id, metadata);
}

// Supplier source policy. JIDs are strongest when available; verified group
// names are the safe bootstrap boundary before a live worker reports each JID.
const GROUP_MAP_PATH = path.join(__dirname, "group-mapping.json");
let GROUP_MAP = {};
let GROUP_NAME_MAP = {};

function normaliseGroupName(value) {
  return String(value || "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

try {
  if (fs.existsSync(GROUP_MAP_PATH)) {
    const parsed = JSON.parse(fs.readFileSync(GROUP_MAP_PATH, "utf8"));
    GROUP_MAP = parsed.jids || parsed;
    GROUP_NAME_MAP = Object.fromEntries(
      (Array.isArray(parsed.names) ? parsed.names : [])
        .filter((entry) => entry && entry.name)
        .map((entry) => [normaliseGroupName(entry.name), entry.category || null]),
    );
    log("group_map_loaded", { jids: Object.keys(GROUP_MAP).length, names: Object.keys(GROUP_NAME_MAP).length });
  }
} catch (e) {
  log("group_map_error", { error: e.message });
  GROUP_MAP = {};
  GROUP_NAME_MAP = {};
}

/**
 * Closed allowlist of supplier groups, taken from group-mapping.json.
 *
 * The paired account can see 19 groups: nine live supplier channels, nine
 * near-empty duplicates that share their names, and one unrelated group.
 * Filtering here means a repost in a duplicate never reaches /api/ingest.
 * The API re-checks independently, so this is bandwidth saving, not the
 * security boundary.
 *
 * Newly discovered groups are NEVER auto-added — editing the JSON is the
 * only way in.
 */
const AUTHORITATIVE_JIDS = new Set(Object.keys(GROUP_MAP));
const isAuthoritativeGroup = (jid) => AUTHORITATIVE_JIDS.has(jid);

function getMappedCategory(jid, groupName) {
  if (!jid) return null;
  if (GROUP_MAP[jid]) return GROUP_MAP[jid];
  const key = normaliseGroupName(groupName);
  if (Object.prototype.hasOwnProperty.call(GROUP_NAME_MAP, key)) return GROUP_NAME_MAP[key];
  // Category words still provide a useful fallback for a verified group with a
  // descriptive subject, while exact name/JID matching remains the boundary.
  if (groupName) {
    const name = groupName.toLowerCase();
    for (const category of Object.values(GROUP_MAP)) {
      if (category && name.includes(String(category).toLowerCase())) return category;
    }
  }
  return null;
}

/**
 * Supplier isolation boundary. WhatsApp group JIDs are the authoritative
 * identifier; a phone-number suffix cannot identify a group. Explicit env JIDs
 * win, then the checked-in mapping acts as a safe default. A worker with no
 * allow-list refuses all group ingestion in production rather than publishing
 * from every group the linked account happens to join.
 */
function isAllowedGroup(jid, groupName = "") {
  if (CONFIG.groupIds.length) return CONFIG.groupIds.includes(jid);
  if (Object.prototype.hasOwnProperty.call(GROUP_NAME_MAP, normaliseGroupName(groupName))) return true;
  // Optional development-only narrowing for temporary operational testing.
  if (CONFIG.groups.length) return CONFIG.groups.some((group) => groupName.toLowerCase().includes(group.toLowerCase()));
  return process.env.NODE_ENV !== "production";
}

function watchedGroupCount() {
  if (CONFIG.groupIds.length) return CONFIG.groupIds.length;
  return Object.keys(GROUP_NAME_MAP).length;
}

/* ------------------------------------------------------------------ */
/* Media: convert to WebP and host it somewhere public                 */
/* ------------------------------------------------------------------ */

let sharp = null;
try {
  sharp = (await import("sharp")).default;
} catch {
  log("sharp_missing", { note: "images pass through unoptimised; run npm i sharp" });
}

async function optimise(buffer) {
  if (!sharp) return { buffer, contentType: "image/jpeg", ext: "jpg" };
  let quality = 82;
  let out = null;
  while (quality >= 40) {
    out = await sharp(buffer).rotate().resize({ width: 1200, withoutEnlargement: true }).webp({ quality, effort: 4 }).toBuffer();
    if (out.length <= 200 * 1024) break;
    quality -= 8;
  }
  return { buffer: out ?? buffer, contentType: "image/webp", ext: "webp" };
}

/**
 * Upload the processed image and return a public URL.
 * Supabase Storage by default; swap for S3/R2/Cloudinary by editing this one function.
 */
async function hostImage(buffer, contentType, ext) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const bucket = process.env.SUPABASE_BUCKET || "products";

  if (supabaseUrl && supabaseKey) {
    const name = `products/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const res = await fetch(`${supabaseUrl}/storage/v1/object/${bucket}/${name}`, {
      method: "POST",
      // `apikey` is required in addition to the bearer token for sb_secret_*
      // keys; without it Storage returns 400 and NO product image ever uploads.
      headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}`, "Content-Type": contentType, "x-upsert": "true" },
      body: buffer,
    });
    if (!res.ok) throw new Error(`storage upload failed ${res.status} ${await res.text()}`);
    return `${supabaseUrl}/storage/v1/object/public/${bucket}/${name}`;
  }

  throw new Error("No image host configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
}

/* ------------------------------------------------------------------ */
/* Ingestion API                                                       */
/* ------------------------------------------------------------------ */

async function hostVideo(buffer) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const bucket = process.env.SUPABASE_VIDEO_BUCKET || "product-media";
  if (supabaseUrl && supabaseKey) {
    const name = `videos/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp4`;
    const res = await fetch(`${supabaseUrl}/storage/v1/object/${bucket}/${name}`, {
      method: "POST",
      headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}`, "Content-Type": "video/mp4", "x-upsert": "true" },
      body: buffer,
    });
    if (!res.ok) throw new Error(`video upload failed ${res.status}: ${await res.text()}`);
    return `${supabaseUrl}/storage/v1/object/public/${bucket}/${name}`;
  }
  throw new Error("No video host configured. Set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY and create the product-media bucket.");
}

// Album buffering: suppliers send 2-4 photos back-to-back. Collect per
// (group+sender) for a short window, then treat them as ONE product.
const albumBuffer = new Map();
const albumTimers = new Map();
const albumRows = new Map();
const ALBUM_WINDOW_MS = 7000;

async function flushAlbum(key) {
  const entry = albumRows.get(key);
  albumRows.delete(key);
  albumTimers.delete(key);
  if (!entry) return;
  try {
    const webps = await mediaEngine.processImages(entry.buffers);
    const urls = [];
    for (const w of webps) urls.push(await hostImage(w, "image/webp", "webp"));
    const payload = {
      messageId: entry.messageId,
      groupId: entry.jid,
      groupName: entry.groupName,
      caption: entry.caption,
      imageUrl: urls[0] ?? null,
      imageUrls: urls,
      source: "whatsapp",
    };
    const mappedCategory = getMappedCategory(entry.jid, entry.groupName);
    if (mappedCategory) payload.category = mappedCategory;
    log("INGEST_STARTED", { messageId: entry.messageId, jid: entry.jid, media: "album", images: urls.length });
    const result = await pushToMatzHub(payload);
    processed += 1;
    lastMessageAt = new Date().toISOString();
    logIngestionResult(result, { messageId: entry.messageId, jid: entry.jid, media: "album" });
  } catch (e) {
    failures += 1;
    log("INGEST_FAILED", { key, reason: e.message });
  }
}

function logIngestionResult(result, context) {
  const first = result?.results?.[0] ?? {};
  const stage = String(first.stage ?? "unknown");
  log("INGEST_SUCCESS", { ...context, stage, productId: first.productId, slug: first.slug });
  if (stage === "published") {
    log("PRODUCT_CREATED", { ...context, productId: first.productId, slug: first.slug });
    log("PUBLICATION", { ...context, productId: first.productId, slug: first.slug });
  } else if (stage === "updated") {
    log("PRODUCT_UPDATED", { ...context, productId: first.productId, slug: first.slug });
  } else if (stage === "deduped") {
    log("PRODUCT_DEDUPED", { ...context, productId: first.productId, slug: first.slug });
  }
}

async function pushToMatzHub(message) {
  const res = await fetch(`${CONFIG.apiUrl}/api/ingest`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(CONFIG.ingestToken ? { Authorization: `Bearer ${CONFIG.ingestToken}` } : {}),
    },
    body: JSON.stringify(message),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`ingest ${res.status}: ${JSON.stringify(body)}`);
  return body;
}

/* ------------------------------------------------------------------ */
/* WhatsApp connection                                                 */
/* ------------------------------------------------------------------ */

let sock = null;
let connectionState = "starting";
let processed = 0;
let failures = 0;
let lastMessageAt = null;
// Raw QR payload for the current pairing attempt. Held in memory only, cleared
// the moment the session opens so a stale code can never be re-served.
let lastQr = null;
let lastQrAt = null;
// Newest message key seen per group. fetchMessageHistory needs a real anchor;
// without one WhatsApp has no cursor to page backwards from.
/**
 * Newest message key seen per group, persisted to disk.
 *
 * fetchMessageHistory needs a real message key to page backwards from. Holding
 * these only in memory meant every worker restart wiped them, so /backfill
 * reported "groups: 0" until fresh traffic happened to arrive — the operator
 * could never deliberately pull history after a deploy. Anchors live beside the
 * session so they survive restarts, and the file is tiny (one line per group).
 */
const newestKeyByJid = new Map();
const ANCHOR_FILE = () => path.join(CONFIG.sessionDir, "history-anchors.json");

function loadAnchors() {
  try {
    const raw = fs.readFileSync(ANCHOR_FILE(), "utf8");
    for (const [jid, v] of Object.entries(JSON.parse(raw))) newestKeyByJid.set(jid, v);
    log("anchors_loaded", { groups: newestKeyByJid.size });
  } catch {
    /* first run, or the file was pruned with the session */
  }
}

let anchorSaveTimer = null;
function saveAnchorsSoon() {
  // Debounced: a history batch can touch hundreds of messages at once.
  if (anchorSaveTimer) return;
  anchorSaveTimer = setTimeout(() => {
    anchorSaveTimer = null;
    try {
      fs.mkdirSync(CONFIG.sessionDir, { recursive: true });
  if (!newestKeyByJid.size) loadAnchors();
      fs.writeFileSync(ANCHOR_FILE(), JSON.stringify(Object.fromEntries(newestKeyByJid)));
    } catch (e) {
      log("anchors_save_failed", { error: e.message });
    }
  }, 3000);
}
// Bound to the live socket inside start(); null until the first connect.
let requestHistory = null;

// Reconnect control.
//
// Every socket we create registers its own connection.update handler. Without
// a guard, a socket that closes schedules start(), the new socket replaces the
// old one on WhatsApp's side, the orphaned socket then fires its own close
// (code 440 connectionReplaced) and schedules yet another start(). That storm
// multiplies sockets until the account is rate-limited. Observed live: 5x 440
// in under 30 seconds.
//
// `starting` serialises entry. `generation` invalidates handlers belonging to
// superseded sockets so only the newest socket may drive reconnects.
let starting = false;
let generation = 0;
let reconnectAttempts = 0;
let reconnectTimer = null;

/**
 * start() sets `starting` and clears it once the socket is wired. If it throws
 * in between, the latch would stay set and block every future reconnect —
 * a silent permanent outage. This wrapper guarantees the latch is released.
 */
async function safeStart(context) {
  try {
    await start();
  } catch (e) {
    starting = false;
    log("start_failed", { context, error: e?.message ?? String(e) });
  }
}

/**
 * Attempts before we accept that self-healing has failed and tell a human.
 * With the backoff below this is roughly four minutes of silent retrying,
 * which covers ordinary network blips without paging anyone.
 */
const ESCALATE_AFTER_ATTEMPTS = 6;
let escalated = false;

/** One-way notice to the operator when automatic recovery is not working. */
async function escalate(reason) {
  if (escalated) return; // never repeat; reset happens on a successful connect
  escalated = true;
  const token = process.env.TELEGRAM_ADMIN_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_ADMIN_CHAT_ID;
  if (!token || !chatId) {
    log("escalate_unconfigured", { reason });
    return;
  }
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        parse_mode: "Markdown",
        text:
          `*WhatsApp worker cannot reconnect.*\nReason: \`${reason}\`\n` +
          `${reconnectAttempts} automatic attempts failed.\n\n` +
          "Retrying continues in the background. If it stays down, open the control panel and use *WhatsApp → Restart worker*, then *Show QR* if it asks to pair.",
      }),
    });
    log("escalated", { reason, attempts: reconnectAttempts });
  } catch (e) {
    log("escalate_failed", { error: e.message });
  }
}

function scheduleReconnect(reason) {
  if (reconnectTimer) return; // one pending reconnect at a time
  // 4s, 8s, 16s, 32s, capped at 60s. Prevents hammering after an outage.
  const delay = Math.min(4000 * 2 ** reconnectAttempts, 60_000);
  reconnectAttempts += 1;
  if (reconnectAttempts >= ESCALATE_AFTER_ATTEMPTS) void escalate(reason);
  log("reconnect_scheduled", { reason, delayMs: delay, attempt: reconnectAttempts });
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void safeStart("reconnect");
  }, delay);
}

async function start() {
  if (starting) {
    log("start_skipped", { reason: "another start is already in flight" });
    return;
  }
  starting = true;

  // Retire the previous socket so it stops emitting into our handlers.
  const previous = sock;
  sock = null;
  if (previous) {
    try { previous.ev.removeAllListeners(); } catch { /* older baileys */ }
    try { previous.end(undefined); } catch { /* already closed */ }
  }

  const myGeneration = ++generation;

  const baileys = await import("@whiskeysockets/baileys").catch(() => null);
  if (!baileys) {
    log("baileys_missing", { fix: "cd worker && npm install" });
    connectionState = "dependency_missing";
    starting = false;
    return;
  }

  const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    downloadMediaMessage,
    fetchLatestBaileysVersion,
    proto,
  } = baileys;
  const ciphertextStubType = proto.WebMessageInfo.StubType.CIPHERTEXT;

  fs.mkdirSync(CONFIG.sessionDir, { recursive: true });
  if (!newestKeyByJid.size) loadAnchors();
  // Attempt to restore saved Baileys creds from remote storage before starting.
  try {
    await sessionStore.restoreCreds(log);
  } catch (e) {
    log("session_restore_uncaught", { error: String(e) });
  }
  const { state, saveCreds } = await useMultiFileAuthState(CONFIG.sessionDir);
  const { version } = await fetchLatestBaileysVersion();

  const usePairingCode = Boolean(process.env.WA_PAIRING_NUMBER);

  /**
   * History sync must be requested at link time.
   *
   * WhatsApp pushes the INITIAL_BOOTSTRAP history payload exactly once, when a
   * companion device is linked. Baileys gates on `syncFullHistory`: when it is
   * false it logs "History sync is disabled by config", transitions straight to
   * Online and DISCARDS that payload (lib/Socket/chats.js:869-877). The server
   * never re-sends it, so the catalogue can never be backfilled afterwards —
   * the session has to be re-paired.
   *
   * This session hit exactly that: it was linked while the flag was hardcoded
   * false, leaving creds.processedHistoryMessages empty forever.
   *
   * Enabling it unconditionally is safe. On a session that already has history
   * the server simply sends nothing, so the cost is zero.
   */
  const neverSynced = !Array.isArray(state.creds?.processedHistoryMessages) ||
    state.creds.processedHistoryMessages.length === 0;
  const wantHistory = CONFIG.backfill || neverSynced;
  log("history_sync", { enabled: wantHistory, neverSynced, reason: neverSynced ? "session has no history record" : "operator requested" });

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    syncFullHistory: wantHistory,
    markOnlineOnConnect: false,
    // Required for bounded retry receipts and sender-key redistribution. The
    // cache never contains fabricated payloads: unknown messages resolve to
    // undefined and Baileys follows its own retry protocol.
    msgRetryCounterCache,
    getMessage: async (key) => recentMessages.get(messageCacheKey(key)),
    cachedGroupMetadata: async (jid) => groupMetadataCache.get(jid),
    browser: ["MatzHub Worker", "Chrome", "1.0.0"],
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("groups.upsert", (groups) => {
    for (const group of groups ?? []) {
      rememberGroupMetadata(group);
      if (isAllowedGroup(group.id, group.subject)) {
        log("GROUP_DISCOVERED", { jid: group.id, name: group.subject ?? "" });
      } else {
        log("GROUP_REJECTED", { jid: group.id, reason: "not_authoritative" });
      }
    }
  });
  sock.ev.on("groups.update", (updates) => {
    for (const update of updates ?? []) if (update.id) groupMetadataCache.delete(update.id);
  });
  sock.ev.on("group-participants.update", (update) => {
    if (update?.id) groupMetadataCache.delete(update.id);
  });

  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    // A superseded socket must never drive state or schedule reconnects.
    if (myGeneration !== generation) return;

    if (qr) {
      connectionState = "awaiting_qr";
      lastQr = qr;
      lastQrAt = Date.now();
      await saveQr(qr);
      log("qr_ready", { note: "Scan the protected PNG delivered through the Telegram QR flow with WhatsApp > Linked Devices." });
    }
    if (connection === "open") {
      connectionState = "connected";
      reconnectAttempts = 0; // healthy again — reset backoff
      escalated = false;     // and re-arm escalation for any future outage
      log("WHATSAPP_CONNECTED", { watchedGroups: watchedGroupCount() });
      // Session is now paired — the QR is stale and would only mislead the
      // next operator. Drop it from memory and disk. Best-effort; never fatal.
      lastQr = null;
      lastQrAt = null;
      const qrPng = path.join(CONFIG.sessionDir, "whatsapp-qr.png");
      fs.promises.unlink(qrPng).catch(() => undefined);
      sessionStore.uploadCreds(log).catch(() => undefined);
    }
    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      const replaced = code === DisconnectReason.connectionReplaced; // 440
      connectionState = loggedOut ? "logged_out" : replaced ? "replaced" : "reconnecting";
      log("WHATSAPP_DISCONNECTED", { code, loggedOut, replaced });

      if (loggedOut) {
        log("session_invalid", { fix: `delete ${CONFIG.sessionDir} and rescan the QR` });
        return;
      }
      if (replaced) {
        // Another client took this session over. Reconnecting would start a
        // tug-of-war that gets the number rate-limited. Stand down and let an
        // operator decide via /relink.
        log("standing_down", { reason: "connection replaced by another client" });
        return;
      }
      scheduleReconnect(`close:${code ?? "unknown"}`);
    }
  });

  // Single ingestion path, shared by live delivery and history backfill, so
  // the dedupe, media and category rules can never drift between the two.
  async function ingestMessages(messages) {
    for (const m of messages) {
      try {
        const jid = m?.key?.remoteJid || "";
        const messageId = m?.key?.id || "unknown";
        if (!jid.endsWith("@g.us") || m?.key?.fromMe) continue; // supplier groups only

        log("MESSAGE_RECEIVED", { messageId, jid });
        const cacheKey = messageCacheKey(m.key);
        const isCiphertextStub = m?.messageStubType === ciphertextStubType;
        if (!m?.message || isCiphertextStub) {
          // A ciphertext stub is emitted after Baileys attempted decryption;
          // Baileys itself sends the bounded retry receipt for this condition.
          // Never anchor or ingest it until a real decrypted payload arrives.
          decryptFailures.set(cacheKey, Date.now());
          if (decryptFailures.size > RECENT_MESSAGE_LIMIT) decryptFailures.delete(decryptFailures.keys().next().value);
          log("MESSAGE_DECRYPT_FAILED", { messageId, jid, reason: isCiphertextStub ? "ciphertext_stub" : "no_decrypted_payload" });
          if (isCiphertextStub) log("RETRY_REQUESTED", { messageId, jid, by: "baileys" });
          continue;
        }

        // A message that arrived but could not be decrypted has no content to
        // read. Baileys has already sent a retry receipt asking the sender to
        // redistribute the sender key; the message returns on its own once it
        // does. Log it accurately and move on — never count it as processed,
        // and never let it stop the loop.
        if (!m.message) {
          log("message_decrypt_failed", { jid, messageId: m.key.id, note: "retry receipt sent; awaiting sender key" });
          continue;
        }

        if (!isAuthoritativeGroup(jid)) {
          log("group_rejected", { jid, reason: "not an authoritative supplier group" });
          continue;
        }
        log("message_received", { jid, messageId: m.key.id });

        // Resolve the human-readable group name for supplier mapping.
        let groupName = "";
        try {
          const metadata = await sock.groupMetadata(jid);
          rememberGroupMetadata(metadata);
          groupName = metadata.subject || "";
        } catch {
          groupName = "";
        }
        if (!isAllowedGroup(jid, groupName)) {
          log("GROUP_REJECTED", { messageId, jid, reason: "not_authoritative" });
          continue;
        }
        const canonicalName = normaliseGroupName(groupName);
        const boundJid = canonicalJidBindings.get(canonicalName);
        if (boundJid && boundJid !== jid) {
          log("GROUP_REJECTED", { messageId, jid, reason: "canonical_name_bound_to_other_jid" });
          continue;
        }
        canonicalJidBindings.set(canonicalName, jid);

        const ts = Number(m.messageTimestamp || 0) || Math.floor(Date.now() / 1000);
        const previousAnchor = newestKeyByJid.get(jid);
        if (!previousAnchor || ts >= previousAnchor.ts) {
          newestKeyByJid.set(jid, { key: m.key, ts });
          saveAnchorsSoon();
        }
        rememberMessage(m);
        if (decryptFailures.delete(cacheKey)) {
          log("MESSAGE_RETRY_DECRYPTED", { messageId, jid, group: groupName });
        } else {
          log("MESSAGE_DECRYPTED", { messageId, jid, group: groupName });
        }

        const imageMsg = m.message?.imageMessage || null;
        const videoMsg = m.message?.videoMessage || null;
        const caption =
          imageMsg?.caption ||
          videoMsg?.caption ||
          m.message?.conversation ||
          m.message?.extendedTextMessage?.text ||
          "";

        if (!imageMsg && !videoMsg && !caption.trim()) continue;

        if (imageMsg) {
          // PHOTO WORKFLOW: buffer albums briefly, process once.
          const raw = await downloadMediaMessage(m, "buffer", {});
          if (raw && raw.length <= CONFIG.maxImageBytes) {
            const key = `${jid}:${String(m.key.participant ?? m.key.remoteJid)}`;
            const prev = albumRows.get(key) ?? { buffers: [], jid, groupName, caption: "", messageId: m.key.id };
            prev.buffers.push(raw);
            if (caption.trim()) prev.caption = caption.trim();
            albumRows.set(key, prev);
            clearTimeout(albumTimers.get(key));
            albumTimers.set(key, setTimeout(() => flushAlbum(key), ALBUM_WINDOW_MS));
          }
          continue; // the timer handles publishing
        }

        let media = { imageUrl: null, imageUrls: undefined, mediaType: "image", videoUrl: null };
        if (videoMsg) {
          // VIDEO WORKFLOW (footwear + watches): keep the mp4, generate frames.
          const raw = await downloadMediaMessage(m, "buffer", {});
          if (raw && raw.length <= 40 * 1024 * 1024) {
            const { videoBuffer, frames } = await mediaEngine.processVideo(raw);
            const videoUrl = await hostVideo(videoBuffer);
            const frameUrls = [];
            for (const f of frames) frameUrls.push(await hostImage(f, "image/webp", "webp"));
            media = { imageUrl: frameUrls[0] ?? null, imageUrls: frameUrls, mediaType: "video", videoUrl };
          }
        }

        const mappedCategory = getMappedCategory(jid, groupName);
        const payload = {
          messageId: m.key.id,
          groupId: jid,
          groupName,
          caption,
          imageUrl: media.imageUrl,
          imageUrls: media.imageUrls,
          mediaType: media.mediaType,
          videoUrl: media.videoUrl,
          source: "whatsapp",
        };
        if (mappedCategory) payload.category = mappedCategory;

        log("INGEST_STARTED", { messageId, jid, media: videoMsg ? "video" : "text" });
        const result = await pushToMatzHub(payload);

        processed += 1;
        lastMessageAt = new Date().toISOString();
        logIngestionResult(result, { messageId, jid, media: videoMsg ? "video" : "text" });
      } catch (error) {
        failures += 1;
        log("INGEST_FAILED", { messageId: m.key?.id, reason: error.message });
      }
    }
  }

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    // "notify" is a live post. "append" is an older post delivered during a
    // history sync. Both are real supplier content, so both are ingested.
    if (type !== "notify" && type !== "append") return;
    await ingestMessages(messages);
  });

  // When Baileys obtains sender-key material after a retry receipt it may emit
  // the recovered payload as an update instead of a fresh upsert. Only retry
  // messages we previously marked as undecrypted; never replay arbitrary edits.
  sock.ev.on("messages.update", async (updates) => {
    for (const entry of updates ?? []) {
      const cacheKey = messageCacheKey(entry?.key);
      const recovered = entry?.update?.message;
      if (!recovered || !decryptFailures.has(cacheKey)) continue;
      await ingestMessages([{ key: entry.key, message: recovered, messageTimestamp: entry?.update?.messageTimestamp }]);
    }
  });

  // WhatsApp pushes recent history after a connect made with syncFullHistory,
  // and again in response to requestHistory() below. Both arrive here.
  sock.ev.on("messaging-history.set", async ({ messages }) => {
    if (!Array.isArray(messages) || !messages.length) return;
    log("history_received", { count: messages.length });
    await ingestMessages(messages);
  });

  /**
   * On-demand backfill.
   *
   * WhatsApp only pushes history automatically at pair time, so a worker that
   * reconnects to an existing session never sees older posts. fetchMessageHistory
   * asks the server for them explicitly, anchored on the newest message we have
   * seen in each group. Results arrive asynchronously via messaging-history.set.
   */
  requestHistory = async (perGroup = 50) => {
    if (connectionState !== "connected") return { ok: false, error: `worker is ${connectionState}` };
    let requested = 0;
    const groups = await sock.groupFetchAllParticipating().catch(() => ({}));
    for (const [jid, meta] of Object.entries(groups || {})) {
      if (meta) rememberGroupMetadata({ ...meta, id: jid });
      const subject = meta?.subject || "";
      if (!isAllowedGroup(jid, subject)) continue;
      const anchor = newestKeyByJid.get(jid);
      if (!anchor) continue; // nothing seen yet in this group; nothing to anchor on
      try {
        await sock.fetchMessageHistory(perGroup, anchor.key, anchor.ts);
        requested += 1;
      } catch (e) {
        log("history_request_failed", { jid, error: e.message });
      }
    }
    log("history_requested", { groups: requested, perGroup });
    return { ok: true, groups: requested };
  };

  // Socket is fully wired; allow the next reconnect to proceed.
  starting = false;
}

/* ------------------------------------------------------------------ */
/* Outbound HTTP: /send and /health                                    */
/* ------------------------------------------------------------------ */

/**
 * Fails closed.
 *
 * This previously returned true whenever WA_WORKER_TOKEN was unset, so a
 * deployment that forgot the variable exposed /qr, /relink, /restart and /send
 * to anyone who could reach the port. Missing configuration must deny, not
 * allow. NODE_ENV=development keeps the open behaviour for local work.
 */
function authorised(req) {
  if (!CONFIG.workerToken) {
    if (process.env.NODE_ENV === "development") return true;
    log("auth_misconfigured", { fix: "set WA_WORKER_TOKEN — refusing all guarded requests" });
    return false;
  }
  return req.headers.authorization === `Bearer ${CONFIG.workerToken}`;
}

http
  .createServer(async (req, res) => {
    const json = (code, body) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };

    if (req.url === "/health") {
      return json(connectionState === "connected" ? 200 : 503, {
        status: connectionState,
        processed,
        failures,
        lastMessageAt,
        // Count only. The subject list is supplier-identifying and this
        // endpoint is deliberately unauthenticated for uptime probes.
        watching: watchedGroupCount(),
      });
    }

    // QR on demand. Never mints a code on its own: if the stored session is
    // valid the worker is already connected and this reports that instead.
    // A QR only exists here because Baileys emitted one (no/expired session).
    if (req.url === "/qr" && req.method === "GET") {
      if (!authorised(req)) return json(401, { error: "unauthorized" });
      if (connectionState === "connected") {
        return json(200, { ok: true, status: "connected", note: "Session is valid. No QR needed." });
      }
      if (!lastQr) {
        return json(409, { ok: false, status: connectionState, note: "No pairing code active. Use /relink to force one." });
      }
      const png = await QRCode.toBuffer(lastQr, { type: "png", width: 512 });
      return json(200, {
        ok: true,
        status: connectionState,
        ageSeconds: lastQrAt ? Math.round((Date.now() - lastQrAt) / 1000) : null,
        pngBase64: png.toString("base64"),
      });
    }

    // Force a fresh pairing code by discarding the stored session. Destructive,
    // so it is always token-guarded even when workerToken is unset elsewhere.
    if (req.url === "/relink" && req.method === "POST") {
      if (!CONFIG.workerToken || !authorised(req)) return json(401, { error: "unauthorized" });
      try {
        try { await sock?.logout(); } catch { /* already gone */ }
        await fs.promises.rm(CONFIG.sessionDir, { recursive: true, force: true });
        // The remote backup must go too. Otherwise restoreCreds pulls the old
        // account back on the next start and the removal silently reverts.
        const purge = await sessionStore.purgeRemote(log);
        lastQr = null;
        lastQrAt = null;
        newestKeyByJid.clear();
        await fs.promises.unlink(ANCHOR_FILE()).catch(() => undefined);
        connectionState = "relinking";
        log("relink_requested", { by: "admin" });
        setTimeout(() => void safeStart("relink"), 500);
        return json(200, {
          ok: true,
          status: "relinking",
          remotePurged: purge.purged ?? 0,
          note: "Local and remote session cleared. Poll /qr in a few seconds.",
        });
      } catch (e) {
        return json(500, { ok: false, error: e.message });
      }
    }

    // First-run catalogue import. Enables history sync and reconnects; the
    // existing credentials are reused, so this never asks for a new QR.
    // Recycle the socket without touching credentials. This is the safe repair
    // for a wedged connection; /relink is the destructive one.
    if (req.url === "/restart" && req.method === "POST") {
      if (!CONFIG.workerToken || !authorised(req)) return json(401, { error: "unauthorized" });
      log("restart_requested", { by: "admin" });
      connectionState = "restarting";
      setTimeout(() => void safeStart("admin-restart"), 250);
      return json(202, { ok: true, note: "Reconnecting with the saved session. No QR required." });
    }

    /**
     * Temp-file housekeeping.
     *
     * Deletes only stale QR images and partial upload artifacts. Baileys
     * credential files — creds.json, app-state-sync-*, pre-key-*, session-* —
     * are never touched: pre-keys are consumed by the protocol and removing
     * them silently breaks message decryption.
     */
    if (req.url === "/cleanup" && req.method === "POST") {
      if (!authorised(req)) return json(401, { error: "unauthorized" });
      let removed = 0;
      try {
        const entries = await fs.promises.readdir(CONFIG.sessionDir).catch(() => []);
        for (const name of entries) {
          const disposable =
            name === "whatsapp-qr.png" || name.endsWith(".tmp") || name.endsWith(".part");
          if (!disposable) continue;
          // A QR still being scanned must survive; only clear it once stale.
          if (name === "whatsapp-qr.png" && connectionState === "awaiting_qr") continue;
          await fs.promises.unlink(path.join(CONFIG.sessionDir, name)).catch(() => undefined);
          removed += 1;
        }
      } catch (e) {
        return json(500, { ok: false, error: e.message });
      }
      log("cleanup", { removed });
      return json(200, { ok: true, removed });
    }

    if (req.url === "/backfill" && req.method === "POST") {
      if (!authorised(req)) return json(401, { error: "unauthorized" });
      if (!requestHistory) return json(503, { ok: false, error: "worker not connected yet" });
      const r = await requestHistory(50);
      if (!r.ok) return json(503, r);
      return json(202, {
        ...r,
        note: "History requested. Messages arrive asynchronously; poll /health for the processed count.",
      });
    }

    if (req.url === "/groups" && req.method === "GET") {
      // Supplier group names, JIDs and member counts are internal routing
      // data. Every other mutating endpoint was guarded; this read was not.
      if (!authorised(req)) return json(401, { error: "unauthorized" });
      if (connectionState !== "connected") return json(503, { error: `whatsapp ${connectionState}` });
      try {
        const groups = await sock.groupFetchAllParticipating?.();
        if (Array.isArray(groups)) {
          for (const group of groups) rememberGroupMetadata(group);
        } else {
          for (const [jid, group] of Object.entries(groups || {})) rememberGroupMetadata({ ...group, id: jid });
        }
        const list = Array.isArray(groups)
          ? groups.map((g) => ({ jid: g.id, subject: g.subject, owner: g.owner, size: g.participants ? Object.keys(g.participants).length : null }))
          : Object.entries(groups || {}).map(([jid, g]) => ({ jid, subject: g.subject, owner: g.owner, size: g.participants ? Object.keys(g.participants).length : null }));
        const authoritative = list.filter((group) => isAllowedGroup(group.jid, group.subject));
        return json(200, { ok: true, groups: authoritative });
      } catch (e) {
        return json(500, { ok: false, error: e.message });
      }
    }

    if (req.url === "/send" && req.method === "POST") {
      if (!authorised(req)) return json(401, { error: "unauthorized" });
      if (connectionState !== "connected") return json(503, { error: `whatsapp ${connectionState}` });

      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        try {
          const { to, text } = JSON.parse(body);
          const jid = String(to).includes("@") ? to : `${String(to).replace(/\D/g, "")}@s.whatsapp.net`;
          const sent = await sock.sendMessage(jid, { text });
          rememberMessage(sent);
          json(200, { ok: true });
        } catch (e) {
          json(500, { ok: false, error: e.message });
        }
      });
      return;
    }

    json(404, { error: "not found" });
  })
  .listen(CONFIG.port, () => log("http_listening", { port: CONFIG.port }));

process.on("unhandledRejection", (e) => log("unhandled_rejection", { error: String(e) }));
process.on("uncaughtException", (e) => log("uncaught_exception", { error: e.message }));

function startCronScheduler() {
  if (!CONFIG.cronSecret) {
    log("cron_scheduler_skipped", { reason: "CRON_SECRET is not configured on the worker." });
    return;
  }

  log("cron_scheduler_started", { note: "EC2 worker scheduler now driving sub-daily jobs." });

  // List of runnable sub-daily jobs matching their vercel.json frequencies
  const subDailyJobs = [
    { name: "telegram-sweep", intervalMs: 5 * 60 * 1000 },
    { name: "self-heal", intervalMs: 10 * 60 * 1000 },
    { name: "watchdog", intervalMs: 15 * 60 * 1000 },
    { name: "trending", intervalMs: 30 * 60 * 1000 },
    { name: "expire", intervalMs: 60 * 60 * 1000 },
    { name: "cart-recovery", intervalMs: 60 * 60 * 1000 },
    { name: "notify-retry", intervalMs: 60 * 60 * 1000 },
    { name: "notify", intervalMs: 5 * 60 * 1000 },
    { name: "supplier", intervalMs: 24 * 60 * 60 * 1000 },
    { name: "subscription", intervalMs: 24 * 60 * 60 * 1000 },
  ];

  const trigger = async (job) => {
    try {
      const res = await fetch(`${CONFIG.apiUrl}/api/cron/${job}`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${CONFIG.cronSecret}`,
          "Content-Type": "application/json"
        },
        signal: AbortSignal.timeout(45000)
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.ok !== false) {
        log("cron_trigger_success", { job, detail: body.detail });
      } else {
        log("cron_trigger_failed", { job, status: res.status, error: body.error || "unknown" });
      }
    } catch (e) {
      log("cron_trigger_error", { job, error: e.message });
    }
  };

  for (const job of subDailyJobs) {
    setInterval(() => trigger(job.name), job.intervalMs);
  }

  // A restart should not hold a customer or ops notification until the first
  // five-minute interval. Other jobs retain their normal cadence.
  void trigger("notify");
}

log("WORKER_START", { api: CONFIG.apiUrl, session: CONFIG.sessionDir });
void safeStart("boot");
startCronScheduler();

// This worker is designed to run continuously. The previous WA_RUN_MS
// "scheduled shutdown" (default 15 minutes) was an artefact of an obsolete
// GitHub Actions cron path that tried to host Baileys inside a scheduled job —
// that architecture has been removed. Baileys requires a persistent socket;
// tearing it down every 15 minutes causes rate limits, missed messages, and
// the exact "PROCESS = STOPPED" symptom observed in production.
//
// Graceful shutdown on SIGTERM/SIGINT still uploads the session first so the
// next instance restores it from Supabase Storage without a fresh QR scan.
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, async () => {
    try {
      log("shutdown", { signal });
      await sessionStore.uploadCreds(log);
    } catch (e) {
      log("session_backup_uncaught", { error: String(e) });
    } finally {
      process.exit(0);
    }
  });
}
