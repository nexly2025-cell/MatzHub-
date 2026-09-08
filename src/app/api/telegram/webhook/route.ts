import { NextResponse } from "next/server";
import { and, eq, like, lt, lte } from "drizzle-orm";
import { db } from "@/db";
import { notifications, settings, telegramEphemeral } from "@/db/schema";
import { HANDLER_BUDGET_MS, isSlowAction, keyboardFor, lookupSku, parseCommand, runCommand, SKU_PATTERN, type Button } from "@/lib/telegram";

export const dynamic = "force-dynamic";

/**
 * Issue 5 — webhook / dashboard URLs.
 * NEXT_PUBLIC_SITE_URL is the canonical host. VERCEL_URL is a hostname without
 * a protocol and is often unset on production custom domains. Last resort is
 * the public matzhub.com domain.
 */
export function publicSiteUrl(): string {
  const fromSite = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (fromSite) return fromSite.replace(/\/$/, "");
  const vercel = process.env.VERCEL_URL?.trim();
  if (vercel) return (vercel.startsWith("http") ? vercel : `https://${vercel}`).replace(/\/$/, "");
  return "https://matzhub.com";
}

/**
 * Shared Telegram webhook handler, used by both bots.
 *
 * Bot identity comes from the URL, not from the sender:
 *   POST /api/telegram/webhook       → admin bot
 *   POST /api/telegram/webhook/dev   → developer bot
 *
 * That distinction matters. Telegram allows exactly one webhook per bot, and
 * a payload carries no indication of which bot received it. Keying the role off
 * the chat id instead meant a developer messaging the dev bot from their own
 * account was classified as an admin and had every dev command refused, while
 * replies went out through the wrong bot token.
 *
 * Always answers 200 — Telegram retries non-2xx aggressively, and a retry storm
 * from an unauthorised caller is worse than silently dropping it. Refusals are
 * communicated in the reply body, not the status code.
 */

export type BotKind = "admin" | "dev";

const API = (token: string, method: string) => `https://api.telegram.org/bot${token}/${method}`;

/** Replies always leave through the bot that received the message. */
function tokenFor(bot: BotKind): string {
  return bot === "dev"
    ? process.env.TELEGRAM_DEV_BOT_TOKEN || ""
    : process.env.TELEGRAM_ADMIN_BOT_TOKEN || "";
}

/**
 * Per-bot webhook secret. Falls back to the shared value so an existing
 * single-bot deployment keeps working after this split.
 */
function secretFor(bot: BotKind): string {
  const shared = process.env.TELEGRAM_WEBHOOK_SECRET ?? "";
  return bot === "dev" ? process.env.TELEGRAM_DEV_WEBHOOK_SECRET || shared : shared;
}

/** Chat ids permitted to drive a given bot. */
function allowedFor(bot: BotKind): string[] {
  const raw = bot === "dev" ? process.env.TELEGRAM_DEV_CHAT_ID : process.env.TELEGRAM_ADMIN_CHAT_ID;
  return (raw ?? "").split(",").map((v) => v.trim()).filter(Boolean);
}

/**
 * Every Telegram round trip is bounded. A button press runs inside a serverless
 * request; an unbounded socket call to api.telegram.org can hold it open until
 * the platform kills it, which is exactly how a "frozen bot" is produced.
 */
const TG_TIMEOUT_MS = 8_000;

async function tgApi(token: string, method: string, body: Record<string, unknown>, form?: FormData): Promise<Response | null> {
  try {
    return form
      ? await fetch(API(token, method), { method: "POST", body: form, signal: AbortSignal.timeout(TG_TIMEOUT_MS) })
      : await fetch(API(token, method), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(TG_TIMEOUT_MS),
        });
  } catch {
    return null;
  }
}

/**
 * Telegram accepts exactly one action per button — `callback_data` or `url` —
 * so the two button kinds are normalised here rather than at every call site.
 */
function markup(keyboard?: Button[][]) {
  if (!keyboard?.length) return {};
  const inline_keyboard = keyboard
    .filter((row) => row.length > 0)
    .map((row) =>
      row.map((b) => (b.url ? { text: b.text, url: b.url } : { text: b.text, callback_data: b.callback_data ?? "" })),
    );
  return { reply_markup: { inline_keyboard } };
}

const idOf = async (r: Response | null) => {
  if (!r) return null;
  const d = (await r.json().catch(() => ({}))) as { ok?: boolean; result?: { message_id?: number } };
  return d.ok ? (d.result?.message_id ?? null) : null;
};

async function send(bot: BotKind, chatId: string, text: string, keyboard?: Button[][]): Promise<number | null> {
  const token = tokenFor(bot);
  if (!token) return null;
  const base = { chat_id: chatId, text, disable_web_page_preview: true, ...markup(keyboard) };
  const marked = await tgApi(token, "sendMessage", { ...base, parse_mode: "Markdown" });
  if (marked?.ok) return idOf(marked);
  // Legacy Markdown rejects unbalanced _ * [ ` which can appear in supplier
  // titles and driver error strings. Rather than silently dropping the reply,
  // resend it as plain text so the operator always gets the information.
  return idOf(await tgApi(token, "sendMessage", base));
}

async function sendPhoto(bot: BotKind, chatId: string, base64: string, caption: string): Promise<number | null> {
  const token = tokenFor(bot);
  if (!token) return null;
  const form = new FormData();
  form.append("chat_id", chatId);
  form.append("caption", caption);
  form.append("parse_mode", "Markdown");
  form.append("photo", new Blob([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], { type: "image/png" }), "qr.png");
  return idOf(await tgApi(token, "sendPhoto", {}, form));
}

async function editMessage(bot: BotKind, chatId: string, messageId: number, text: string, keyboard?: Button[][]) {
  const token = tokenFor(bot);
  if (!token) return;
  const body: Record<string, unknown> = {
    chat_id: chatId, message_id: messageId, text,
    parse_mode: "Markdown", disable_web_page_preview: true,
    ...markup(keyboard),
  };
  const r = await tgApi(token, "editMessageText", body);
  // Markdown can be rejected by supplier titles and driver errors; retry plain
  // so the operator still sees the result rather than a stale screen.
  if (r && !r.ok) {
    delete body.parse_mode;
    await tgApi(token, "editMessageText", body);
  }
}

/** Clears the button's spinner, and optionally shows the operator a toast. */
async function answerCallback(bot: BotKind, id: string, text?: string) {
  const token = tokenFor(bot);
  if (!token) return;
  await tgApi(token, "answerCallbackQuery", { callback_query_id: id, ...(text ? { text } : {}) });
}

async function deleteMessage(bot: BotKind, chatId: string, messageId: number) {
  const token = tokenFor(bot);
  if (!token) return;
  await tgApi(token, "deleteMessage", { chat_id: chatId, message_id: messageId });
}

/**
 * Technical detail never lands in the admin chat. It goes to the developer bot
 * directly (not via the queue) so a handler failure is visible immediately even
 * when the notification dispatcher is what broke.
 */
async function alertDevelopers(detail: string, context: string) {
  const token = process.env.TELEGRAM_DEV_BOT_TOKEN || "";
  const chat = process.env.TELEGRAM_DEV_CHAT_ID || "";
  if (token && chat) {
    await tgApi(token, "sendMessage", {
      chat_id: chat.split(",")[0].trim(),
      text: ` *Telegram handler failure*\n\`${context}\`\n\`\`\`\n${detail.slice(0, 700)}\n\`\`\``,
      disable_web_page_preview: true,
    });
  }
  await db
    .insert(notifications)
    .values({ channel: "telegram", audience: "dev", recipient: "ops", template: "telegram_handler_failure", payload: { context, detail: detail.slice(0, 500) } })
    .catch(() => undefined);
}

/**
 * Routine status output is noise once read. We keep at most one ephemeral
 * reply per chat: sending a new one deletes the previous one and the command
 * that triggered it. Alerts, errors and destructive confirmations are never
 * ephemeral, so the audit trail survives.
 *
 * Stored in `settings` because it must outlive a serverless invocation.
 */
const keyboardBack = (): Button[][] => [[{ text: "Back", callback_data: "m:home" }]];

/**
 * Two messages stay pinned: the control panel and the dashboard URL.
 * Each kind is tracked separately so re-sending one unpins only its own
 * previous copy — re-sending the panel must not drop the dashboard pin.
 */
async function repin(bot: BotKind, chatId: string, kind: "panel" | "dashboard", messageId: number) {
  const token = tokenFor(bot);
  if (!token) return;
  const key = `tg_pin:${kind}:${chatId}`;

  const [prev] = await db.select().from(settings).where(eq(settings.key, key)).limit(1);
  if (prev?.value) {
    const previousId = Number(prev.value);
    await tgApi(token, "unpinChatMessage", { chat_id: chatId, message_id: previousId });
    // A panel is a replaceable control surface, not an audit record. Removing
    // its predecessor prevents `/panel` retries from leaving a stack of stale
    // keyboards in the operator chat. Failure is harmless (e.g. user removed
    // it first) and must never block the new panel.
    await deleteMessage(bot, chatId, previousId);
  }

  await tgApi(token, "pinChatMessage", { chat_id: chatId, message_id: messageId, disable_notification: true });

  await db
    .insert(settings)
    .values({ key, value: String(messageId) })
    .onConflictDoUpdate({ target: settings.key, set: { value: String(messageId), updatedAt: new Date() } });
}

/**
 * Claims a callback_query id exactly once.
 *
 * Telegram re-delivers an update whenever the webhook is slow or returns a
 * non-2xx, and several of these buttons are not idempotent (restart, relink,
 * approve, pause). Without a claim, one impatient tap could run the same
 * destructive command twice. The insert is the lock: the first caller wins,
 * every retry sees the conflict and is dropped.
 *
 * Fails OPEN. If the settings table is unreachable the operator still gets
 * their command — a dedupe outage must not brick the control plane.
 */
async function claimCallback(callbackId: string): Promise<boolean> {
  try {
    const rows = await db
      .insert(settings)
      .values({ key: `tg_cb:${callbackId}`, value: "1" })
      .onConflictDoNothing()
      .returning({ key: settings.key });
    return rows.length > 0;
  } catch {
    return true;
  }
}

/** Routine status output self-destructs after this long. */
const EPHEMERAL_TTL_MS = 5 * 60 * 1000;

/**
 * Queues a message for automatic deletion.
 *
 * One row per message. The earlier design packed every id for a chat into a
 * single settings row, so a second reply overwrote the first and those
 * messages leaked permanently. QR photos were never queued at all, which is
 * why images accumulated in the chat.
 */
async function expireLater(bot: BotKind, chatId: string, messageIds: Array<number | null | undefined>) {
  const rows = messageIds
    .filter((n): n is number => typeof n === "number" && Number.isFinite(n))
    .map((messageId) => ({
      chatId,
      messageId,
      bot,
      expiresAt: new Date(Date.now() + EPHEMERAL_TTL_MS),
    }));
  if (!rows.length) return;
  await db.insert(telegramEphemeral).values(rows).onConflictDoNothing();
}

/**
 * Deletes queued messages whose TTL has elapsed.
 *
 * Rows are dropped whether or not Telegram accepts the delete: a message the
 * operator removed by hand, or one older than Telegram's 48-hour deletion
 * window, must not be retried forever.
 */
export async function sweepExpiredMessages(): Promise<number> {
  const due = await db
    .select()
    .from(telegramEphemeral)
    .where(lte(telegramEphemeral.expiresAt, new Date()))
    .limit(200);

  let deleted = 0;
  for (const row of due) {
    const rowBot = (row.bot as BotKind) || "admin";
    await deleteMessage(rowBot, row.chatId, row.messageId);
    await db.delete(telegramEphemeral).where(eq(telegramEphemeral.id, row.id));
    deleted += 1;
  }

  // Callback claim tokens are only useful for the length of Telegram's retry
  // window. Dropping them here keeps the settings table from growing forever.
  await db
    .delete(settings)
    .where(and(like(settings.key, "tg_cb:%"), lt(settings.updatedAt, new Date(Date.now() - 60 * 60 * 1000))))
    .catch(() => undefined);

  // An abandoned guided flow (admin opened "Add channel", never confirmed) must
  // not linger. runCommand also expires these after 15 minutes; this clears the
  // row so the settings table stays a control surface and not a graveyard.
  await db
    .delete(settings)
    .where(and(like(settings.key, "tg_pending_channel:%"), lt(settings.updatedAt, new Date(Date.now() - 24 * 60 * 60 * 1000))))
    .catch(() => undefined);

  return deleted;
}

/**
 * Clears the previous round of routine output immediately, so pressing two
 * buttons in a row never stacks two status messages.
 */
async function sweepChatNow(bot: BotKind, chatId: string) {
  const rows = await db
    .select()
    .from(telegramEphemeral)
    .where(and(eq(telegramEphemeral.chatId, chatId), eq(telegramEphemeral.bot, bot)));
  for (const row of rows) {
    await deleteMessage(bot, chatId, row.messageId);
    await db.delete(telegramEphemeral).where(eq(telegramEphemeral.id, row.id));
  }
}

type Update = {
  message?: { message_id?: number; text?: string; chat?: { id?: number | string } };
  edited_message?: { message_id?: number; text?: string; chat?: { id?: number | string } };
  callback_query?: {
    id: string;
    data?: string;
    message?: { message_id?: number; chat?: { id?: number | string } };
  };
};

/**
 * Runs a handler under a ceiling.
 *
 * A button that waits on the WhatsApp reader or a loopback cron call can outrun
 * the request budget, and the admin's phone then shows a spinner with no answer
 * — indistinguishable from a dead bot. Past the ceiling the operator gets a
 * plain status line instead and the update is still acknowledged with 200, so
 * Telegram never retries the same action twice.
 */
async function withinBudget<T>(work: Promise<T>, ms: number): Promise<{ ok: true; value: T } | { ok: false }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const raced = await Promise.race([
      work.then((value) => ({ done: true as const, value })),
      new Promise<{ done: false }>((resolve) => {
        timer = setTimeout(() => resolve({ done: false }), ms);
      }),
    ]);
    return raced.done ? { ok: true, value: raced.value } : { ok: false };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The pinned dashboard is a permanent anchor, so pressing it twice must not
 * stack copies. When the same link is already pinned, the press is answered
 * with a toast and nothing is sent.
 */
async function dashboardAlreadyPinned(chat: string, dedupeKey?: string) {
  if (!dedupeKey) return false;
  const [pinned, seen] = await Promise.all([
    db.select().from(settings).where(eq(settings.key, `tg_pin:dashboard:${chat}`)).limit(1),
    db.select().from(settings).where(eq(settings.key, `tg_pin:dashboard_text:${chat}`)).limit(1),
  ]);
  return Boolean(pinned[0]?.value && seen[0]?.value === dedupeKey);
}

async function rememberDashboardPinned(chat: string, dedupeKey?: string) {
  if (!dedupeKey) return;
  await db
    .insert(settings)
    .values({ key: `tg_pin:dashboard_text:${chat}`, value: dedupeKey })
    .onConflictDoUpdate({ target: settings.key, set: { value: dedupeKey, updatedAt: new Date() } })
    .catch(() => undefined);
}

type CallbackReply = { text: string; keyboard?: Button[][]; photoBase64?: string; ephemeral?: boolean; dedupeKey?: string };

/**
 * Delivers a reply to a button press.
 *
 * The pinned panel is a permanent anchor. Editing it in place would turn it
 * into whatever view was opened, so the operator would lose the control panel
 * while Telegram kept a stale pin. Work therefore happens in a separate
 * throwaway message that is queued for automatic deletion.
 */
async function deliverCallbackReply(
  bot: BotKind,
  chat: string,
  cbMsgId: number,
  reply: CallbackReply,
  command: string,
): Promise<void> {
  const [pin] = await db.select().from(settings).where(eq(settings.key, `tg_pin:panel:${chat}`)).limit(1);
  const pressedOnPanel = pin?.value === String(cbMsgId);

  if (reply.photoBase64) {
    // A QR cannot replace text in place, so it is sent as its own message and
    // the controlling message explains what to do with it. The photo is queued
    // for deletion — a scanned or expired code is pure clutter.
    const photoId = await sendPhoto(bot, chat, reply.photoBase64, reply.text);
    await expireLater(bot, chat, [photoId]);
    if (!pressedOnPanel) {
      // Keep the admin on the step they were working through (verify after
      // scanning) instead of dropping them back to a generic menu.
      await editMessage(
        bot,
        chat,
        cbMsgId,
        "*Pairing code sent above.*\nIt expires in about 60 seconds.",
        reply.keyboard ?? keyboardFor("m:wa"),
      );
    }
    return;
  }

  if (command === "dashboard") {
    if (await dashboardAlreadyPinned(chat, reply.dedupeKey)) return; // already pinned; no duplicate
    const sent = await send(bot, chat, reply.text, reply.keyboard);
    if (typeof sent === "number") {
      await repin(bot, chat, "dashboard", sent);
      await rememberDashboardPinned(chat, reply.dedupeKey);
    }
    return;
  }

  if (pressedOnPanel) {
    // Clear the previous working message so only one is ever open.
    await sweepChatNow(bot, chat);
    const sent = await send(bot, chat, reply.text, reply.keyboard ?? keyboardBack());
    await expireLater(bot, chat, [sent]);
    return;
  }

  await editMessage(bot, chat, cbMsgId, reply.text, reply.keyboard ?? keyboardBack());
  // Keep the working message on the deletion clock as it is reused.
  await expireLater(bot, chat, [cbMsgId]);
}

/**
 * Shared handler. `/api/telegram/webhook` calls it with "admin";
 * `/api/telegram/webhook/dev` calls it with "dev".
 *
 * The wrapper guarantees a 200 and a developer alert for anything unexpected:
 * a non-2xx makes Telegram redeliver the same update aggressively, so an
 * internal error must never turn into a retry storm — and must never print a
 * stack trace into an admin's chat.
 */
export async function handleUpdate(request: Request, bot: BotKind) {
  try {
    return await processUpdate(request, bot);
  } catch (e) {
    await alertDevelopers(e instanceof Error ? (e.stack ?? e.message) : String(e), "update dispatch");
    return NextResponse.json({ ok: true }, { status: 200 });
  }
}

async function processUpdate(request: Request, bot: BotKind) {
  // Layer 1 — prove the call came from Telegram, not the open internet.
  const expected = secretFor(bot);
  if (expected && request.headers.get("x-telegram-bot-api-secret-token") !== expected) {
    return NextResponse.json({ ok: true }, { status: 200 });
  }

  let update: Update;
  try {
    update = (await request.json()) as Update;
  } catch {
    return NextResponse.json({ ok: true });
  }

  // ── button press ────────────────────────────────────────────────────────
  // Callbacks edit the existing message in place, so a whole operations
  // session lives in one message instead of a wall of replies.
  const cb = update.callback_query;
  if (cb) {
    const cbChat = cb.message?.chat?.id;
    const cbMsgId = cb.message?.message_id;
    if (!allowedFor(bot).includes(String(cbChat ?? "")) || cbMsgId === undefined) {
      await answerCallback(bot, cb.id, "Not authorised.");
      return NextResponse.json({ ok: true });
    }
    const chat = String(cbChat);
    const data = cb.data ?? "";
    // Answer first — Telegram allows ~10s and an unanswered callback leaves the
    // button visibly stuck. Anything that touches the network also carries a
    // one-line acknowledgement, so the admin knows the tap registered.
    await answerCallback(bot, cb.id, isSlowAction(data) ? "⏳ On it…" : undefined);
    // Then make sure this is the first (and only) time we act on it.
    if (!(await claimCallback(cb.id))) return NextResponse.json({ ok: true });
    const [command, ...cbArgs] = data.split(":").length > 1 && data.startsWith("m:") ? [data || "m:home"] : data.split(" ");

    const outcome = await withinBudget(runCommand(command, cbArgs, chat, bot), HANDLER_BUDGET_MS);
    if (!outcome.ok) {
      // The handler is still running somewhere; say so rather than going silent.
      await deliverCallbackReply(bot, chat, cbMsgId, {
        text: "⏳ *That is taking longer than usual.*\n\nIt may still finish — check *Sync status* in a moment. Nothing was left half-applied.",
        keyboard: keyboardFor("m:home"),
      }, command);
      await alertDevelopers(`timeout after ${HANDLER_BUDGET_MS}ms`, `callback ${command}`);
      return NextResponse.json({ ok: true });
    }

    try {
      await deliverCallbackReply(bot, chat, cbMsgId, outcome.value, command);
    } catch (e) {
      // The admin gets the fact, the developer gets the detail. Raw error text
      // from a supplier title or a transport failure is never shown to a phone.
      await deliverCallbackReply(bot, chat, cbMsgId, {
        text: "⚠️ *That action did not complete.*\n\nNo change was left half-applied. Try again, or use the dashboard.",
        keyboard: keyboardFor("m:home"),
      }, command);
      await alertDevelopers(e instanceof Error ? (e.stack ?? e.message) : String(e), `callback ${command}`);
    }
    return NextResponse.json({ ok: true });
  }

  const msg = update.message ?? update.edited_message;
  const chatId = msg?.chat?.id;
  if (chatId === undefined || chatId === null) return NextResponse.json({ ok: true });

  // Layer 2 — only chat ids configured for THIS bot may drive it.
  if (!allowedFor(bot).includes(String(chatId))) {
    await send(bot, String(chatId), "Not authorised.");
    return NextResponse.json({ ok: true });
  }

  const chatStr = String(chatId);
  const parsed = parseCommand(msg?.text);

  if (!parsed) {
    // Order source routing. A customer's WhatsApp order carries the SKU, so
    // pasting or forwarding that message here resolves which supplier group
    // fulfils it. Matching on the text means no command has to be memorised.
    const hit = (msg?.text ?? "").match(SKU_PATTERN);
    if (hit) {
      const reply = await lookupSku(hit[0]);
      await send(bot, chatStr, reply.text);
      return NextResponse.json({ ok: true });
    }
    await send(bot, chatStr, "Paste a product SKU to see which supplier fulfils it, or open the pinned *Admin Control Panel*.");
    return NextResponse.json({ ok: true });
  }

  const chat = chatStr;
  try {
    // Clear the last round of routine output before adding more.
    await sweepChatNow(bot, chat);

    const outcome = await withinBudget(runCommand(parsed.command, parsed.args, chat, bot), HANDLER_BUDGET_MS);
    if (!outcome.ok) {
      await send(bot, chat, "⏳ *That is taking longer than usual.*\n\nCheck *Sync status* in a moment — nothing was left half-applied.", keyboardBack());
      await alertDevelopers(`timeout after ${HANDLER_BUDGET_MS}ms`, `command /${parsed.command}`);
      return NextResponse.json({ ok: true });
    }
    const reply = outcome.value;

    const sent = reply.photoBase64
      ? await sendPhoto(bot, chat, reply.photoBase64, reply.text)
      : await send(bot, chat, reply.text, reply.keyboard);

    // Panel and dashboard are the two permanent anchors.
    if (!reply.ephemeral && typeof sent === "number") {
      if (["panel", "help", "start"].includes(parsed.command)) await repin(bot, chat, "panel", sent);
      if (parsed.command === "dashboard") {
        await repin(bot, chat, "dashboard", sent);
        await rememberDashboardPinned(chat, reply.dedupeKey);
      }
    }

    // Queue routine output and the command that produced it. Photos are always
    // queued regardless of the ephemeral flag: a stale QR is never useful.
    if (reply.ephemeral || reply.photoBase64) {
      await expireLater(bot, chat, [sent, msg?.message_id]);
    }
  } catch (e) {
    await send(bot, chat, "⚠️ *That command did not complete.* Try again, or use the dashboard.", keyboardBack());
    await alertDevelopers(e instanceof Error ? (e.stack ?? e.message) : String(e), `command /${parsed.command}`);
  }

  return NextResponse.json({ ok: true });
}

export async function POST(request: Request) {
  return handleUpdate(request, "admin");
}
