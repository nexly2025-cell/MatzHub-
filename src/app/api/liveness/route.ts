import { NextResponse } from "next/server";

/**
 * Liveness — is the process alive? No DB query. If this fails, restart the pod.
 */
export const dynamic = "force-dynamic";
export async function GET() {
  return NextResponse.json({ status: "alive", ts: new Date().toISOString() });
}
