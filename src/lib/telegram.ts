import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { automationRuns, categories, manufacturers, notifications, opsTasks, products, settings } from "@/db/schema";
import { detectCategory } from "@/lib/ai";
import { inr, relativeTime } from "@/lib/utils";
import { createSubscriptionOrder, SUBSCRIPTION_PRICE_INR, subscriptionStatus } from "@/lib/subscription";
import {
  approvedSupplierGroups,
  canonicalSupplierGroupName,
  categoryForApprovedSupplierGroup,
  selectAuthoritativeLiveGroups,
} from "@/lib/supplier-groups";

/**
 * MatzHub control plane — Telegram side.
 *
 * Two roles share one router, separated by the webhook URL the update arrived
 * on (see src/app/api/telegram/webhook/route.ts):
 *
 *   ADMIN  — business only. Channels, reader health, sync, subscription,
 *            review queue, orders. No stack traces, no raw job payloads, no
 *            routine technical chatter.
 *   DEV    — job internals, switches, diagnostics.
 *
 * Security, in order — both required, neither sufficient alone:
 *   1. X-Telegram-Bot-Api-Secret-Token must equal TELEGRAM_WEBHOOK_SECRET.
 *   2. The sender's chat id must be in the allowlist. No allowlist configured
 *      means the bot refuses everything (fail closed).
 *
 * Interaction rules enforced here:
 *   - every button performs exactly what its label says, or it does not exist;
 *   - every leaf view has a route back (withBack);
 *   - configuration-changing actions are two-step and never apply on selection;
 *   - slow actions are acknowledged immediately (isSlowAction) and the handler
 *     is bounded by a timeout so the bot can never appear frozen;
 *   - failures return a business sentence to the admin and technical detail to
 *     the developer chat (route.ts), never raw error text to a phone.
 */

export const AUTOMATION_PAUSED_KEY = "automation_paused";

/** Heading of the persistent control panel message. */
export const PANEL_TITLE =
  "🏛 *MatzHub — Admin Control Panel*\n\n_Paste a product SKU any time to see which supplier fulfils it._";
const CHANNEL_UNDO_KEY = "channel_last_deleted";
const AUTO_UPLOAD_KEY = "auto_upload_enabled";
/** Absence of the setting means enabled; a fresh install must publish. */
export const AUTO_UPLOAD_DEFAULT_ON = true;
const MAINTENANCE_KEY = "maintenance_mode";

/**
 * Pending channel addition, keyed per chat. A channel is deliberately NOT
 * written to `manufacturers` when it is picked: the row only appears once the
 * admin has chosen a category. Cancelling (or letting it expire) leaves the
 * database exactly as it was.
 */
const PENDING_CHANNEL_PREFIX = "tg_pending_channel:";
const PENDING_CHANNEL_TTL_MS = 15 * 60 * 1000;

/** Pairing/verification state for the WhatsApp data-reader account. */
export const READER_STATE_KEY = "wa_reader_state";

/** Last payment link issued, so `/payment` never creates a Cashfree order twice. */
const SUBSCRIPTION_LINK_KEY = "subscription_payment_link";

export type ReaderPhase = "unknown" | "awaiting_pairing" | "paired_unverified" | "verified";
type ReaderState = {
  phase: ReaderPhase;
  startedAt?: string;
  verifiedAt?: string;
  channelsVisible?: number;
  channelsConfigured?: number;
  note?: string;
};

/**
 * Command scope. Which one applies is decided by the webhook URL the update
 * arrived on, not by the sender, so a developer messaging the dev bot from any
 * account gets developer commands.
 */
export type Role = "admin" | "dev";

/**
 * Admin surface, fixed by the operations runbook. An admin sees exactly these
 * and nothing else; anything not listed is developer tooling.
 *
 * `logs` is deliberately retained but business-scoped: it lists open items a
 * human must action, not failed-job internals (those are `errors`, dev-only).
 */
const ADMIN_COMMANDS = new Set([
  "help", "qr", "worker", "channels", "channel", "syncstatus",
  "payment", "restart", "relink", "health", "logs", "sync", "panel", "dashboard", "storage",
]);

/**
 * Developer-only: job internals, queue state and switches that can silently
 * change publishing behaviour. Keeping these off the admin bot prevents an
 * operator pausing automation without realising what stopped.
 */
const DEV_ONLY = new Set([
  "diag", "run", "jobs",
  "pause", "resume", "upload", "maintenance", "backfill", "errors",
]);

export function isCommandAllowed(command: string, role: Role): boolean {
  if (role === "dev") return true;
  return ADMIN_COMMANDS.has(command) && !DEV_ONLY.has(command);
}

/* ── inline keyboards ───────────────────────────────────────────────────── */

/**
 * Telegram allows exactly one of `callback_data` or `url` per button, so both
 * are optional here; route.ts maps whichever is present into reply_markup.
 */
export type Button = { text: string; callback_data?: string; url?: string };

/** Buttons that touch the network must be acknowledged before they run. */
const SLOW_ACTION = /^(relink|restart|qr|sync|storage|backfill|chn:|pair:|cadd:|crm:|cmap:|h:pay|h:pair|h:add|h:rm|h:map)/;
export function isSlowAction(callbackData: string | undefined | null): boolean {
  return SLOW_ACTION.test((callbackData ?? "").trim());
}

/** Overall budget for one button press, safely below the 60s function limit. */
export const HANDLER_BUDGET_MS = 25_000;

/** Heading of the persistent control panel message. */
export const HOME_KEYBOARD: Button[][] = [
  [{ text: "🖥 Dashboard", callback_data: "dashboard" }],
  [{ text: "📱 WhatsApp", callback_data: "m:wa" }, { text: "📡 Channels", callback_data: "m:ch" }],
  [{ text: "🔄 Sync", callback_data: "m:sync" }, { text: "💳 Subscription", callback_data: "payment" }],
  [{ text: "❤️ Health", callback_data: "health" }, { text: "📋 Alerts", callback_data: "logs" }],
];

/** Developer console. Diagnostics and switches, never business operations. */
export const DEV_KEYBOARD: Button[][] = [
  [{ text: "🩺 Diagnostics", callback_data: "diag" }, { text: "📊 Worker", callback_data: "worker" }],
  [{ text: "⚙️ Jobs", callback_data: "jobs" }, { text: "🐞 Errors", callback_data: "errors" }],
  [{ text: "📈 Sync status", callback_data: "syncstatus" }, { text: "❤️ Health", callback_data: "health" }],
  [{ text: "⏸ Pause jobs", callback_data: "pause" }, { text: "▶️ Resume", callback_data: "resume" }],
  [{ text: "🚧 Maintenance", callback_data: "maintenance" }, { text: "📥 Backfill", callback_data: "backfill" }],
  [{ text: "🧹 Storage sweep", callback_data: "storage" }],
];

export function keyboardFor(view: string): Button[][] {
  switch (view) {
    case "d:home":
      return DEV_KEYBOARD;
    case "m:wa":
      return [
        [{ text: "📷 Show QR", callback_data: "qr" }, { text: "📊 Reader status", callback_data: "worker" }],
        [{ text: "♻️ Restart reader", callback_data: "restart" }],
        [{ text: "🔁 Replace reader account", callback_data: "h:pair" }],
        [{ text: "◀️ Back", callback_data: "m:home" }],
      ];
    case "m:ch":
      return [
        [{ text: "📋 All channels", callback_data: "channels" }],
        [{ text: "➕ Add new channel", callback_data: "h:add" }, { text: "➖ Remove channel", callback_data: "h:rm" }],
        [{ text: "🏷 Map category", callback_data: "h:map" }, { text: "↩️ Undo last", callback_data: "channel undo" }],
        [{ text: "◀️ Back", callback_data: "m:home" }],
      ];
    case "m:sync":
      return [
        [{ text: "⚡ Pull new supplier posts", callback_data: "sync" }],
        [{ text: "📈 Sync status", callback_data: "syncstatus" }],
        [{ text: "🧹 Clean storage", callback_data: "storage" }],
        [{ text: "◀️ Back", callback_data: "m:home" }],
      ];
    default:
      return HOME_KEYBOARD;
  }
}

/* ── settings helpers ───────────────────────────────────────────────────── */

async function getSetting(key: string): Promise<string | null> {
  const [row] = await db.select().from(settings).where(eq(settings.key, key)).limit(1);
  return row?.value ?? null;
}

async function setSetting(key: string, value: string) {
  await db
    .insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
}

async function clearSetting(key: string) {
  await db.delete(settings).where(eq(settings.key, key)).catch(() => undefined);
}

async function readJson<T>(key: string): Promise<T | null> {
  const raw = await getSetting(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function readReaderState(): Promise<ReaderState> {
  return (await readJson<ReaderState>(READER_STATE_KEY)) ?? { phase: "unknown" };
}

/* ── channel management ─────────────────────────────────────────────────── */

/**
 * Typed `/channel` fallback.
 *
 * Only `undo` remains: add / remove / map are guided button flows now, and
 * their typed equivalents required hand-copying an 18-digit JID and could end
 * with a channel left unmapped.
 */
async function channelCommand(args: string[]): Promise<Reply> {
  if ((args[0] ?? "").toLowerCase() !== "undo") {
    return { text: "📡 Use the *Channels* menu — every action is a button.", keyboard: keyboardFor("m:ch"), ephemeral: true };
  }

  const row = await getSetting(CHANNEL_UNDO_KEY);
  if (!row) return { text: "↩️ Nothing to undo.", keyboard: keyboardFor("m:ch"), ephemeral: true };

  const [candidate] = await db
    .select({ id: manufacturers.id, name: manufacturers.name, canonicalGroupName: manufacturers.canonicalGroupName })
    .from(manufacturers)
    .where(eq(manufacturers.sourceGroupId, row))
    .limit(1);
  if (!candidate || !canonicalSupplierGroupName(candidate.canonicalGroupName ?? candidate.name)) {
    await setSetting(CHANNEL_UNDO_KEY, "");
    return { text: "That previous channel is no longer an authoritative supplier source.", keyboard: keyboardFor("m:ch"), ephemeral: true };
  }
  const [restored] = await db
    .update(manufacturers)
    .set({ status: "active", autoPublish: true })
    .where(eq(manufacturers.id, candidate.id))
    .returning({ name: manufacturers.name });
  await setSetting(CHANNEL_UNDO_KEY, "");

  if (!restored) return { text: "That channel no longer exists.", keyboard: keyboardFor("m:ch"), ephemeral: true };
  return { text: `✅ *${restored.name}* is active again. New supplier posts will be read from it.`, keyboard: keyboardFor("m:ch"), ephemeral: true };
}

/* ── guided channel flows ───────────────────────────────────────────────── */

/**
 * Telegram caps callback_data at 64 bytes. Group JIDs are numeric with an
 * "@g.us" suffix, so the suffix is dropped in payloads and restored on use.
 */
const shortJid = (jid: string) => jid.replace(/@g\.us$/, "");
const fullJid = (shortId: string) => `${shortId}@g.us`;

type ChannelRow = {
  name: string;
  jid: string | null;
  canonicalGroupName?: string | null;
  status?: string;
  category?: string | null;
  products?: number;
};

/**
 * A stored row is visible to Telegram only when it belongs to one configured
 * supplier source. Same-JID rows collapse; same-name different-JID rows are
 * treated as ambiguous and withheld until the configured JID resolves it.
 */
function distinctAuthoritativeChannels<T extends ChannelRow>(rows: T[]) {
  const byJid = new Map<string, T>();
  for (const row of rows) {
    const canonical = canonicalSupplierGroupName(row.jid);
    if (!row.jid || !canonical || byJid.has(row.jid)) continue;
    byJid.set(row.jid, { ...row, canonicalGroupName: canonical });
  }

  const byName = new Map<string, T[]>();
  for (const row of byJid.values()) {
    const canonical = row.canonicalGroupName!;
    byName.set(canonical, [...(byName.get(canonical) ?? []), row]);
  }

  return approvedSupplierGroups.flatMap((configured) => {
    const matches = byName.get(configured.name) ?? [];
    return matches.length === 1 ? matches : [];
  });
}

type PendingChannel = { jid: string; canonicalName: string; subject: string | null; requestedAt: string };

async function readPending(chatId: string): Promise<PendingChannel | null> {
  const pending = await readJson<PendingChannel>(`${PENDING_CHANNEL_PREFIX}${chatId}`);
  if (!pending?.jid) return null;
  const age = Date.now() - new Date(pending.requestedAt).getTime();
  if (!Number.isFinite(age) || age > PENDING_CHANNEL_TTL_MS) {
    await clearSetting(`${PENDING_CHANNEL_PREFIX}${chatId}`);
    return null;
  }
  return pending;
}

/** Live groups from the reader, narrowed to the approved allowlist. */
async function liveAuthoritativeGroups() {
  const live = await workerFetch("/groups", undefined, 8000);
  if ("error" in live && live.error) return { ok: false as const, error: live.error, groups: [] as { jid: string; subject: string; canonicalName: string }[] };
  const body = (live as { body: Record<string, unknown> }).body;
  const raw = (Array.isArray(body.groups) ? body.groups : []) as Array<{ jid?: string; subject?: string }>;
  return { ok: true as const, groups: selectAuthoritativeLiveGroups(raw).groups, error: null };
}

/**
 * Step 1 — channels the system knows about that are not active sources today.
 *
 * Selecting one never activates it: it only opens the category step. When the
 * reader is unreachable the approved allowlist is still offered, because those
 * JIDs are known to the system; the reply states plainly that live connection
 * could not be confirmed, so nothing is silently assumed.
 */
async function listAddableGroups(chatId: string): Promise<Reply> {
  const live = await liveAuthoritativeGroups();

  const boundRows = distinctAuthoritativeChannels(
    await db
      .select({
        name: manufacturers.name,
        jid: manufacturers.sourceGroupId,
        canonicalGroupName: manufacturers.canonicalGroupName,
        status: manufacturers.status,
      })
      .from(manufacturers)
      .where(isNotNull(manufacturers.sourceGroupId)),
  );
  const activeJids = new Set(boundRows.filter((r) => r.status === "active").map((r) => r.jid));
  const activeNames = new Set(boundRows.filter((r) => r.status === "active").map((r) => r.canonicalGroupName));
  const rowsByJid = new Map(boundRows.map((r) => [r.jid, r]));

  const universe = live.groups.length
    ? live.groups.map((g) => ({ jid: g.jid, canonicalName: g.canonicalName, subject: g.subject }))
    : approvedSupplierGroups.map((g) => ({ jid: g.jid, canonicalName: g.name, subject: null as string | null }));

  const candidates = universe.filter((g) => !activeJids.has(g.jid) && !activeNames.has(g.canonicalName));

  const notes = [
    "➕ *Add a new channel*",
    "",
    live.ok
      ? `These are approved source channels that are not active right now (${candidates.length} available).`
      : "⚠️ The reader is unreachable, so live membership could not be confirmed. The approved list is shown instead.",
    "",
    "_Nothing is activated yet._ Next you will be asked for the product category, and the channel only starts being read once you confirm it.",
  ];
  if (candidates.length === 0) {
    notes.push("", "Every approved source channel is already active. New WhatsApp groups are never added automatically — that stays a deliberate, reviewed step.");
  }

  const keyboard: Button[][] = candidates.map((g) => {
    const existing = rowsByJid.get(g.jid);
    const label = existing ? `♻️ ${g.canonicalName.slice(0, 30)} (${existing.status})` : `➕ ${g.canonicalName.slice(0, 34)}`;
    return [{ text: label.slice(0, 40), callback_data: `chn:pick:${shortJid(g.jid)}` }];
  });
  keyboard.push([{ text: "📋 All channels", callback_data: "channels" }]);
  keyboard.push([{ text: "📱 Reader status", callback_data: "m:wa" }]);
  keyboard.push([{ text: "◀️ Back", callback_data: "m:ch" }]);

  return { text: notes.join("\n"), keyboard, ephemeral: true };
}

/** Active channels, as buttons that stop ingestion on tap. */
async function listRemovableChannels(): Promise<Reply> {
  const rows = distinctAuthoritativeChannels(
    await db
      .select({ name: manufacturers.name, jid: manufacturers.sourceGroupId, canonicalGroupName: manufacturers.canonicalGroupName })
      .from(manufacturers)
      .where(and(isNotNull(manufacturers.sourceGroupId), eq(manufacturers.status, "active")))
      .orderBy(manufacturers.name)
      .limit(20),
  );

  if (!rows.length) {
    return { text: "➖ *Remove a channel*\n\nNo active channels.", keyboard: [[{ text: "◀️ Back", callback_data: "m:ch" }]], ephemeral: true };
  }
  return {
    text: "➖ *Remove a channel*\n\nTap to stop reading new posts from it.\n\n_Reversible with ↩️ Undo last. Products already published stay live._",
    keyboard: [
      ...rows.map((r) => [{ text: `➖ ${r.name.slice(0, 36)}`, callback_data: `crm:${shortJid(r.jid!)}` }]),
      [{ text: "◀️ Back", callback_data: "m:ch" }],
    ],
    ephemeral: true,
  };
}

/** Step one of mapping: pick the channel. */
async function listMappableChannels(): Promise<Reply> {
  const rows = distinctAuthoritativeChannels(
    await db
      .select({
        name: manufacturers.name,
        jid: manufacturers.sourceGroupId,
        canonicalGroupName: manufacturers.canonicalGroupName,
        category: categories.name,
      })
      .from(manufacturers)
      .leftJoin(categories, eq(categories.id, manufacturers.defaultCategoryId))
      .where(and(isNotNull(manufacturers.sourceGroupId), eq(manufacturers.status, "active")))
      .orderBy(manufacturers.name)
      .limit(20),
  );

  if (!rows.length) {
    return {
      text: "🏷 *Map a channel*\n\nNo active channels yet. Add one first.",
      keyboard: [[{ text: "➕ Add new channel", callback_data: "h:add" }], [{ text: "◀️ Back", callback_data: "m:ch" }]],
      ephemeral: true,
    };
  }
  const unmapped = rows.filter((r) => !r.category).length;
  return {
    text: [
      "🏷 *Map a channel to a category*",
      "",
      "*Step 1 of 2* — pick the channel.",
      unmapped ? `\n⚠️ ${unmapped} channel${unmapped === 1 ? "" : "s"} still without a category.` : "",
    ].filter(Boolean).join("\n"),
    keyboard: [
      ...rows.map((r) => [
        {
          text: `${r.category ? "🏷" : "⚠️"} ${r.name.slice(0, 24)} → ${r.category ?? "unset"}`.slice(0, 40),
          callback_data: `cpick:${shortJid(r.jid!)}`,
        },
      ]),
      [{ text: "◀️ Back", callback_data: "m:ch" }],
    ],
    ephemeral: true,
  };
}

/** Step two of mapping: pick the category for an already-chosen channel. */
async function listCategoriesFor(shortId: string): Promise<Reply> {
  const cats = await db.select({ name: categories.name, slug: categories.slug }).from(categories).orderBy(categories.position);
  const [mfr] = await db
    .select({ name: manufacturers.name, canonicalGroupName: manufacturers.canonicalGroupName, current: categories.name })
    .from(manufacturers)
    .leftJoin(categories, eq(categories.id, manufacturers.defaultCategoryId))
    .where(eq(manufacturers.sourceGroupId, fullJid(shortId)))
    .limit(1);

  if (!mfr || !canonicalSupplierGroupName(mfr.canonicalGroupName ?? mfr.name)) {
    return { text: "That channel no longer exists.", keyboard: keyboardFor("m:ch"), ephemeral: true };
  }

  return {
    text: [
      "🏷 *Map a channel to a category*",
      "",
      `*Step 2 of 2* — category for *${mfr.name}*.`,
      mfr.current ? `\nCurrently: *${mfr.current}*` : "\n⚠️ Currently unmapped.",
    ].join("\n"),
    keyboard: [
      ...cats.map((c) => [{ text: `${c.name === mfr.current ? "✅" : "🏷"} ${c.name}`, callback_data: `chn:cat:${shortId}:${c.slug}` }]),
      [{ text: "❌ Cancel", callback_data: "chn:cancel" }],
      [{ text: "◀️ Back", callback_data: "h:map" }],
    ],
    ephemeral: true,
  };
}

/** Exactly the approved sources with status, category and live connection. */
async function listChannels(chatId: string): Promise<Reply> {
  const boundRows = distinctAuthoritativeChannels(
    await db
      .select({
        name: manufacturers.name,
        jid: manufacturers.sourceGroupId,
        canonicalGroupName: manufacturers.canonicalGroupName,
        status: manufacturers.status,
        category: categories.name,
        products: manufacturers.totalProducts,
        lastIngestAt: manufacturers.lastIngestAt,
      })
      .from(manufacturers)
      .leftJoin(categories, eq(categories.id, manufacturers.defaultCategoryId))
      .where(isNotNull(manufacturers.sourceGroupId)),
  );
  const byCanonical = new Map(boundRows.map((row) => [row.canonicalGroupName, row]));

  const live = await liveAuthoritativeGroups();
  const liveByJid = new Set(live.groups.map((g) => g.jid));

  const active = approvedSupplierGroups.filter((configured) => byCanonical.get(configured.name)?.status === "active");
  const connected = active.filter((configured) => live.ok && byCanonical.get(configured.name)?.jid && liveByJid.has(byCanonical.get(configured.name)!.jid!)).length;

  const lines = [
    `📡 *Source channels — ${active.length} active of ${approvedSupplierGroups.length} approved*`,
    live.ok
      ? `_Reader currently sees ${connected} of them._`
      : "_⚠️ Reader unreachable — live connection state unknown._",
    "",
  ];

  for (const configured of approvedSupplierGroups) {
    const row = byCanonical.get(configured.name);
    if (!row) {
      lines.push(`⚪ *${configured.name}*\n   not configured yet · category ${configured.category}`);
      continue;
    }
    const state =
      row.status === "blocked"
        ? "🚫 removed"
        : row.status === "paused"
          ? "⏸ paused"
          : !live.ok
            ? "❔ reader offline"
            : liveByJid.has(row.jid!)
              ? "✅ connected"
              : "❌ not connected";
    lines.push(
      [
        `${state}  *${configured.name}*`,
        `   🏷 ${row.category ?? configured.category ?? "from caption"} · 📦 ${row.products ?? 0} products · last post ${relativeTime(row.lastIngestAt ?? null)}`,
      ].join("\n"),
    );
  }

  const pending = await readPending(chatId);
  if (pending) {
    lines.push("", `⏳ An addition is waiting for its category: *${pending.canonicalName}*. Finish it below or cancel it.`);
  }

  const keyboard: Button[][] = [
    [{ text: "➕ Add new channel", callback_data: "h:add" }],
    [{ text: "🏷 Map category", callback_data: "h:map" }, { text: "➖ Remove channel", callback_data: "h:rm" }],
    [{ text: "↩️ Undo last", callback_data: "channel undo" }],
  ];
  if (pending) {
    keyboard.push([{ text: "✅ Choose category now", callback_data: "chn:category" }]);
    keyboard.push([{ text: "❌ Cancel pending add", callback_data: "chn:cancel" }]);
  }
  keyboard.push([{ text: "◀️ Back", callback_data: "m:home" }]);

  return { text: lines.join("\n"), keyboard, ephemeral: true };
}

/* ── reader account pairing (replacement / re-pairing) ─────────────────── */

const readerStateLine = (s: ReaderState) =>
  s.phase === "verified"
    ? `✅ *Verified* — the reader is connected and can see ${s.channelsVisible ?? 0}/${s.channelsConfigured ?? 0} configured channels.`
    : s.phase === "awaiting_pairing"
      ? "⏳ *Pairing open* — the previous session was cleared and a new account has not been verified yet. New supplier posts are not being read."
      : s.phase === "paired_unverified"
        ? "⚠️ *Paired but not verified* — do not treat this account as production-ready yet."
        : "❔ *State unknown* — no replacement has been started from Telegram.";

/** Snapshot of reader health, expressed the way an operator needs it. */
async function readerHealth(): Promise<Reply> {
  const health = await workerFetch("/health", undefined, 8000);
  const state = await readReaderState();
  if ("error" in health && health.error) {
    return {
      text: ["📱 *WhatsApp reader*", "", "🔴 *Unreachable* — MatzHub cannot confirm whether supplier messages are being read.", "", readerStateLine(state), "", "If this persists, restart the reader or replace the account from the menu below."].join("\n"),
      keyboard: [
        [{ text: "♻️ Restart reader", callback_data: "restart" }, { text: "📷 Show QR", callback_data: "qr" }],
        [{ text: "🔁 Replace account", callback_data: "h:pair" }],
        [{ text: "◀️ Back", callback_data: "m:home" }],
      ],
    };
  }
  const b = (health as { body: Record<string, unknown> }).body;
  const status = String(b.status ?? "unknown");
  const ok = status === "connected";
  return {
    text: [
      "📱 *WhatsApp reader*",
      "",
      ok ? `🟢 *Connected* — reading supplier messages. Last post ${b.lastMessageAt ? relativeTime(new Date(String(b.lastMessageAt))) : "not yet seen"}.` : `🟠 *${status}* — supplier messages may not be arriving.`,
      "",
      readerStateLine(state),
    ].join("\n"),
    keyboard: [
      [{ text: "🔎 Verify reader", callback_data: "pair:check" }, { text: "📷 Show QR", callback_data: "qr" }],
      [{ text: "♻️ Restart reader", callback_data: "restart" }],
      [{ text: "🔁 Replace account", callback_data: "h:pair" }],
      [{ text: "📡 Channels", callback_data: "channels" }],
      [{ text: "◀️ Back", callback_data: "m:home" }],
    ],
    ephemeral: ok && state.phase !== "awaiting_pairing",
  };
}

/**
 * Replacement pairing menu.
 *
 * Starting it is destructive to the *current* session, so it is gated behind a
 * second, explicit tap. Channel and category configuration lives in Postgres
 * and is never touched by re-pairing, which is stated on the confirm screen.
 */
async function pairingMenu(): Promise<Reply> {
  const health = await workerFetch("/health", undefined, 8000);
  const state = await readReaderState();
  const reachable = !("error" in health && health.error);
  const connected = reachable && String(((health as { body: Record<string, unknown> }).body.status) ?? "") === "connected";

  const lines = [
    "🔁 *Replace the WhatsApp reader account*",
    "",
    "Use this when the current number is banned, logged out permanently, or must be swapped.",
    "",
    `Current reader: ${reachable ? (connected ? "🟢 connected" : "🟠 not connected") : "⚪ unreachable"}`,
    readerStateLine(state),
    "",
    connected
      ? "⚠️ Confirming clears the current session immediately. Reading pauses until the new account is scanned *and* verified. Channels, categories and published products are untouched."
      : "The current session is not connected, so no working reader will be lost.",
  ];

  return {
    text: lines.join("\n"),
    keyboard: connected
      ? [
          [{ text: "⚠️ Start replacement", callback_data: "pair:start" }],
          [{ text: "📷 Show QR", callback_data: "qr" }, { text: "♻️ Restart reader", callback_data: "restart" }],
          [{ text: "✖️ Cancel", callback_data: "m:wa" }],
        ]
      : [
          [{ text: "📷 Show QR", callback_data: "qr" }],
          [{ text: "⚠️ Start replacement", callback_data: "pair:start" }],
          [{ text: "🔎 Verify reader", callback_data: "pair:check" }],
          [{ text: "◀️ Back", callback_data: "m:wa" }],
        ],
    ephemeral: true,
  };
}

/** Confirmation step — nothing is cleared until this is pressed. */
async function pairingConfirm(): Promise<Reply> {
  return {
    text: [
      "⚠️ *Confirm replacement*",
      "",
      "This logs the current WhatsApp session out and clears it, locally and in storage, so a replacement phone can pair.",
      "",
      "*Kept:* channels, categories, products, settings, orders.\n*Lost:* the current reader session — reading pauses until a new account is verified.",
      "",
      "After confirming: press 📷 Show QR within about 60 seconds and scan it from the new phone (WhatsApp → Linked devices → Link a device). Then press 🔎 Verify reader.",
    ].join("\n"),
    keyboard: [
      [{ text: "✅ Yes — clear session and open pairing", callback_data: "pair:begin" }],
      [{ text: "✖️ Keep current account", callback_data: "m:wa" }],
    ],
  };
}

/** Clears the session and marks the reader as awaiting a verified account. */
async function pairingBegin(): Promise<Reply> {
  await setSetting(
    READER_STATE_KEY,
    JSON.stringify({ phase: "awaiting_pairing", startedAt: new Date().toISOString(), note: "replacement started from Telegram" } satisfies ReaderState),
  );
  const r = await workerFetch("/relink", { method: "POST" }, 12_000);
  if ("error" in r && r.error) {
    return {
      text: "⚠️ *Replacement could not be started* — the reader is unreachable, so nothing was cleared. Your current account is still reading normally.",
      keyboard: [[{ text: "📊 Reader status", callback_data: "worker" }], [{ text: "◀️ Back", callback_data: "m:wa" }]],
    };
  }
  if (!r.ok) {
    return {
      text: "⚠️ *Replacement refused* — the reader rejected the request. This usually means WA_WORKER_TOKEN differs between the reader and the site.",
      keyboard: [[{ text: "📊 Reader status", callback_data: "worker" }], [{ text: "◀️ Back", callback_data: "m:wa" }]],
    };
  }
  return {
    text: [
      "🔑 *Pairing opened.*",
      "",
      "1. Press 📷 Show QR.",
      "2. Scan it from the *new* phone within ~60 seconds.",
      "3. Press 🔎 Verify reader.",
      "",
      "_The replacement is not active for MatzHub until verification passes — a QR scan alone does not make it ready._",
    ].join("\n"),
    keyboard: [
      [{ text: "📷 Show QR", callback_data: "qr" }],
      [{ text: "🔎 Verify reader", callback_data: "pair:check" }],
      [{ text: "◀️ Back", callback_data: "m:wa" }],
    ],
  };
}

/**
 * Verification. Pairing alone is not enough: the account must be connected and
 * able to see the configured source channels before it is called production
 * ready. Channel configuration itself is never re-created here.
 */
async function pairVerify(chatId: string): Promise<Reply> {
  const previous = await readReaderState();
  const health = await workerFetch("/health", undefined, 8000);
  if ("error" in health && health.error) {
    return {
      text: "🔎 *Verification failed* — the reader is unreachable, so nothing can be confirmed. The previous session state is unchanged.",
      keyboard: [[{ text: "🔎 Try again", callback_data: "pair:check" }], [{ text: "◀️ Back", callback_data: "m:wa" }]],
    };
  }
  const b = (health as { body: Record<string, unknown> }).body;
  const status = String(b.status ?? "unknown");

  if (status !== "connected") {
    return {
      text: `🔎 *Not ready* — the reader reports \`${status}\`.\n\nScan the QR from the new phone, then verify again. Until this passes, MatzHub is not reading supplier messages.`,
      keyboard: [
        [{ text: "📷 Show QR", callback_data: "qr" }],
        [{ text: "🔎 Try again", callback_data: "pair:check" }],
        [{ text: "◀️ Back", callback_data: "m:wa" }],
      ],
    };
  }

  const live = await liveAuthoritativeGroups();
  const configured = distinctAuthoritativeChannels(
    await db
      .select({ name: manufacturers.name, jid: manufacturers.sourceGroupId, canonicalGroupName: manufacturers.canonicalGroupName, status: manufacturers.status })
      .from(manufacturers)
      .where(and(isNotNull(manufacturers.sourceGroupId), eq(manufacturers.status, "active"))),
  );
  const visible = live.ok ? configured.filter((c) => live.groups.some((g) => g.jid === c.jid)).length : 0;

  if (configured.length === 0) {
    const state: ReaderState = { phase: "paired_unverified", startedAt: previous.startedAt, note: "no active channels configured" };
    await setSetting(READER_STATE_KEY, JSON.stringify(state));
    return {
      text: "🔎 *Connected, but nothing to read* — no active source channel is configured, so this account cannot be verified for ingestion yet.\n\nAdd channels below; the account is connected and does not need re-pairing for that.",
      keyboard: [[{ text: "➕ Add new channel", callback_data: "h:add" }], [{ text: "📡 Channels", callback_data: "channels" }], [{ text: "◀️ Back", callback_data: "m:wa" }]],
    };
  }

  if (!live.ok || visible === 0) {
    const state: ReaderState = {
      phase: "paired_unverified",
      startedAt: previous.startedAt,
      channelsConfigured: configured.length,
      channelsVisible: 0,
      note: live.ok ? "configured channels not visible to this account" : "reader group list unavailable",
    };
    await setSetting(READER_STATE_KEY, JSON.stringify(state));
    return {
      text: [
        "🔎 *Not production-ready.*",
        "",
        "The account is connected, but it cannot see the configured source channels, so supplier posts would not arrive.",
        `Configured channels visible to it: *0/${configured.length}*`,
        "",
        "Join the new number to the supplier groups in WhatsApp (or add the channels it *is* in), then verify again.",
      ].join("\n"),
      keyboard: [
        [{ text: "🔎 Try again", callback_data: "pair:check" }],
        [{ text: "📡 Channels", callback_data: "channels" }],
        [{ text: "◀️ Back", callback_data: "m:wa" }],
      ],
    };
  }

  const state: ReaderState = {
    phase: "verified",
    startedAt: previous.startedAt,
    verifiedAt: new Date().toISOString(),
    channelsVisible: visible,
    channelsConfigured: configured.length,
  };
  await setSetting(READER_STATE_KEY, JSON.stringify(state));

  const pending = await readPending(chatId);
  return {
    text: [
      "✅ *Reader verified — production-ready.*",
      "",
      `Connected and able to see *${visible}/${configured.length}* configured channels. Existing channel and category settings were reused, so nothing needed reconfiguring.`,
      Number(b.processed ?? 0) > 0 ? `It has already read ${String(b.processed)} message(s).` : "Live ingestion will confirm itself on the next supplier post.",
      "",
      "_If verification later degrades, the Alerts view and the dashboard both show it._",
    ].join("\n"),
    keyboard: [
      [{ text: "📡 Channels", callback_data: "channels" }, { text: "📈 Sync status", callback_data: "syncstatus" }],
      ...(pending ? [[{ text: "✅ Finish pending channel", callback_data: "chn:category" }]] : []),
      [{ text: "◀️ Back", callback_data: "m:home" }],
    ],
  };
}

/* ── order source mapping ───────────────────────────────────────────────── */

/** SKUs are minted as MH-<CAT>-<HEX6> in ingest.ts. */
export const SKU_PATTERN = /\bMH-[A-Z]{2,4}-[A-Z0-9]{4,8}\b/i;

/**
 * Resolves a SKU to the supplier who must fulfil it.
 *
 * A customer taps "Buy on WhatsApp" and their message arrives carrying only the
 * title and SKU. Without this the operator has no way to know which supplier
 * group to source from — the routing information exists in the database but was
 * unreachable from the phone. Paste or forward the SKU here and it resolves.
 *
 * Admin-only by construction: it lives behind the bot's chat allowlist and is
 * never rendered on any public surface.
 */
export async function lookupSku(sku: string): Promise<Reply> {
  const clean = sku.trim().toUpperCase();

  const [row] = await db
    .select({
      title: products.title,
      sku: products.sku,
      slug: products.slug,
      price: products.price,
      costPrice: products.costPrice,
      stockQty: products.stockQty,
      availability: products.availability,
      status: products.status,
      supplier: manufacturers.name,
      groupName: manufacturers.sourceGroupName,
      supplierPhone: manufacturers.phone,
      health: manufacturers.healthScore,
      category: categories.name,
    })
    .from(products)
    .leftJoin(manufacturers, eq(manufacturers.id, products.manufacturerId))
    .leftJoin(categories, eq(categories.id, products.categoryId))
    .where(eq(products.sku, clean))
    .limit(1);

  if (!row) return { text: `No product with SKU \`${clean}\`.`, ephemeral: true };

  const margin = row.costPrice > 0 ? Math.round(((row.price - row.costPrice) / row.costPrice) * 100) : 0;
  const site = (process.env.NEXT_PUBLIC_SITE_URL || "").replace(/\/$/, "");

  return {
    text: [
      `*${row.title}*`,
      `\`${row.sku}\` · ${row.category ?? "uncategorised"} · ${row.status}`,
      "",
      "*Fulfil from*",
      `Supplier: ${row.supplier ?? "_unassigned_"}`,
      `Channel: ${row.groupName ?? "_none_"}`,
      row.supplierPhone ? `Contact: ${row.supplierPhone}` : "Contact: _not recorded_",
      `Supplier health: ${Math.round(row.health ?? 0)}/100`,
      "",
      "*Numbers*",
      `Your cost: ${inr(row.costPrice)}`,
      `Customer pays: ${inr(row.price)}  (+${margin}%)`,
      `Stock: ${row.stockQty} · ${row.availability}`,
      site ? `\n[Listing](${site}/p/${row.slug}) · [Catalogue](${site}/admin/catalog)` : "",
    ].filter(Boolean).join("\n"),
    keyboard: [[{ text: "📡 Channels", callback_data: "channels" }], [{ text: "◀️ Back", callback_data: "m:home" }]],
  };
}

/* ── command router ─────────────────────────────────────────────────────── */

/** Parses "/channel map x y@Bot" -> { command: "channel", args: ["map","x","y"] } */
export function parseCommand(text: string | undefined | null): { command: string; args: string[] } | null {
  const raw = (text ?? "").trim();
  if (!raw.startsWith("/")) return null;
  const parts = raw.slice(1).split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  const command = parts[0].split("@")[0].toLowerCase();
  if (!command) return null;
  return { command, args: parts.slice(1) };
}

/** Must stay in sync with JOBS in src/app/api/cron/[job]/route.ts. */
export const RUNNABLE_JOBS = [
  "stock-sync", "watchdog", "self-heal", "reprice", "notify", "notify-retry",
  "trending", "expire", "supplier", "cart-recovery", "digest",
  "subscription", "telegram-sweep", "storage-sweep",
] as const;

/**
 * Every command the router handles. Asserted by a test against the inline
 * keyboards: a button whose callback_data has no matching case falls through
 * to "unknown command", which still returns HTTP 200 and is otherwise silent.
 *
 * Guided-flow prefixes (chn:, pair:, cpick:, crm:, h:) are matched by prefix
 * below and therefore are not single-token commands.
 */
export const HANDLED_COMMANDS = [
  "start", "help", "health", "tasks", "jobs", "run", "pause", "resume",
  "errors", "upload", "maintenance", "worker", "qr", "restart", "relink", "sync",
  "backfill", "channels", "channel", "payment", "syncstatus", "logs",
  "panel", "dashboard", "storage", "diag",
] as const;

async function workerFetch(path: string, init?: RequestInit, timeoutMs = 12_000) {
  const base = (process.env.WA_WORKER_URL || "").replace(/\/$/, "");
  if (!base) return { ok: false as const, error: "WA_WORKER_URL is not set" };
  const token = process.env.WA_WORKER_TOKEN;
  try {
    const res = await fetch(`${base}${path}`, {
      ...init,
      headers: { ...(init?.headers ?? {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: res.ok as boolean, status: res.status, body } as const;
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : "worker unreachable" };
  }
}

export async function isAutoUploadEnabled(): Promise<boolean> {
  const row = await getSetting(AUTO_UPLOAD_KEY);
  return row !== "0"; // absent means enabled
}

/** Hard stop for ingestion and scheduled work during an incident or migration. */
export async function isMaintenanceMode(): Promise<boolean> {
  const row = await getSetting(MAINTENANCE_KEY);
  return row === "1";
}

export async function isAutomationPaused(): Promise<boolean> {
  const row = await getSetting(AUTOMATION_PAUSED_KEY);
  return row === "1";
}

/**
 * `ephemeral` marks routine status output. The webhook deletes the previous
 * ephemeral reply before sending a new one and expires it on a timer, so
 * repeated status checks never bury an alert.
 *
 * `dedupeKey` lets the webhook skip re-sending content that is already pinned
 * with identical text (the dashboard link), instead of stacking copies.
 */
export type Reply = {
  text: string;
  photoBase64?: string;
  ephemeral?: boolean;
  keyboard?: Button[][];
  dedupeKey?: string;
};

/** Adds a Back button so a leaf view is never a dead end. */
async function withBack(r: Promise<Reply> | Reply, view: string): Promise<Reply> {
  const reply = await r;
  return { ...reply, keyboard: reply.keyboard ?? [[{ text: "◀️ Back", callback_data: view }]] };
}

/**
 * Alert keyboard for the admin.
 *
 * The review queue lives in the web dashboard, so when items are waiting the
 * admin gets one direct link button instead of a menu they would have to hunt
 * through from a phone.
 */
function logsKeyboard(pendingCount: number): Button[][] {
  const site = (process.env.NEXT_PUBLIC_SITE_URL || "").replace(/\/$/, "");
  const rows: Button[][] = [];
  if (pendingCount > 0 && site) rows.push([{ text: "🗂 Review queue", url: `${site}/admin/moderation` }]);
  rows.push([{ text: "📡 Channels", callback_data: "channels" }, { text: "🖥 Dashboard", callback_data: "dashboard" }]);
  rows.push([{ text: "◀️ Back", callback_data: "m:home" }]);
  return rows;
}

/** Technical detail belongs to the developer chat, never to an admin phone. */
async function alertDevelopers(detail: string, context: string) {
  await db
    .insert(notifications)
    .values({ channel: "telegram", audience: "dev", recipient: "ops", template: "telegram_handler_failure", payload: { detail: detail.slice(0, 500), context } })
    .catch(() => undefined);
}

export async function runCommand(command: string, args: string[], chatId: string, role: Role = "admin"): Promise<Reply> {
  // Menu navigation is pure UI: swap the keyboard, never re-query.
  if (command.startsWith("d:") || command.startsWith("m:")) {
    const titles: Record<string, string> = {
      "d:home": "🛠 *MatzHub — Developer Console*",
      "m:home": PANEL_TITLE,
      "m:wa": "*WhatsApp reader*\nPairing, connection state and session lifecycle.",
      "m:ch": "*Channels*\nSupplier sources and their category mapping.",
      "m:sync": "*Sync*\nPull new supplier posts and inspect pipeline state.",
    };
    return { text: titles[command] ?? titles["m:home"], keyboard: keyboardFor(command), ephemeral: true };
  }

  // `h:` views are guided flows. Only genuinely destructive actions ask for a
  // confirmation tap; everything else completes entirely with buttons.
  if (command.startsWith("h:")) {
    if (command === "h:pair" || command === "h:relink") return pairingMenu();
    if (command === "h:add") return listAddableGroups(chatId);
    if (command === "h:rm") return listRemovableChannels();
    if (command === "h:map") return listMappableChannels();
    if (command === "h:pay") return createPaymentLink();
  }

  // ── channel addition: pick → category → commit ───────────────────────────
  // Nothing is written before the category step is confirmed.
  if (/^chn:/.test(command)) {
    const [, action, shortId = "", extra = ""] = command.split(":");

    if (action === "cancel") {
      const had = await readPending(chatId);
      await clearSetting(`${PENDING_CHANNEL_PREFIX}${chatId}`);
      return {
        text: had ? `✖️ Cancelled. *${had.canonicalName}* was not added and nothing else changed.` : "✖️ Nothing was pending. No changes were made.",
        keyboard: keyboardFor("m:ch"),
        ephemeral: true,
      };
    }

    if (action === "pick" || action === "category") {
    if (action === "category") {
      const pending = await readPending(chatId);
      if (!pending) return { text: "There is no channel waiting for a category. Start with *Add new channel*.", keyboard: keyboardFor("m:ch"), ephemeral: true };
      return categoryStep(chatId, pending.canonicalName, shortJid(pending.jid), true);
    }

      const jid = fullJid(shortId);
      const canonical = canonicalSupplierGroupName(jid) ?? canonicalSupplierGroupName(shortId);
      if (!canonical) {
        return { text: "That channel is not on the approved source list, so it cannot be added from Telegram.", keyboard: keyboardFor("m:ch"), ephemeral: true };
      }

      const [byJid] = await db.select({ id: manufacturers.id, status: manufacturers.status, name: manufacturers.name }).from(manufacturers).where(eq(manufacturers.sourceGroupId, jid)).limit(1);
      if (byJid?.status === "active") {
        return { text: `*${byJid.name}* is already an active source channel. Use *Map category* to change its category, or *Remove channel* to stop reading it.`, keyboard: keyboardFor("m:ch"), ephemeral: true };
      }

      const live = await liveAuthoritativeGroups();
      const subject = live.ok ? (live.groups.find((g) => g.jid === jid)?.subject ?? null) : null;

      await setSetting(`${PENDING_CHANNEL_PREFIX}${chatId}`, JSON.stringify({ jid, canonicalName: canonical, subject, requestedAt: new Date().toISOString() } satisfies PendingChannel));
      return categoryStep(chatId, canonical, shortId, false);
    }

    if (action === "cat") {
      const jid = fullJid(shortId);
      const pending = await readPending(chatId);
      if (!pending || pending.jid !== jid) {
        await clearSetting(`${PENDING_CHANNEL_PREFIX}${chatId}`);
        return { text: "⏳ That pending addition expired or belonged to another chat. Nothing was changed — start *Add new channel* again.", keyboard: keyboardFor("m:ch"), ephemeral: true };
      }
      const [cat] = await db.select({ id: categories.id, name: categories.name }).from(categories).where(eq(categories.slug, extra)).limit(1);
      if (!cat) return { text: `Unknown category \`${extra}\`. Nothing was changed.`, keyboard: [[{ text: "🏷 Pick a category", callback_data: "chn:category" }], [{ text: "❌ Cancel", callback_data: "chn:cancel" }]], ephemeral: true };

      // Duplicate protection: one JID, one identity. A name already bound to a
      // different JID is never silently merged or overwritten.
      const [byJid] = await db.select().from(manufacturers).where(eq(manufacturers.sourceGroupId, jid)).limit(1);
      if (byJid && byJid.canonicalGroupName !== pending.canonicalName) {
        await clearSetting(`${PENDING_CHANNEL_PREFIX}${chatId}`);
        return { text: `⚠️ That JID already belongs to *${byJid.name}*. No change was made.`, keyboard: keyboardFor("m:ch"), ephemeral: false };
      }
      const [byName] = await db.select().from(manufacturers).where(eq(manufacturers.canonicalGroupName, pending.canonicalName)).limit(1);
      if (byName && byName.sourceGroupId !== jid) {
        await clearSetting(`${PENDING_CHANNEL_PREFIX}${chatId}`);
        return { text: `⚠️ *${pending.canonicalName}* is already bound to a different JID. Nothing was changed.`, keyboard: keyboardFor("m:ch"), ephemeral: false };
      }

      if (byJid) {
        const [reactivated] = await db
          .update(manufacturers)
          .set({ status: "active", autoPublish: true, defaultCategoryId: cat.id, sourceGroupName: pending.subject ?? byJid.sourceGroupName })
          .where(eq(manufacturers.id, byJid.id))
          .returning({ name: manufacturers.name });
        await clearSetting(`${PENDING_CHANNEL_PREFIX}${chatId}`);
        if (!reactivated) return { text: "That channel no longer exists. Nothing was changed.", keyboard: keyboardFor("m:ch"), ephemeral: true };
        return {
          text: `✅ *${reactivated.name}* is now an active source channel.\n\n🏷 Category: *${cat.name}*\n♻️ Re-activated with its existing configuration — no products or settings were recreated.`,
          keyboard: [[{ text: "📡 All channels", callback_data: "channels" }], [{ text: "◀️ Back", callback_data: "m:ch" }]],
          ephemeral: true,
        };
      }

      const slugBase = pending.canonicalName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "supplier";
      const [created] = await db
        .insert(manufacturers)
        .values({
          name: pending.canonicalName.slice(0, 80),
          slug: `${slugBase}-${shortId.slice(0, 6)}`,
          sourceGroupId: jid,
          sourceGroupName: pending.subject,
          canonicalGroupName: pending.canonicalName,
          defaultCategoryId: cat.id,
          autoPublish: true,
          status: "active",
        })
        .onConflictDoNothing()
        .returning({ name: manufacturers.name, id: manufacturers.id });

      await clearSetting(`${PENDING_CHANNEL_PREFIX}${chatId}`);

      if (!created) {
        return { text: "⚠️ That channel could not be saved — it collided with an existing configuration, so nothing was changed.", keyboard: keyboardFor("m:ch"), ephemeral: false };
      }

      await db.insert(opsTasks).values({
        kind: "supplier",
        severity: "low",
        title: `Source channel added: ${created.name}`,
        detail: `Category set to "${cat.name}". Valid media posts from it publish automatically.`,
        entityType: "manufacturer",
        entityId: created.id,
        actionUrl: "/admin/suppliers",
      });

      return {
        text: [
          `✅ *Channel added*`,
          "",
          `📡 *${created.name}*`,
          `🏷 Category: *${cat.name}*`,
          "",
          "It is active now. New posts from it are read and published when they carry media and a usable price; anything incomplete lands in the review queue.",
        ].join("\n"),
        keyboard: [
          [{ text: " Change category", callback_data: `cpick:${shortId}` }],
          [{ text: "📡 All channels", callback_data: "channels" }],
          [{ text: "◀️ Back", callback_data: "m:home" }],
        ],
        ephemeral: true,
      };
    }

    return { text: "That channel action is no longer available. Nothing was changed.", keyboard: keyboardFor("m:ch"), ephemeral: true };
  }

  // ── reader replacement pairing ───────────────────────────────────────────
  if (/^pair:/.test(command)) {
    const action = command.split(":")[1] ?? "";
    if (action === "start" || action === "begin") return action === "begin" ? pairingBegin() : await pairingConfirm();
    if (action === "check") return pairVerify(chatId);
    return { text: "That pairing action is no longer available.", keyboard: [[{ text: "📱 Reader", callback_data: "m:wa" }]], ephemeral: true };
  }

  // Legacy guided payloads from keyboards already sitting in the chat. `cadd`
  // used to activate on one tap; it now defers to the safe two-step flow.
  if (/^(cadd|crm|cpick|cmap):/.test(command)) {
    const [action, shortId, extra] = command.split(":");

    if (action === "cadd") return runCommand(`chn:pick:${shortId}`, [], chatId, role);
    if (action === "cpick") return listCategoriesFor(shortId);

    if (action === "crm" || action === "cmap") {
      const jid = fullJid(shortId);
      const [candidate] = await db
        .select({ id: manufacturers.id, name: manufacturers.name, canonicalGroupName: manufacturers.canonicalGroupName })
        .from(manufacturers)
        .where(eq(manufacturers.sourceGroupId, jid))
        .limit(1);
      if (!candidate || !canonicalSupplierGroupName(candidate.canonicalGroupName ?? candidate.name)) {
        return { text: "That channel is not an approved supplier source, so there is nothing to change.", keyboard: keyboardFor("m:ch"), ephemeral: true };
      }

      if (action === "crm") {
        const [removed] = await db.update(manufacturers).set({ status: "blocked" }).where(eq(manufacturers.id, candidate.id)).returning({ name: manufacturers.name });
        if (!removed) return { text: "That channel no longer exists.", keyboard: keyboardFor("m:ch"), ephemeral: true };
        await setSetting(CHANNEL_UNDO_KEY, jid);
        return {
          text: `🚫 *${removed.name}* removed.\n\nNew posts from it are no longer read or published. Products already live stay live.\n\n_Reversible with ↩️ Undo last._`,
          keyboard: [[{ text: "↩️ Undo", callback_data: "channel undo" }], [{ text: "📡 All channels", callback_data: "channels" }], [{ text: "◀️ Back", callback_data: "m:ch" }]],
          ephemeral: true,
        };
      }

      const [cat] = await db.select({ id: categories.id, name: categories.name }).from(categories).where(eq(categories.slug, extra)).limit(1);
      if (!cat) return { text: `Unknown category \`${extra}\`. Nothing was changed.`, keyboard: keyboardFor("m:ch"), ephemeral: true };
      const [updated] = await db.update(manufacturers).set({ defaultCategoryId: cat.id }).where(eq(manufacturers.id, candidate.id)).returning({ name: manufacturers.name });
      if (!updated) return { text: "That channel no longer exists.", keyboard: keyboardFor("m:ch"), ephemeral: true };
      return {
        text: `✅ *Mapping saved*\n\n📡 *${updated.name}*\n🏷 → *${cat.name}*\n\n_New posts from this channel are classified with it._`,
        keyboard: [[{ text: "📡 All channels", callback_data: "channels" }], [{ text: "◀️ Back", callback_data: "m:ch" }]],
        ephemeral: true,
      };
    }

    return { text: "That channel action is no longer available. Nothing was changed.", keyboard: keyboardFor("m:ch"), ephemeral: true };
  }

  if (!isCommandAllowed(command, role)) {
    return role === "dev"
      ? { text: `Unknown command \`/${command}\`. Send \`/help\`.`, ephemeral: true }
      : { text: "That action is handled by the engineering bot, not the business one.", keyboard: HOME_KEYBOARD, ephemeral: true };
  }

  switch (command) {
    case "start":
    case "help":
    case "panel": {
      return role === "dev"
        ? { text: "🛠 *MatzHub — Developer Console*", keyboard: DEV_KEYBOARD }
        : { text: PANEL_TITLE, keyboard: HOME_KEYBOARD };
    }

    case "dashboard": {
      // The dashboard URL is never published on the storefront; this bot is the
      // only place it is shared, which is why it is pinned rather than ephemeral.
      const base = (process.env.NEXT_PUBLIC_SITE_URL || "").replace(/\/$/, "");
      if (!base) return { text: "The dashboard address has not been configured yet.", ephemeral: true };
      const url = `${base}/admin`;
      return {
        text: ["*Admin Dashboard*", url, "", "_Private. Not linked from the site, excluded from the sitemap, marked noindex._"].join("\n"),
        keyboard: [[{ text: "🖥 Open dashboard", url }], [{ text: "◀️ Back", callback_data: role === "dev" ? "d:home" : "m:home" }]],
        // The webhook will not re-send this if the pinned copy is identical.
        dedupeKey: url,
      };
    }

    case "health": {
      const t0 = Date.now();
      try {
        await db.execute(sql`select 1`);
        const [cat] = await db
          .select({
            published: sql<number>`count(*) filter (where status='published')::int`,
            pending: sql<number>`count(*) filter (where status='pending_review')::int`,
          })
          .from(products);
        const [sup] = await db.select({ channels: sql<number>`count(*) filter (where source_group_id is not null and status = 'active')::int` }).from(manufacturers);
        const reader = await workerFetch("/health", undefined, 6000);
        const readerOk = !("error" in reader && reader.error) && String(((reader as { body: Record<string, unknown> }).body.status) ?? "") === "connected";
        const state = await readReaderState();
        return {
          text: [
            "*Health*",
            `Systems — ${Date.now() - t0} ms, all responding`,
            `WhatsApp reader — ${readerOk ? "🟢 reading" : state.phase === "awaiting_pairing" ? "⏳ waiting for the new account" : "🔴 needs attention"}`,
            `Active source channels — ${sup.channels}`,
            "",
            `Live catalogue — ${cat.published}`,
            `Waiting for you — ${cat.pending}`,
          ].join("\n"),
          keyboard: [[{ text: "📋 Alerts", callback_data: "logs" }, { text: "📡 Channels", callback_data: "channels" }], [{ text: "◀️ Back", callback_data: "m:home" }]],
          ephemeral: true,
        };
      } catch (e) {
        // Never a stack trace on a phone: the admin gets the fact, the developer
        // gets the detail. An outage still stays in the chat as a record.
        await alertDevelopers(e instanceof Error ? e.message : "unknown", "database health check");
        return { text: "*Health — MatzHub cannot reach its database.*\n\nThe website may show outdated information. The engineering team has been alerted; you do not need to act here." };
      }
    }

    case "tasks":
    case "logs": {
      // Admin-facing alerts: things a human must action. Failed-job internals
      // and raw details are developer-only (`errors`).
      const rows = await db
        .select()
        .from(opsTasks)
        .where(and(eq(opsTasks.status, "open"), sql`${opsTasks.kind} in ('moderation','supplier','stock','order_risk','supplier_channel')`))
        .orderBy(desc(opsTasks.createdAt))
        .limit(8);
      const [pending] = await db.select({ c: sql<number>`count(*)::int` }).from(products).where(eq(products.status, "pending_review"));
      if (!rows.length && !pending.c) return { text: "📋 *Nothing needs you.*\n\nThe review queue is clear and no channel or stock issue is open.", keyboard: HOME_KEYBOARD, ephemeral: true };
      return {
        text: [
          `📋 *Needs attention*${pending.c ? `\n${pending.c} product${pending.c === 1 ? "" : "s"} waiting for review` : ""}`,
          "",
          ...rows.map((t) => `• ${t.title}`),
          "",
          "_Open the dashboard to action these, or paste a SKU here to see who fulfils it._",
        ].join("\n"),
        keyboard: logsKeyboard(pending.c),
        ephemeral: rows.length === 0,
      };
    }

    case "jobs": {
      const { rows } = await db.execute<{ job: string; status: string; last: string | null }>(sql`
        select distinct on (job) job, status, started_at::text as last
        from automation_runs order by job, started_at desc`);
      const byJob = new Map(rows.map((r) => [r.job, r]));
      const paused = await isAutomationPaused();
      return {
        text: `*Jobs*${paused ? " — _automation PAUSED_" : ""}\n\n${RUNNABLE_JOBS.map((j) => {
          const r = byJob.get(j);
          return `• \`${j}\` — ${r ? `${r.status}, ${relativeTime(r.last ? new Date(r.last) : null)}` : "never run"}`;
        }).join("\n")}`,
        keyboard: [[{ text: "🐞 Errors", callback_data: "errors" }], [{ text: "◀️ Back", callback_data: "d:home" }]],
        ephemeral: true,
      };
    }

    case "run": {
      const job = args[0] ?? "";
      if (!job || !(RUNNABLE_JOBS as readonly string[]).includes(job)) {
        return {
          text: `${job ? `Unknown job \`${job}\`.\n\n` : ""}Usage: \`/run <job>\`\n\n${RUNNABLE_JOBS.map((j) => `\`${j}\``).join(", ")}`,
          ephemeral: true,
        };
      }
      // Loopback: the cron route lives in this process. Avoids a public
      // round-trip and is immune to NEXT_PUBLIC_* being inlined at build time.
      const base = `http://127.0.0.1:${process.env.PORT || 3000}`;
      const secret = process.env.CRON_SECRET;
      try {
        const res = await fetch(`${base}/api/cron/${job}`, {
          method: "POST",
          headers: secret ? { authorization: `Bearer ${secret}` } : {},
          signal: AbortSignal.timeout(20_000),
        });
        const body = (await res.json().catch(() => ({}))) as { ok?: boolean; detail?: unknown; error?: string; skipped?: string };
        if (!res.ok || body.ok === false) {
          await alertDevelopers(String(body.error ?? res.status), `job ${job}`);
          return { text: `*${job}* did not complete. The team has been told; no change was left half-applied.`, keyboard: [[{ text: "⚙️ Jobs", callback_data: "jobs" }], [{ text: "◀️ Back", callback_data: "d:home" }]] };
        }
        if (body.skipped) return { text: `*${job}* skipped — automation is paused. \`/resume\` first.`, keyboard: [[{ text: "▶️ Resume", callback_data: "resume" }], [{ text: "◀️ Back", callback_data: "d:home" }]], ephemeral: true };
        return { text: `*${job}* ok\n\`\`\`\n${JSON.stringify(body.detail ?? {}, null, 1)}\n\`\`\``, keyboard: [[{ text: "⚙️ Jobs", callback_data: "jobs" }], [{ text: "◀️ Back", callback_data: "d:home" }]] };
      } catch (e) {
        await alertDevelopers(e instanceof Error ? e.message : "unknown", `job ${job} trigger`);
        return { text: `*${job}* could not be started right now. Nothing was changed.`, keyboard: [[{ text: "⚙️ Jobs", callback_data: "jobs" }], [{ text: "◀️ Back", callback_data: "d:home" }]] };
      }
    }

    case "pause":
      await setSetting(AUTOMATION_PAUSED_KEY, "1");
      return { text: "*Automation paused.* Scheduled jobs will not run until `/resume`.", keyboard: [[{ text: "▶️ Resume", callback_data: "resume" }], [{ text: "◀️ Back", callback_data: "d:home" }]] };

    case "resume":
      await setSetting(AUTOMATION_PAUSED_KEY, "0");
      return { text: "*Automation resumed.*", keyboard: [[{ text: "⚙️ Jobs", callback_data: "jobs" }], [{ text: "◀️ Back", callback_data: "d:home" }]] };

    case "worker":
      return readerHealth();

    case "qr": {
      const r = await workerFetch("/qr", undefined, 8000);
      if ("error" in r && r.error) {
        return { text: "📷 *The QR code could not be fetched right now.*\n\nThe reader is not answering. Try *Restart reader*; if that fails, use *Replace reader account*.", keyboard: [[{ text: "♻️ Restart reader", callback_data: "restart" }], [{ text: "◀️ Back", callback_data: "m:wa" }]] };
      }
      const b = (r as { body: Record<string, unknown> }).body;
      if (b.status === "connected") {
        return { text: "*Already paired.* The session is valid, so no QR was generated.\nUse *Replace reader account* only when the number itself must change.", keyboard: [[{ text: "🔁 Replace account", callback_data: "h:pair" }], [{ text: "◀️ Back", callback_data: "m:wa" }]], ephemeral: true };
      }
      if (typeof b.pngBase64 === "string") {
        // The photo itself cannot carry buttons, so the controls travel with it
        // and are re-attached to the message that asked for the code.
        return {
          text: `*Scan to pair*\nWhatsApp → Linked devices → Link a device\nAge ${String(b.ageSeconds ?? 0)}s — expires in about 60s\n\nAfter scanning, press *Verify reader*.`,
          photoBase64: b.pngBase64,
          keyboard: [
            [{ text: "🔎 Verify reader", callback_data: "pair:check" }],
            [{ text: "📷 New QR", callback_data: "qr" }, { text: "♻️ Restart reader", callback_data: "restart" }],
            [{ text: "◀️ Back", callback_data: "m:wa" }],
          ],
        };
      }
      return {
        text: "*No QR is active right now.* The reader is between states.\nStart a replacement to open a fresh code, or restart it.",
        keyboard: [[{ text: "🔁 Replace account", callback_data: "h:pair" }], [{ text: "♻️ Restart reader", callback_data: "restart" }], [{ text: "◀️ Back", callback_data: "m:wa" }]],
      };
    }

    case "relink":
      return pairingBegin();

    case "sync": {
      // The label says "pull new supplier posts", so this really asks the
      // reader for history. If it is not reachable, that is stated instead of
      // running an unrelated job.
      const r = await workerFetch("/backfill", { method: "POST" }, 12_000);
      if ("error" in r && r.error) {
        return { text: "⚡ *Sync unavailable* — the WhatsApp reader cannot be reached, so no posts could be requested. Products already published are unaffected.", keyboard: [[{ text: "📱 Reader status", callback_data: "worker" }], [{ text: "◀️ Back", callback_data: "m:sync" }]] };
      }
      const b = (r as { body: Record<string, unknown> }).body;
      if (!r.ok || Number(b.groups ?? 0) === 0) {
        return {
          text: "*Nothing was pulled yet.*\n\nWhatsApp only hands over older posts once there is a recent message to page back from. Wait for the next supplier post and try again.",
          keyboard: [[{ text: "📈 Sync status", callback_data: "syncstatus" }], [{ text: "◀️ Back", callback_data: "m:sync" }]],
        };
      }
      return { text: `⚡ *Pulling recent posts* from ${Number(b.groups)} channel(s).\n\nAnything new appears in the catalogue on its own — you'll get an alert only if something needs your decision.`, keyboard: [[{ text: "📈 Sync status", callback_data: "syncstatus" }], [{ text: "◀️ Back", callback_data: "m:sync" }]], ephemeral: true };
    }

    case "errors": {
      // Developer surface: failed jobs with detail.
      const { rows } = await db.execute<{ job: string; detail: string | null; at: string }>(sql`
        select job, detail::text as detail, started_at::text as at
        from automation_runs where status = 'failed'
        order by started_at desc limit 5`);
      if (!rows.length) return { text: "*No failed jobs recorded.*", keyboard: [[{ text: "◀️ Back", callback_data: "d:home" }]], ephemeral: true };
      return {
        text: `*Recent failures (${rows.length})*\n\n${rows
          .map((r) => `\u2022 \`${r.job}\` \u2014 ${relativeTime(new Date(r.at))}\n  ${(r.detail ?? "").slice(0, 140)}`)
          .join("\n")}`,
        keyboard: [[{ text: "◀️ Back", callback_data: "d:home" }]],
      };
    }

    case "upload": {
      const on = args[0] !== "off";
      await setSetting(AUTO_UPLOAD_KEY, on ? "1" : "0");
      return {
        text: on
          ? "*Auto-upload enabled.* Ingested products publish once they clear quality gating."
          : "*Auto-upload disabled.* Ingestion continues, but everything stages for review.",
        keyboard: [[{ text: "◀️ Back", callback_data: "d:home" }]],
      };
    }

    case "maintenance": {
      const now = await isMaintenanceMode();
      await setSetting(MAINTENANCE_KEY, now ? "0" : "1");
      return {
        text: now
          ? "*Maintenance mode off.* Ingestion and scheduled jobs resume."
          : "*Maintenance mode ON.* Ingestion returns 503 and scheduled jobs are skipped.",
        keyboard: [[{ text: "⚙️ Jobs", callback_data: "jobs" }], [{ text: "◀️ Back", callback_data: "d:home" }]],
      };
    }

    case "restart": {
      // Recycles the socket only. Replacing the account is the destructive one.
      const r = await workerFetch("/restart", { method: "POST" }, 12_000);
      if ("error" in r && r.error) {
        return { text: "♻️ *Restart unavailable* — the reader is not answering, so nothing was changed.", keyboard: [[{ text: "🔁 Replace account", callback_data: "h:pair" }], [{ text: "◀️ Back", callback_data: "m:wa" }]] };
      }
      if (!r.ok) {
        await alertDevelopers(`restart refused ${r.status ?? ""}`, "worker restart");
        return { text: "♻️ *Restart refused* — the reader did not accept the request. The team has been told.", ephemeral: false };
      }
      return { text: "*Reader restarting.* The saved session is reused, so no QR is needed. Re-check status in about 20 seconds.", keyboard: [[{ text: "📊 Reader status", callback_data: "worker" }], [{ text: "◀️ Back", callback_data: "m:wa" }]], ephemeral: true };
    }

    case "backfill": {
      const r = await workerFetch("/backfill", { method: "POST" }, 12_000);
      const backfillBack: Button[][] = [[{ text: "📈 Sync status", callback_data: "syncstatus" }], [{ text: "◀️ Back", callback_data: "d:home" }]];
      if ("error" in r && r.error) return { text: `*Backfill* — worker unreachable\n\`${r.error}\``, keyboard: backfillBack };
      const b = (r as { body: Record<string, unknown> }).body;
      if (!r.ok || Number(b.groups ?? 0) === 0) {
        return {
          text: "*Backfill could not start.*\nWhatsApp only serves older history once it has a recent message to page back from. Wait for a supplier post, then retry.",
          keyboard: backfillBack,
        };
      }
      return { text: `*Backfill requested* for ${Number(b.groups)} groups.\nMessages arrive in the background.`, keyboard: backfillBack };
    }

    case "syncstatus": {
      // Answers "is ingestion actually working right now" in one message:
      // last message seen, what published today, and what is stuck in review.
      const [row] = await db
        .select({
          publishedToday: sql<number>`count(*) filter (where status='published' and published_at > now() - interval '1 day')::int`,
          pending: sql<number>`count(*) filter (where status='pending_review')::int`,
          total: sql<number>`count(*) filter (where status='published')::int`,
        })
        .from(products);
      const { rows: last } = await db.execute<{ at: string | null }>(sql`select max(created_at)::text as at from ingestion_events`);
      const seen = last[0]?.at ? relativeTime(new Date(last[0].at)) : "never";
      const reader = await workerFetch("/health", undefined, 6000);
      const readerOk = !("error" in reader && reader.error) && String(((reader as { body: Record<string, unknown> }).body.status) ?? "") === "connected";
      return {
        text: [
          "*Product sync*",
          `Reader — ${readerOk ? "🟢 connected" : "🔴 needs attention"}`,
          `Last supplier message: ${seen}`,
          `Published today: ${row.publishedToday}`,
          `Awaiting review: ${row.pending}`,
          `Live catalogue: ${row.total}`,
        ].join("\n"),
        keyboard: [[{ text: "⚡ Pull new posts", callback_data: "sync" }, { text: "📡 Channels", callback_data: "channels" }], [{ text: "◀️ Back", callback_data: "m:home" }]],
        ephemeral: true,
      };
    }

    case "payment": {
      const sub = await subscriptionStatus();
      const manual = await isAutoUploadEnabled();
      const existing = await readJson<{ orderId: string; link: string }>(SUBSCRIPTION_LINK_KEY);
      const lines = ["*Subscription*"];

      if (sub.inGracePeriod) {
        lines.push("Status: *free until billing starts*", `Billing begins: ${sub.billingStarts?.toISOString().slice(0, 10)}`, "Automatic uploads are running normally.");
      } else if (sub.active) {
        lines.push("Status: *active*", `Renews: ${sub.paidUntil?.toISOString().slice(0, 10)} (${sub.daysRemaining} days)`);
      } else {
        lines.push(
          sub.neverActivated ? "Status: *not activated*" : "Status: *expired*",
          "Automatic uploads are paused. Existing products remain online.",
        );
      }
      lines.push("", `Manual upload switch: ${manual ? "on" : "off"}`, "", "_Customers never see any of this. The storefront is unaffected._");

      const keyboard: Button[][] = [];
      // Creating a payment order is an action, so it never happens on a read.
      if (!sub.inGracePeriod && !sub.active) {
        if (existing?.link) keyboard.push([{ text: "🔗 Open payment link", url: existing.link }]);
        else keyboard.push([{ text: "🔗 Get payment link", callback_data: "h:pay" }]);
      }
      keyboard.push([{ text: "◀️ Back", callback_data: "m:home" }]);

      return { text: lines.join("\n"), keyboard, ephemeral: sub.active || sub.inGracePeriod };
    }

    case "diag": {
      // Developer-only. Answers "is the platform wired correctly" without
      // exposing any secret value — presence only, never contents.
      const t0 = Date.now();
      let dbOk = true;
      try {
        await db.execute(sql`select 1`);
      } catch {
        dbOk = false;
      }
      const workerRes = await workerFetch("/health", undefined, 8000);
      const workerState =
        "error" in workerRes && workerRes.error
          ? `unreachable (${workerRes.error})`
          : String(((workerRes as { body: Record<string, unknown> }).body.status) ?? "unknown");

      const configured = (v: string | undefined) => (v && v.trim() ? "set" : "MISSING");
      return {
        text: [
          "*Diagnostics*",
          `Database: ${dbOk ? "ok" : "FAIL"} (${Date.now() - t0} ms)`,
          `Worker: ${workerState}`,
          `Reader state: ${JSON.stringify(await readReaderState())}`,
          "",
          "*Configuration* _(presence only)_",
          `DATABASE_URL: ${configured(process.env.DATABASE_URL)}`,
          `ADMIN_SESSION_SECRET: ${configured(process.env.ADMIN_SESSION_SECRET)}`,
          `INGEST_TOKEN: ${configured(process.env.INGEST_TOKEN)}`,
          `CRON_SECRET: ${configured(process.env.CRON_SECRET)}`,
          `WA_WORKER_URL: ${configured(process.env.WA_WORKER_URL)}`,
          `WA_WORKER_TOKEN: ${configured(process.env.WA_WORKER_TOKEN)}`,
          `SUPABASE_SERVICE_ROLE_KEY: ${configured(process.env.SUPABASE_SERVICE_ROLE_KEY)}`,
          `CASHFREE_SECRET_KEY: ${configured(process.env.CASHFREE_SECRET_KEY)}`,
          `TELEGRAM_WEBHOOK_SECRET: ${configured(process.env.TELEGRAM_WEBHOOK_SECRET)}`,
          "",
          `Runtime: node ${process.version} · ${process.env.NODE_ENV ?? "unknown"}`,
        ].join("\n"),
        keyboard: [[{ text: "⚙️ Jobs", callback_data: "jobs" }, { text: "❤️ Health", callback_data: "health" }], [{ text: "◀️ Back", callback_data: "d:home" }]],
        ephemeral: true,
      };
    }

    case "storage": {
      // Same sweep, reported the way an operator needs it: one number, no JSON.
      const r = await runCommand("run", ["storage-sweep"], chatId, "dev");
      const ok = r.text.includes("ok");
      return {
        text: ok ? "🧹 *Cleanup finished.* Old telemetry was trimmed; catalogue, channels and products were not touched." : "🧹 *Cleanup did not run.* The team has been told; nothing was deleted.",
        keyboard: [[{ text: "◀️ Back", callback_data: role === "dev" ? "d:home" : "m:sync" }]],
        ephemeral: ok,
      };
    }

    case "channels":
      return withBack(listChannels(chatId), "m:ch");

    case "channel":
      return withBack(channelCommand(args), "m:ch");

    default:
      // Never a dead end: an unrecognised press returns the operator to work.
      return { text: "That action isn't available any more. Nothing was changed.", keyboard: role === "dev" ? DEV_KEYBOARD : HOME_KEYBOARD, ephemeral: true };
  }
}

/** Step 2 of adding a channel: the category choice that actually commits. */
async function categoryStep(chatId: string, canonicalName: string, shortId: string, fromPending: boolean): Promise<Reply> {
  const cats = await db.select({ name: categories.name, slug: categories.slug }).from(categories).orderBy(categories.position);
  const configured = approvedSupplierGroups.find((g) => g.name === canonicalName)?.category ?? null;
  if (!cats.length) {
    // No taxonomy to attach the channel to, so the pending add is dropped and
    // nothing is activated.
    await clearSetting(`${PENDING_CHANNEL_PREFIX}${chatId}`);
    return {
      text: "⚠️ *No product categories exist yet*, so this channel cannot be completed. Nothing was activated or saved.\n\nRun the setup seed on the platform (`npm run setup`) to create the six categories, then add the channel again.",
      keyboard: [[{ text: "📡 Channels", callback_data: "channels" }], [{ text: "◀️ Back", callback_data: "m:ch" }]],
    };
  }
  return {
    text: [
      fromPending ? "🏷 *Finish adding the channel*" : "🏷 *Add a new channel — step 2 of 2*",
      "",
      `*${canonicalName}*`,
      "",
      "Pick the product category. *Until you do, the channel is not active and nothing is read from it.*",
      configured ? `\n_Default from the approved list: ${configured}._` : "",
    ].filter(Boolean).join("\n"),
    keyboard: [
      ...cats.map((c) => [{ text: `🏷 ${c.name}`, callback_data: `chn:cat:${shortId}:${c.slug}` }]),
      [{ text: "❌ Cancel — do not add", callback_data: "chn:cancel" }],
      [{ text: "◀️ Back", callback_data: "m:ch" }],
    ],
    ephemeral: true,
  };
}

/** Issues (or reuses) the operator's subscription payment link. */
async function createPaymentLink(): Promise<Reply> {
  const existing = await readJson<{ orderId: string; link: string }>(SUBSCRIPTION_LINK_KEY);
  if (existing?.link) {
    return {
      text: `🔗 *Payment link for this period*\n\n[Open payment page](${existing.link})\n\n_It stays valid for the current billing period._`,
      keyboard: [
        [{ text: "🔗 Open payment link", url: existing.link }],
        [{ text: "◀️ Back", callback_data: "payment" }],
      ],
      ephemeral: true,
    };
  }
  const order = await createSubscriptionOrder();
  if (!order) {
    return {
      text: "💳 *A payment link could not be created right now.*\n\nBilling credentials are not configured, so automatic uploads stay in their current state. The storefront and the catalogue are unaffected.",
      keyboard: [[{ text: "◀️ Back", callback_data: "payment" }]],
    };
  }
  await setSetting(SUBSCRIPTION_LINK_KEY, JSON.stringify({ orderId: order.orderId, link: order.paymentLink }));
  return {
    text: `🔗 *Payment ready* — ₹${SUBSCRIPTION_PRICE_INR} for 30 days.\n\n[Open payment page](${order.paymentLink})\n\n_After payment, automatic uploads resume on their own._`,
    keyboard: [
      [{ text: "🔗 Open payment link", url: order.paymentLink }],
      [{ text: "◀️ Back", callback_data: "payment" }],
    ],
    ephemeral: true,
  };
}
