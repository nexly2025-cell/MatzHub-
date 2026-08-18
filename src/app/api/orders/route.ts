import { NextResponse } from "next/server";
import { createCustomerOrder, OrderRequestError, type CreateOrderInput } from "@/lib/orders";
import { clientKey, rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Customer order-request endpoint. It does not take payment. */
export async function POST(request: Request) {
  const requestOrigin = request.headers.get("origin");
  if (requestOrigin && requestOrigin !== new URL(request.url).origin) {
    return NextResponse.json({ ok: false, error: "invalid_origin" }, { status: 403 });
  }

  const limit = rateLimit(`order-submit:${clientKey(request)}`, { max: 5, windowMs: 60 * 60 * 1000 });
  if (!limit.ok) {
    return NextResponse.json(
      { ok: false, error: "Too many order attempts. Please wait a few minutes before trying again." },
      { status: 429, headers: { "Retry-After": String(Math.ceil(limit.resetIn / 1000)) } },
    );
  }

  let payload: Omit<CreateOrderInput, "anonId">;
  try {
    payload = (await request.json()) as Omit<CreateOrderInput, "anonId">;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  try {
    const order = await createCustomerOrder({
      ...payload,
      anonId: request.headers.get("x-mh-anon")?.trim() ?? "",
    });
    return NextResponse.json({ ok: true, ...order }, { status: order.created ? 201 : 200 });
  } catch (error) {
    if (error instanceof OrderRequestError) {
      return NextResponse.json({ ok: false, error: error.message, code: error.code }, { status: error.status });
    }
    return NextResponse.json({ ok: false, error: "We could not submit your order. Please try again." }, { status: 500 });
  }
}
