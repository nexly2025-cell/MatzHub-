import { NextResponse } from "next/server";
import { db } from "@/db";
import { automationRuns } from "@/db/schema";
import { ingestBatch, type RawMessage } from "@/lib/ingest";
import { isMaintenanceMode } from "@/lib/telegram";

/**
 * Ingestion webhook.
 * The WhatsApp worker (Baileys / WA Cloud API) POSTs raw messages here.
 * Auth: shared bearer token. Idempotent by messageId.
 */
function authorized(request: Request) {
  const expected = process.env.INGEST_TOKEN;
  // Fails closed: an unset token used to leave the ingestion webhook open to
  // anyone, allowing arbitrary products to be injected into the catalogue.
  if (!expected) return process.env.NODE_ENV === "development";
  const header = request.headers.get("authorization") ?? "";
  return header === `Bearer ${expected}`;
}

export async function POST(request: Request) {
  if (!authorized(request)) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  // Maintenance mode is a hard stop. 503 makes the worker retry later rather
  // than treat the message as consumed, so nothing is lost.
  if (await isMaintenanceMode()) {
    return NextResponse.json({ ok: false, error: "maintenance_mode" }, { status: 503 });
  }

  // Parse the body exactly once. `Request.json()` consumes the body stream, so
  // any second call throws. Downstream isolation and ingestion both read this.
  let payload: { messages?: RawMessage[] } | RawMessage;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }

  const messages: RawMessage[] = Array.isArray((payload as { messages?: RawMessage[] }).messages)
    ? (payload as { messages: RawMessage[] }).messages
    : [payload as RawMessage];

  // Hard isolation: WhatsApp group JIDs, not phone-number suffixes, are the
  // authoritative source boundary. The worker applies the same allow-list.
  const allowedGroupIds = (process.env.WA_GROUP_IDS ?? "").split(",").map((group) => group.trim()).filter(Boolean);
  if (process.env.NODE_ENV === "production" && !allowedGroupIds.length) {
    return NextResponse.json({ ok: false, error: "ingestion_group_allowlist_unconfigured" }, { status: 503 });
  }
  if (allowedGroupIds.length) {
    for (const message of messages) {
      const groupId = message && typeof message === "object" ? (message as { groupId?: string }).groupId : "";
      if (!groupId || !allowedGroupIds.includes(groupId)) {
        return NextResponse.json({ ok: false, error: "group_not_authorized" }, { status: 403 });
      }
    }
  }

  const clean = messages.filter((m) => m && typeof m.messageId === "string").slice(0, 200);
  if (!clean.length) return NextResponse.json({ ok: false, error: "No valid messages" }, { status: 400 });

  const t0 = Date.now();
  const results = await ingestBatch(clean);
  const stages = results.reduce<Record<string, number>>((a, r) => ({ ...a, [r.stage]: (a[r.stage] ?? 0) + 1 }), {});

  await db.insert(automationRuns).values({
    job: "ingest",
    status: results.some((r) => r.stage === "failed") ? "partial" : "ok",
    processed: results.length,
    succeeded: results.filter((r) => r.stage === "published").length,
    failed: results.filter((r) => r.stage === "failed").length,
    durationMs: Date.now() - t0,
    detail: { stages },
    finishedAt: new Date(),
  });

  return NextResponse.json({ ok: true, processed: results.length, stages, results });
}
