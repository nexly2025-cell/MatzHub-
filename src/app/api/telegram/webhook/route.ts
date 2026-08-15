import { NextResponse } from "next/server";
import { eq, lte } from "drizzle-orm";
import { db } from "@/db";
import { settings, telegramEphemeral } from "@/db/schema";
import { keyboardFor, lookupSku, parseCommand, runCommand, SKU_PATTERN, type Button } from "@/lib/telegram";

export const dynamic = "force-dynamic";

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

async function send(bot: BotKind, chatId: string, text: string, keyboard?: Button[][]): Promise<number | null> {
  const token = tokenFor(bot);
  if (!token) return null;
  const post = (body: Record<string, unknown>) =>
    fetch(API(token, "sendMessage"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  const idOf = async (r: Response) => {
    const d = (await r.json().catch(() => ({}))) as { ok?: boolean; result?: { message_id?: number } };
    return d.ok ? (d.result?.message_id ?? null) : null;
  };

  try {
    const markup = keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {};
    const res = await post({ chat_id: chatId, text, parse_mode: "Markdown", disable_web_page_preview: true, ...markup });
    if (res.ok) return idOf(res);
    // Legacy Markdown rejects unbalanced _ * [ ` which can appear in supplier
    // titles and driver error strings. Rather than silently dropping the reply,
    // resend it as plain text so the operator always gets the information.
    return idOf(await post({ chat_id: chatId, text, disable_web_page_preview: true, ...markup }));
  } catch {
    return null; /* transport down — nothing useful we can do from here */
  }
}

async function sendPhoto(bot: BotKind, chatId: string, base64: string, caption: string): Promise<number | null> {
  const token = tokenFor(bot);
  if (!token) return null;
  const form = new FormData();
  form.append("chat_id", chatId);
  form.append("caption", caption);
  form.append("parse_mode", "Markdown");
  form.append("photo", new Blob([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], { type: "image/png" }), "qr.png");
  try {
    const r = await fetch(API(token, "sendPhoto"), { method: "POST", body: form });
    const d = (await r.json().catch(() => ({}))) as { ok?: boolean; result?: { message_id?: number } };
    return d.ok ? (d.result?.message_id ?? null) : null;
  } catch {
    return null;
  }
}

async function editMessage(bot: BotKind, chatId: string, messageId: number, text: string, keyboard?: Button[][]) {
  const token = tokenFor(bot);
  if (!token) return;
  const body: Record<string, unknown> = {
    chat_id: chatId, message_id: messageId, text,
    parse_mode: "Markdown", disable_web_page_preview: true,
    ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
  };
  const r = await fetch(API(token, "editMessageText"), {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }).catch(() => null);
  // Markdown can be rejected by supplier titles and driver errors; retry plain
  // so the operator still sees the result rather than a stale screen.
  if (r && !r.ok) {
    delete body.parse_mode;
    await fetch(API(token, "editMessageText"), {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }).catch(() => undefined);
  }
}

/** Clears the button's loading spinner. Required by the Bot API. */
async function answerCallback(bot: BotKind, id: string, text?: string) {
  const token = tokenFor(bot);
  if (!token) return;
  await fetch(API(token, "answerCallbackQuery"), {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: id, ...(text ? { text } : {}) }),
  }).catch(() => undefined);
}

async function deleteMessage(bot: BotKind, chatId: string, messageId: number) {
  const token = tokenFor(bot);
  if (!token) return;
  await fetch(API(token, "deleteMessage"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
  }).catch(() => undefined);
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
    await fetch(API(token, "unpinChatMessage"), {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, message_id: Number(prev.value) }),
    }).catch(() => undefined);
  }

  await fetch(API(token, "pinChatMessage"), {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, disable_notification: true }),
  }).catch(() => undefined);

  await db
    .insert(settings)
    .values({ key, value: String(messageId) })
    .onConflictDoUpdate({ target: settings.key, set: { value: String(messageId), updatedAt: new Date() } });
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
async function expireLater(chatId: string, messageIds: Array<number | null | undefined>) {
  const rows = messageIds
    .filter((n): n is number => typeof n === "number" && Number.isFinite(n))
    .map((messageId) => ({
      chatId,
      messageId,
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
export async function sweepExpiredMessages(bot: BotKind = "admin"): Promise<number> {
  const due = await db
    .select()
    .from(telegramEphemeral)
    .where(lte(telegramEphemeral.expiresAt, new Date()))
    .limit(200);

  let deleted = 0;
  for (const row of due) {
    await deleteMessage(bot, row.chatId, row.messageId);
    await db.delete(telegramEphemeral).where(eq(telegramEphemeral.id, row.id));
    deleted += 1;
  }
  return deleted;
}

/**
 * Clears the previous round of routine output immediately, so pressing two
 * buttons in a row never stacks two status messages.
 */
async function sweepChatNow(bot: BotKind, chatId: string) {
  const rows = await db.select().from(telegramEphemeral).where(eq(telegramEphemeral.chatId, chatId));
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
 * Shared handler. `/api/telegram/webhook` calls it with "admin";
 * `/api/telegram/webhook/dev` calls it with "dev".
 */
export async function handleUpdate(request: Request, bot: BotKind) {
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
    await answerCallback(bot, cb.id);
    const [command, ...cbArgs] = (cb.data ?? "").split(":").length > 1 && (cb.data ?? "").startsWith("m:")
      ? [cb.data ?? "m:home"]
      : (cb.data ?? "").split(" ");
    try {
      const reply = await runCommand(command, cbArgs, chat, bot);

      // The pinned panel is a permanent anchor. Editing it in place turns it
      // into whatever view was opened, so the operator loses the control panel
      // and Telegram keeps a stale pin. Work happens in a separate throwaway
      // message that is queued for automatic deletion.
      const [pin] = await db.select().from(settings).where(eq(settings.key, `tg_pin:panel:${chat}`)).limit(1);
      const pressedOnPanel = pin?.value === String(cbMsgId);

      if (reply.photoBase64) {
        // A QR cannot replace text in place, so it is sent as its own message
        // and the controlling message explains what to do with it. The photo
        // is queued for deletion — a scanned or expired code is pure clutter.
        const photoId = await sendPhoto(bot, chat, reply.photoBase64, reply.text);
        await expireLater(chat, [photoId]);
        if (!pressedOnPanel) {
          await editMessage(bot, chat, cbMsgId, "*Pairing code sent above.*\nIt expires in about 60 seconds.", keyboardFor("m:wa"));
        }
      } else if (command === "dashboard") {
        // Pinned separately from the panel, so it is always sent, never edited.
        const sent = await send(bot, chat, reply.text, reply.keyboard);
        if (typeof sent === "number") await repin(bot, chat, "dashboard", sent);
      } else if (pressedOnPanel) {
        // Clear the previous working message so only one is ever open.
        await sweepChatNow(bot, chat);
        const sent = await send(bot, chat, reply.text, reply.keyboard ?? keyboardBack());
        await expireLater(chat, [sent]);
      } else {
        await editMessage(bot, chat, cbMsgId, reply.text, reply.keyboard ?? keyboardBack());
        // Keep the working message on the deletion clock as it is reused.
        await expireLater(chat, [cbMsgId]);
      }
    } catch (e) {
      // Failures are never ephemeral: they are the record of what went wrong.
      await send(bot, chat, `Failed:\n\`${e instanceof Error ? e.message : "unknown"}\``, keyboardBack());
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

    const reply = await runCommand(parsed.command, parsed.args, chat, bot);
    const sent = reply.photoBase64
      ? await sendPhoto(bot, chat, reply.photoBase64, reply.text)
      : await send(bot, chat, reply.text, reply.keyboard);

    // Panel and dashboard are the two permanent anchors.
    if (!reply.ephemeral && typeof sent === "number") {
      if (["panel", "help", "start"].includes(parsed.command)) await repin(bot, chat, "panel", sent);
      if (parsed.command === "dashboard") await repin(bot, chat, "dashboard", sent);
    }

    // Queue routine output and the command that produced it. Photos are always
    // queued regardless of the ephemeral flag: a stale QR is never useful.
    if (reply.ephemeral || reply.photoBase64) {
      await expireLater(chat, [sent, msg?.message_id]);
    }
  } catch (e) {
    await send(bot, chat, `Command failed:\n\`${e instanceof Error ? e.message : "unknown error"}\``);
  }

  return NextResponse.json({ ok: true });
}

export async function POST(request: Request) {
  return handleUpdate(request, "admin");
}
