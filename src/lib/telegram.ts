import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { automationRuns, categories, manufacturers, opsTasks, products, settings } from "@/db/schema";
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
 * Telegram Operations Center.
 *
 * Webhook-driven command surface for the admin bot. Costs nothing idle and
 * needs no long-running process, so it works on serverless hosts.
 *
 * Security, in order — both required, neither sufficient alone:
 *   1. X-Telegram-Bot-Api-Secret-Token must equal TELEGRAM_WEBHOOK_SECRET.
 *      Proves the caller is Telegram and not the open internet.
 *   2. The sender's chat id must be in the allowlist. No allowlist configured
 *      means the bot refuses everything (fail closed).
 *
 * Command set is deliberately small. Every command below either prevents an
 * outage, resolves one, or answers a question an operator asks during one.
 * Anything that only duplicated another command has been removed.
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
 * Command scope. Which one applies is decided by the webhook URL the update
 * arrived on, not by the sender, so a developer messaging the dev bot from any
 * account gets developer commands.
 */
export type Role = "admin" | "dev";

/**
 * Admin surface, fixed by the operations runbook. An admin sees exactly these
 * and nothing else; anything not listed is developer tooling.
 */
const ADMIN_COMMANDS = new Set([
  "help", "qr", "worker", "channels", "channel", "syncstatus",
  "payment", "restart", "relink", "health", "logs", "sync", "panel", "dashboard", "noop", "storage",
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

export type Button = { text: string; callback_data: string };

/** Telegram caps callback_data at 64 bytes; keep payloads short. */
export const HOME_KEYBOARD: Button[][] = [
  [{ text: "🖥 Dashboard", callback_data: "dashboard" }],
  [{ text: "📱 WhatsApp", callback_data: "m:wa" }, { text: "📡 Channels", callback_data: "m:ch" }],
  [{ text: "🔄 Sync", callback_data: "m:sync" }, { text: "💳 Subscription", callback_data: "payment" }],
  [{ text: "❤️ Health", callback_data: "health" }, { text: "📋 Logs", callback_data: "logs" }],
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
        [{ text: "📷 Show QR", callback_data: "qr" }, { text: "📊 Status", callback_data: "worker" }],
        [{ text: "♻️ Restart worker", callback_data: "restart" }],
        [{ text: "🔁 Attach new account", callback_data: "h:relink" }],
        [{ text: "◀️ Back", callback_data: "m:home" }],
      ];
    case "m:ch":
      return [
        [{ text: "📋 All channels", callback_data: "channels" }],
        [{ text: "➕ Add channel", callback_data: "h:add" }, { text: "➖ Remove", callback_data: "h:rm" }],
        [{ text: "🏷 Map category", callback_data: "h:map" }, { text: "↩️ Undo last", callback_data: "channel undo" }],
        [{ text: "◀️ Back", callback_data: "m:home" }],
      ];
    case "m:sync":
      return [
        [{ text: "⚡ Force sync now", callback_data: "sync" }],
        [{ text: "📈 Sync status", callback_data: "syncstatus" }],
        [{ text: "🧹 Clean storage", callback_data: "storage" }],
        [{ text: "◀️ Back", callback_data: "m:home" }],
      ];
    default:
      return HOME_KEYBOARD;
  }
}


/* ── channel management ─────────────────────────────────────────────────── */

const normaliseJid = (v: string) => (v.includes("@") ? v : `${v}@g.us`);

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

  const [row] = await db.select().from(settings).where(eq(settings.key, CHANNEL_UNDO_KEY)).limit(1);
  if (!row?.value) return { text: "↩️ Nothing to undo.", keyboard: keyboardFor("m:ch"), ephemeral: true };

  const [candidate] = await db
    .select({ id: manufacturers.id, name: manufacturers.name, canonicalGroupName: manufacturers.canonicalGroupName })
    .from(manufacturers)
    .where(eq(manufacturers.sourceGroupId, row.value))
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
  return { text: `✅ *${restored.name}* restored to active.`, keyboard: keyboardFor("m:ch"), ephemeral: true };
}

/* ── guided channel flows ───────────────────────────────────────────────── */

/**
 * Telegram caps callback_data at 64 bytes. Group JIDs are numeric with an
 * "@g.us" suffix, so the suffix is dropped in payloads and restored on use.
 */
const shortJid = (jid: string) => jid.replace(/@g\.us$/, "");

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

/** Only configured authoritative groups may be added from a live worker. */
async function listAddableGroups(): Promise<Reply> {
  const live = await workerFetch("/groups");
  if ("error" in live && live.error) {
    return {
      text: `📡 *Authoritative groups*\n\n⚠️ The worker is unreachable, so JIDs cannot be resolved. No group is added automatically.\n\`${live.error}\``,
      keyboard: [[{ text: "◀️ Back", callback_data: "m:ch" }]],
      ephemeral: true,
    };
  }
  const body = (live as { body: Record<string, unknown> }).body;
  const liveGroups = (Array.isArray(body.groups) ? body.groups : []) as Array<{ jid?: string; subject?: string }>;
  const selected = selectAuthoritativeLiveGroups(liveGroups);
  const knownRows = distinctAuthoritativeChannels(
    await db
      .select({ name: manufacturers.name, jid: manufacturers.sourceGroupId, canonicalGroupName: manufacturers.canonicalGroupName })
      .from(manufacturers)
      .where(isNotNull(manufacturers.sourceGroupId)),
  );
  const knownJids = new Set(knownRows.map((row) => row.jid));
  const knownNames = new Set(knownRows.map((row) => row.canonicalGroupName));
  const addable = selected.groups.filter((group) => !knownJids.has(group.jid) && !knownNames.has(group.canonicalName));

  const notes = [
    "➕ *Authoritative groups*",
    "",
    addable.length
      ? `Select an unbound approved source (${addable.length} available).`
      : "No unbound approved group is available to add.",
    selected.ambiguousNames.length
      ? `⚠️ Duplicate JIDs withheld: ${selected.ambiguousNames.join(", ")}. Pin the intended JID in WA_GROUP_IDS first.`
      : "",
  ].filter(Boolean).join("\n");

  return {
    text: notes,
    keyboard: [
      ...addable.map((group) => [{ text: `➕ ${group.canonicalName.slice(0, 36)}`, callback_data: `cadd:${shortJid(group.jid)}` }]),
      [{ text: "📋 All channels", callback_data: "channels" }],
      [{ text: "◀️ Back", callback_data: "m:ch" }],
    ],
    ephemeral: true,
  };
}

/** Active channels, as buttons that remove on tap. */
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
    text: "➖ *Remove a channel*\n\nTap to stop ingestion from it.\n\n_Reversible with ↩️ Undo last. Products already published stay live._",
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
      keyboard: [[{ text: "➕ Add channel", callback_data: "h:add" }], [{ text: "◀️ Back", callback_data: "m:ch" }]],
      ephemeral: true,
    };
  }
  const unmapped = rows.filter((r) => !r.category).length;
  return {
    text: [
      "🏷 *Map a channel to a category*",
      "",
      "*Step 1 of 2* — pick the channel.",
       unmapped ? `\n⚠️ ${unmapped} channel${unmapped === 1 ? "" : "s"} still without a default category. Product captions are categorized automatically; map one for more consistent merchandising.` : "",
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
    .where(eq(manufacturers.sourceGroupId, `${shortId}@g.us`))
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
      ...cats.map((c) => [{ text: `${c.name === mfr.current ? "✅" : "🏷"} ${c.name}`, callback_data: `cmap:${shortId}:${c.slug}` }]),
      [{ text: "◀️ Back", callback_data: "h:map" }],
    ],
    ephemeral: true,
  };
}

/** Exactly the nine authoritative sources with live status where resolvable. */
async function listChannels(): Promise<Reply> {
  const boundRows = distinctAuthoritativeChannels(
    await db
      .select({
        name: manufacturers.name,
        jid: manufacturers.sourceGroupId,
        canonicalGroupName: manufacturers.canonicalGroupName,
        status: manufacturers.status,
        category: categories.name,
        products: manufacturers.totalProducts,
      })
      .from(manufacturers)
      .leftJoin(categories, eq(categories.id, manufacturers.defaultCategoryId))
      .where(isNotNull(manufacturers.sourceGroupId)),
  );
  const byCanonical = new Map(boundRows.map((row) => [row.canonicalGroupName, row]));

  const live = await workerFetch("/groups");
  const liveByJid = new Set<string>();
  const liveGroups = "error" in live && live.error
    ? []
    : ((live as { body: Record<string, unknown> }).body.groups as Array<{ jid?: string; subject?: string }> ?? []);
  for (const group of selectAuthoritativeLiveGroups(liveGroups).groups) liveByJid.add(group.jid);
  const reachable = !("error" in live && live.error);

  const connected = approvedSupplierGroups.filter((configured) => {
    const row = byCanonical.get(configured.name);
    return Boolean(row?.status === "active" && row.jid && liveByJid.has(row.jid));
  }).length;

  return {
    text: [
      `📡 *Authoritative supplier groups — ${connected}/9 connected*`,
      reachable ? "_Only configured sources are shown. New groups are ignored until explicitly configured._" : "_⚠️ worker offline — connection state unknown_",
      "",
      ...approvedSupplierGroups.map((configured) => {
        const row = byCanonical.get(configured.name);
        if (!row) return `⚪ *${configured.name}*\n   awaiting first verified message`;
        const state = row.status === "blocked"
          ? "🚫 removed"
          : row.status === "paused"
            ? "⏸ paused"
            : reachable && row.jid && liveByJid.has(row.jid)
              ? "✅ connected"
              : reachable
                ? "❌ not connected"
                : "❔ unknown";
        return [
          `${state}  *${configured.name}*`,
          `   🏷 ${row.category ?? configured.category ?? "caption-based"}   📦 ${row.products ?? 0}`,
          row.jid ? `   \`${row.jid}\`` : "",
        ].filter(Boolean).join("\n");
      }),
    ].join("\n"),
    keyboard: [
      [{ text: "➕ Bind verified JID", callback_data: "h:add" }, { text: "🏷 Map", callback_data: "h:map" }],
      [{ text: "◀️ Back", callback_data: "m:ch" }],
    ],
    ephemeral: true,
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
      variants: products.specs,
      supplier: manufacturers.name,
      groupName: manufacturers.sourceGroupName,
      groupId: manufacturers.sourceGroupId,
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

  // Deep link straight into the supplier's group so the operator can source
  // without hunting for it in a list of 20+ chats.
  const groupLink = row.groupId ? `https://wa.me/?text=${encodeURIComponent(row.groupName ?? "")}` : null;

  return {
    text: [
      `*${row.title}*`,
      `\`${row.sku}\` · ${row.category ?? "uncategorised"} · ${row.status}`,
      "",
      "*Fulfil from*",
      `Supplier: ${row.supplier ?? "_unassigned_"}`,
      `Group: ${row.groupName ?? "_none_"}`,
      row.supplierPhone ? `Contact: ${row.supplierPhone}` : "Contact: _not recorded_",
      `Supplier health: ${Math.round(row.health ?? 0)}/100`,
      "",
      "*Numbers*",
      `Your cost: ${inr(row.costPrice)}`,
      `Customer pays: ${inr(row.price)}  (+${margin}%)`,
      `Stock: ${row.stockQty} · ${row.availability}`,
      groupLink ? `\n[Open group chat](${groupLink})` : "",
    ].filter(Boolean).join("\n"),
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
 */
export const HANDLED_COMMANDS = [
  "start", "help", "health", "tasks", "jobs", "run", "pause", "resume",
  "errors", "upload", "maintenance", "worker", "qr", "restart", "relink", "sync",
  "backfill", "channels", "channel", "payment", "syncstatus", "logs",
  "panel", "dashboard", "noop", "storage", "diag",
] as const;

async function workerFetch(path: string, init?: RequestInit) {
  const base = (process.env.WA_WORKER_URL || "").replace(/\/$/, "");
  if (!base) return { ok: false as const, error: "WA_WORKER_URL is not set" };
  const token = process.env.WA_WORKER_TOKEN;
  try {
    const res = await fetch(`${base}${path}`, {
      ...init,
      headers: { ...(init?.headers ?? {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      signal: AbortSignal.timeout(12_000),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: res.ok as boolean, status: res.status, body } as const;
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : "worker unreachable" };
  }
}

export async function isAutoUploadEnabled(): Promise<boolean> {
  const [row] = await db.select().from(settings).where(eq(settings.key, AUTO_UPLOAD_KEY)).limit(1);
  return row?.value !== "0"; // absent means enabled
}

/** Hard stop for ingestion and scheduled work during an incident or migration. */
export async function isMaintenanceMode(): Promise<boolean> {
  const [row] = await db.select().from(settings).where(eq(settings.key, MAINTENANCE_KEY)).limit(1);
  return row?.value === "1";
}

export async function isAutomationPaused(): Promise<boolean> {
  const [row] = await db.select().from(settings).where(eq(settings.key, AUTOMATION_PAUSED_KEY)).limit(1);
  return row?.value === "1";
}

async function setSetting(key: string, value: string) {
  await db
    .insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
}

/**
 * `ephemeral` marks routine status output. The webhook deletes the previous
 * ephemeral reply before sending a new one and expires it on a timer, so
 * repeated status checks never bury an alert.
 */
export type Reply = { text: string; photoBase64?: string; ephemeral?: boolean; keyboard?: Button[][] };

/** Adds a Back button so a leaf view is never a dead end. */
async function withBack(r: Promise<Reply> | Reply, view: string): Promise<Reply> {
  const reply = await r;
  return { ...reply, keyboard: reply.keyboard ?? [[{ text: "◀️ Back", callback_data: view }]] };
}

export async function runCommand(command: string, args: string[], _chatId: string, role: Role = "admin"): Promise<Reply> {
  // Menu navigation is pure UI: swap the keyboard, never re-query.
  // Menu navigation is pure UI: swap the keyboard, never re-query.
  if (command.startsWith("d:") || command.startsWith("m:")) {
    const titles: Record<string, string> = {
      "d:home": "🛠 *MatzHub — Developer Console*",
      "m:home": PANEL_TITLE,
      "m:wa": "*WhatsApp*\nPairing, connection state and session lifecycle.",
      "m:ch": "*Channels*\nSupplier groups and their category mapping.",
      "m:sync": "*Sync*\nPull new supplier posts and inspect pipeline state.",
    };
    return { text: titles[command] ?? titles["m:home"], keyboard: keyboardFor(command), ephemeral: true };
  }

  // Argument-taking operations cannot be a single button, so the button shows
  // the exact line to copy. Keeps the surface button-first without pretending
  // a free-text value can be tapped.
  // `h:` views are guided flows. Only genuinely destructive actions ask for a
  // confirmation tap; everything else is completed entirely with buttons.
  if (command.startsWith("h:")) {
    if (command === "h:relink") {
      return {
        text:
          "*Attach a different WhatsApp account*\n\n" +
          "This removes the current session, locally and from backup, so a new phone can be linked. " +
          "Ingestion stops until the new QR is scanned.\n\n" +
          "Products, channels, categories and settings are untouched.",
        keyboard: [
          [{ text: "⚠️ Confirm — remove session", callback_data: "relink" }],
          [{ text: "✖️ Cancel", callback_data: "m:wa" }],
        ],
        ephemeral: true,
      };
    }

    if (command === "h:add") return listAddableGroups();
    if (command === "h:rm") return listRemovableChannels();
    if (command === "h:map") return listMappableChannels();
  }

  // Guided-flow actions. Each completes in one tap and returns to a menu.
  if (/^(cadd|crm|cpick|cmap):/.test(command)) {
    const [action, shortId, extra] = command.split(":");
    const jid = `${shortId}@g.us`;

    if (action === "cpick") return listCategoriesFor(shortId);

    if (action === "cadd") {
      const live = await workerFetch("/groups");
      const body = "error" in live && live.error ? {} : (live as { body: Record<string, unknown> }).body;
      const rawGroups = (Array.isArray(body.groups) ? body.groups : []) as Array<{ jid?: string; subject?: string }>;
      const selected = selectAuthoritativeLiveGroups(rawGroups).groups.find((group) => group.jid === jid);
      if (!selected) {
        return { text: "This JID is not an unambiguous configured supplier group. Refresh Authoritative groups after pinning the intended JID if needed.", keyboard: keyboardFor("m:ch"), ephemeral: true };
      }

      const canonicalName = selected.canonicalName;
      const [byJid] = await db.select().from(manufacturers).where(eq(manufacturers.sourceGroupId, jid)).limit(1);
      if (byJid) {
        if (byJid.canonicalGroupName !== canonicalName) {
          return { text: "That JID is already bound to a different supplier identity. No change was made.", keyboard: keyboardFor("m:ch") };
        }
        await db.update(manufacturers).set({ status: "active", autoPublish: true }).where(eq(manufacturers.id, byJid.id));
        return { text: `✅ *${canonicalName}* reactivated. Valid media products publish automatically.`, keyboard: keyboardFor("m:ch"), ephemeral: true };
      }

      const [byName] = await db
        .select()
        .from(manufacturers)
        .where(eq(manufacturers.canonicalGroupName, canonicalName))
        .limit(1);
      if (byName && byName.sourceGroupId !== jid) {
        return { text: `⚠️ *${canonicalName}* is already bound to a different JID. No automatic merge was performed. Pin the intended JID in WA_GROUP_IDS before replacing it.`, keyboard: keyboardFor("m:ch") };
      }

      const configuredCategory = categoryForApprovedSupplierGroup(jid, canonicalName);
      const inferred = configuredCategory ? { slug: configuredCategory, confidence: 1 } : detectCategory("", canonicalName, null);
      const [cat] = inferred.confidence > 0
        ? await db.select({ id: categories.id, name: categories.name }).from(categories).where(eq(categories.slug, inferred.slug)).limit(1)
        : [];
      await db.insert(manufacturers).values({
        name: canonicalName,
        slug: `${canonicalName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "supplier"}-${shortId.slice(0, 6)}`,
        sourceGroupId: jid,
        sourceGroupName: selected.subject,
        canonicalGroupName: canonicalName,
        defaultCategoryId: cat?.id ?? null,
        autoPublish: true,
        status: "active",
      }).onConflictDoNothing();

      return {
        text: [
          `✅ *${canonicalName}* bound to its JID`,
          "",
          `🏷 Category: *${cat?.name ?? "caption-based"}*`,
          "📦 Valid media products publish automatically.",
        ].join("\n"),
        keyboard: [
          [{ text: "🏷 Change category", callback_data: `cpick:${shortId}` }],
          [{ text: "📋 Authoritative groups", callback_data: "channels" }],
          [{ text: "◀️ Back", callback_data: "m:ch" }],
        ],
        ephemeral: true,
      };
    }

    if (action === "crm") {
      const [candidate] = await db
        .select({ id: manufacturers.id, name: manufacturers.name, canonicalGroupName: manufacturers.canonicalGroupName })
        .from(manufacturers)
        .where(eq(manufacturers.sourceGroupId, jid))
        .limit(1);
      if (!candidate || !canonicalSupplierGroupName(candidate.canonicalGroupName ?? candidate.name)) {
        return { text: "That channel is not an authoritative supplier source.", keyboard: keyboardFor("m:ch"), ephemeral: true };
      }
      const [removed] = await db
        .update(manufacturers)
        .set({ status: "blocked" })
        .where(eq(manufacturers.id, candidate.id))
        .returning({ name: manufacturers.name });
      if (!removed) return { text: "That channel no longer exists.", keyboard: keyboardFor("m:ch"), ephemeral: true };
      await setSetting(CHANNEL_UNDO_KEY, jid);
      return {
        text: `🚫 *${removed.name}* removed.\n\nIngestion stopped. Published products stay live.\n\n_Reversible with ↩️ Undo last._`,
        keyboard: keyboardFor("m:ch"),
        ephemeral: true,
      };
    }

    if (action === "cmap") {
      const [cat] = await db.select({ id: categories.id, name: categories.name }).from(categories).where(eq(categories.slug, extra)).limit(1);
      if (!cat) return { text: `Unknown category \`${extra}\`.`, keyboard: keyboardFor("m:ch"), ephemeral: true };
      const [candidate] = await db
        .select({ id: manufacturers.id, name: manufacturers.name, canonicalGroupName: manufacturers.canonicalGroupName })
        .from(manufacturers)
        .where(eq(manufacturers.sourceGroupId, jid))
        .limit(1);
      if (!candidate || !canonicalSupplierGroupName(candidate.canonicalGroupName ?? candidate.name)) {
        return { text: "That channel is not an authoritative supplier source.", keyboard: keyboardFor("m:ch"), ephemeral: true };
      }
      const [updated] = await db
        .update(manufacturers)
        .set({ defaultCategoryId: cat.id })
        .where(eq(manufacturers.id, candidate.id))
        .returning({ name: manufacturers.name });
      if (!updated) return { text: "That channel no longer exists.", keyboard: keyboardFor("m:ch"), ephemeral: true };
      return {
        text: [
          `✅ *Mapping saved*`,
          "",
          `📡 *${updated.name}*`,
          `🏷 → *${cat.name}*`,
          "",
          "_New posts from this group are classified automatically._",
        ].join("\n"),
        keyboard: [
          [{ text: "📋 All channels", callback_data: "channels" }],
          [{ text: "◀️ Back", callback_data: "m:ch" }],
        ],
        ephemeral: true,
      };
    }
  }

  if (!isCommandAllowed(command, role)) {
    return { text: "That command lives on the developer bot.", ephemeral: true };
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
      if (!base) return { text: "NEXT_PUBLIC_SITE_URL is not configured.", ephemeral: true };
      return {
        text: [
          "*Admin Dashboard*",
          `${base}/admin`,
          "",
          "_Private URL. It is not linked from the website, excluded from the sitemap and marked noindex._",
        ].join("\n"),
        keyboard: [[{ text: "◀️ Back", callback_data: role === "dev" ? "d:home" : "m:home" }]],
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
        const [sup] = await db
          .select({ channels: sql<number>`count(*) filter (where source_group_id is not null)::int` })
          .from(manufacturers);
        const paused = await isAutomationPaused();
        return {
          text: [
            "*Health*",
            `Database — connected (${Date.now() - t0} ms)`,
            `Automation — ${paused ? "*PAUSED*" : "running"}`,
            "",
            `Published ${cat.published} · awaiting review ${cat.pending}`,
            `Supplier channels: ${sup.channels}`,
          ].join("\n"),
          ephemeral: true,
        };
      } catch (e) {
        // Not ephemeral: an outage must stay in the chat as a record.
        return { text: `*Health — DATABASE UNREACHABLE*\n\`${e instanceof Error ? e.message : "unknown"}\`` };
      }
    }

    case "tasks": {
      const rows = await db
        .select()
        .from(opsTasks)
        .where(eq(opsTasks.status, "open"))
        .orderBy(desc(opsTasks.createdAt))
        .limit(8);
      if (!rows.length) return { text: "*Queue is clear.*", ephemeral: true };
      return {
        text: `*Open tasks (${rows.length})*\n\n${rows
          .map((t) => `• [${t.severity}] ${t.title}\n  ${relativeTime(t.createdAt)}`)
          .join("\n")}`,
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
          signal: AbortSignal.timeout(55_000),
        });
        const body = (await res.json().catch(() => ({}))) as { ok?: boolean; detail?: unknown; error?: string; skipped?: string };
        if (!res.ok || body.ok === false) return { text: `*${job}* failed\n\`${body.error ?? res.status}\`` };
        if (body.skipped) return { text: `*${job}* skipped — automation is paused. \`/resume\` first.`, ephemeral: true };
        return { text: `*${job}* ok\n\`\`\`\n${JSON.stringify(body.detail ?? {}, null, 1)}\n\`\`\`` };
      } catch (e) {
        return { text: `*${job}* could not be triggered\n\`${e instanceof Error ? e.message : "unknown"}\`` };
      }
    }

    case "pause":
      await setSetting(AUTOMATION_PAUSED_KEY, "1");
      return { text: "*Automation paused.* Scheduled jobs will not run until `/resume`." };

    case "resume":
      await setSetting(AUTOMATION_PAUSED_KEY, "0");
      return { text: "*Automation resumed.*" };

    case "worker": {
      const r = await workerFetch("/health");
      if ("error" in r && r.error) return { text: `*Worker unreachable*\n\`${r.error}\`` };
      const b = (r as { body: Record<string, unknown> }).body;
      const status = String(b.status ?? "unknown");
      return {
        text: [
          `*Worker* — ${status}`,
          `Processed ${String(b.processed ?? 0)} · failures ${String(b.failures ?? 0)}`,
          `Last message ${b.lastMessageAt ? relativeTime(new Date(String(b.lastMessageAt))) : "never"}`,
        ].join("\n"),
        // A healthy worker is routine; a broken one is a record worth keeping.
        ephemeral: status === "connected",
      };
    }

    case "qr": {
      const r = await workerFetch("/qr");
      if ("error" in r && r.error) return { text: `*QR* — worker unreachable\n\`${r.error}\`` };
      const b = (r as { body: Record<string, unknown> }).body;
      if (b.status === "connected") {
        return { text: "*Already paired.* Session is valid, so no QR was generated.\nUse `/relink` only to force a re-pair.", ephemeral: true };
      }
      if (typeof b.pngBase64 === "string") {
        return {
          text: `*Scan to pair*\nWhatsApp → Linked devices → Link a device\nAge ${String(b.ageSeconds ?? 0)}s — expires in about 60s`,
          photoBase64: b.pngBase64,
        };
      }
      return { text: `*QR* — no active code. Worker is \`${String(b.status ?? "unknown")}\`.\nUse \`/relink\` to force one.` };
    }

    case "relink": {
      const r = await workerFetch("/relink", { method: "POST" });
      if ("error" in r && r.error) return { text: `*Relink* — worker unreachable\n\`${r.error}\`` };
      if (!r.ok) return { text: "*Relink refused.* WA_WORKER_TOKEN must be set on both the worker and this app." };
      return { text: "*Session cleared.* Wait about five seconds, then send `/qr`." };
    }

    case "sync": {
      const r = await workerFetch("/health");
      if ("error" in r && r.error) return { text: `*Sync* — worker unreachable\n\`${r.error}\`` };
      const status = String(((r as { body: Record<string, unknown> }).body.status) ?? "unknown");
      if (status !== "connected") return { text: `*Sync* — worker is \`${status}\`. Pair it first with \`/qr\`.` };
      // Ingestion is push-based: the worker forwards messages as they arrive.
      // What an operator actually wants here is the post-ingest pipeline run.
      return runCommand("run", ["stock-sync"], _chatId);
    }

    case "logs":
    case "errors": {
      // Failed jobs are the first thing an operator needs during an incident;
      // without this they must open the dashboard to see anything at all.
      const { rows } = await db.execute<{ job: string; detail: string | null; at: string }>(sql`
        select job, detail::text as detail, started_at::text as at
        from automation_runs where status = 'failed'
        order by started_at desc limit 5`);
      if (!rows.length) return { text: "*No failed jobs recorded.*", ephemeral: true };
      return {
        text: `*Recent failures (${rows.length})*\n\n${rows
          .map((r) => `\u2022 \`${r.job}\` \u2014 ${relativeTime(new Date(r.at))}\n  ${(r.detail ?? "").slice(0, 140)}`)
          .join("\n")}`,
      };
    }

    case "upload": {
      const on = args[0] !== "off";
      await setSetting(AUTO_UPLOAD_KEY, on ? "1" : "0");
      return {
        text: on
          ? "*Auto-upload enabled.* Ingested products publish once they clear quality gating."
          : "*Auto-upload disabled.* Ingestion continues, but everything stages for review.",
      };
    }

    case "maintenance": {
      const now = await isMaintenanceMode();
      await setSetting(MAINTENANCE_KEY, now ? "0" : "1");
      return {
        text: now
          ? "*Maintenance mode off.* Ingestion and scheduled jobs resume."
          : "*Maintenance mode ON.* Ingestion returns 503 and scheduled jobs are skipped.",
      };
    }

    case "restart": {
      // Recycles the socket only. /relink is the destructive one.
      const r = await workerFetch("/restart", { method: "POST" });
      if ("error" in r && r.error) return { text: `*Restart* \u2014 worker unreachable\n\`${r.error}\`` };
      if (!r.ok) return { text: "*Restart refused.* WA_WORKER_TOKEN must be set on both sides." };
      return { text: "*Worker restarting.* The saved session is reused, so no QR is needed." };
    }

    case "backfill": {
      const r = await workerFetch("/backfill", { method: "POST" });
      if ("error" in r && r.error) return { text: `*Backfill* \u2014 worker unreachable\n\`${r.error}\`` };
      const b = (r as { body: Record<string, unknown> }).body;
      if (!r.ok || Number(b.groups ?? 0) === 0) {
        return {
          text: "*Backfill could not start.*\nWhatsApp only serves older history once it has a recent message to page back from. Wait for a supplier post, then retry.",
        };
      }
      return { text: `*Backfill requested* for ${Number(b.groups)} groups.\nMessages arrive in the background.` };
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
      const { rows: last } = await db.execute<{ at: string | null }>(sql`
        select max(created_at)::text as at from ingestion_events`);
      const seen = last[0]?.at ? relativeTime(new Date(last[0].at)) : "never";
      return {
        text: [
          "*Product sync*",
          `Last supplier message: ${seen}`,
          `Published today: ${row.publishedToday}`,
          `Awaiting review: ${row.pending}`,
          `Live catalogue: ${row.total}`,
        ].join("\n"),
        ephemeral: true,
      };
    }

    case "payment": {
      const sub = await subscriptionStatus();
      const manual = await isAutoUploadEnabled();
      const lines = ["*Subscription*"];

      if (sub.inGracePeriod) {
        lines.push(
          "Status: *free until billing starts*",
          `Billing begins: ${sub.billingStarts?.toISOString().slice(0, 10)}`,
          "Automatic uploads are running normally.",
        );
      } else if (sub.active) {
        lines.push("Status: *active*", `Renews: ${sub.paidUntil?.toISOString().slice(0, 10)} (${sub.daysRemaining} days)`);
      } else {
        lines.push(
          sub.neverActivated ? "Status: *not activated*" : "Status: *expired*",
          "Automatic uploads are paused. Existing products remain online.",
        );
      }

      lines.push("", `Manual upload switch: ${manual ? "on" : "off"}`);

      const keyboard: Button[][] = [];
      if (!sub.inGracePeriod && !sub.active) {
        const order = await createSubscriptionOrder();
        if (order) keyboard.push([{ text: `Pay ₹${SUBSCRIPTION_PRICE_INR}`, callback_data: "noop" }]);
        lines.push(
          "",
          order
            ? `[Open payment page](${order.paymentLink})`
            : "_Cashfree credentials are not configured yet, so no payment link can be issued._",
        );
      }
      lines.push("", "_Customers never see any of this. The storefront is unaffected._");
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
      const workerRes = await workerFetch("/health");
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
        ephemeral: true,
      };
    }

    case "storage":
      return withBack(runCommand("run", ["storage-sweep"], _chatId, "dev"), role === "dev" ? "d:home" : "m:sync");

    case "noop":
      return { text: PANEL_TITLE, keyboard: HOME_KEYBOARD, ephemeral: true };

    case "channels":
      return withBack(listChannels(), "m:ch");

    case "channel":
      return withBack(channelCommand(args), "m:ch");

    default:
      return { text: `Unknown command \`/${command}\`. Send \`/help\`.`, ephemeral: true };
  }
}
