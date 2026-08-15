import { NextResponse, type NextRequest } from "next/server";
import { ADMIN_COOKIE, RESELLER_COOKIE, verifyAdminToken, verifyResellerToken } from "@/lib/auth";

/**
 * Edge auth gate for the two private surfaces.
 *
 *   /admin/*             requires a valid "ops" token       (ADMIN_COOKIE)
 *   /reseller/dashboard  requires a valid "reseller:" token (RESELLER_COOKIE)
 *
 * The two scopes are deliberately separate: an admin token must not unlock the
 * reseller dashboard and a reseller token must never unlock /admin. Each page
 * keeps its own check as defence in depth; this gate exists so unauthenticated
 * traffic is turned away with a real 307 before any server rendering happens.
 *
 * Next 16 renamed the "middleware" convention to "proxy". This file MUST live
 * at `src/proxy.ts` and MUST export a function named `proxy`; see
 * https://nextjs.org/docs/messages/middleware-to-proxy. Renaming either the
 * file or the function silently disables the gate.
 */
export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const isReseller = pathname.startsWith("/reseller/dashboard");
  const authed = isReseller
    ? Boolean(await verifyResellerToken(request.cookies.get(RESELLER_COOKIE)?.value))
    : await verifyAdminToken(request.cookies.get(ADMIN_COOKIE)?.value);

  const response = authed
    ? NextResponse.next()
    : (() => {
        const url = request.nextUrl.clone();
        url.pathname = isReseller ? "/reseller/login" : "/admin/login";
        url.search = "";
        url.searchParams.set("next", pathname);
        return NextResponse.redirect(url);
      })();

  response.headers.set("x-trace-id", crypto.randomUUID());
  return response;
}

export const config = {
  // /admin/login is excluded so the login form itself stays reachable.
  matcher: ["/admin/:path((?!login$).*)", "/admin", "/reseller/dashboard/:path*"],
};
