#!/usr/bin/env node
/**
 * Diagnostic: does WhatsApp deliver message history to this session?
 *
 * Connects once with syncFullHistory enabled and records exactly what the
 * server pushes. Read-only — it never ingests, never writes to the database
 * and never sends a message.
 *
 *   node probe-history.mjs
 *
 * Stop the main worker first. Two concurrent connections on one session cause
 * WhatsApp to emit 440 connectionReplaced and neither will sync.
 */
import baileys from "@whiskeysockets/baileys";

const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion } = baileys;

const WAIT_MS = Number(process.env.PROBE_WAIT_MS || 70_000);
const log = (...a) => console.log("[probe]", ...a);

const { state, saveCreds } = await useMultiFileAuthState(process.env.WA_SESSION_DIR || "./.wa-session");
const { version } = await fetchLatestBaileysVersion();
log("baileys protocol version:", version.join("."));

let batches = 0;
let historyMessages = 0;
let liveMessages = 0;
const groupCounts = new Map();

const sock = makeWASocket({
  version,
  auth: state,
  printQRInTerminal: false,
  syncFullHistory: true,
  markOnlineOnConnect: false,
  browser: ["MatzHub Probe", "Chrome", "1.0.0"],
});

sock.ev.on("creds.update", saveCreds);

sock.ev.on("messaging-history.set", (ev) => {
  batches += 1;
  const msgs = ev.messages || [];
  historyMessages += msgs.length;
  for (const m of msgs) {
    const jid = m.key?.remoteJid || "?";
    if (jid.endsWith("@g.us")) groupCounts.set(jid, (groupCounts.get(jid) || 0) + 1);
  }
  log(`history.set #${batches} messages=${msgs.length} isLatest=${ev.isLatest} progress=${ev.progress} syncType=${ev.syncType}`);
});

sock.ev.on("messages.upsert", ({ messages, type }) => {
  liveMessages += messages.length;
  log(`messages.upsert type=${type} count=${messages.length}`);
});

sock.ev.on("connection.update", ({ connection, lastDisconnect }) => {
  if (connection === "open") log(`CONNECTED — observing for ${WAIT_MS / 1000}s`);
  if (connection === "close") log("CLOSED code=", lastDisconnect?.error?.output?.statusCode);
});

setTimeout(async () => {
  log("──────────── RESULT ────────────");
  log("history batches      :", batches);
  log("history messages     :", historyMessages);
  log("live messages        :", liveMessages);
  log("groups seen in history:", groupCounts.size);
  for (const [jid, n] of [...groupCounts].slice(0, 12)) log(`   ${jid} → ${n}`);

  try {
    const groups = await sock.groupFetchAllParticipating();
    log("groups joined        :", Object.keys(groups).length);
  } catch (e) {
    log("groupFetchAllParticipating failed:", e.message);
  }
  log("fetchMessageHistory  :", typeof sock.fetchMessageHistory);

  try { sock.end(undefined); } catch { /* already closed */ }
  process.exit(0);
}, WAIT_MS);
