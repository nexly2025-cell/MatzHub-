import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { ADMIN_COOKIE, CSRF_COOKIE, adminPassword, issueToken, persistAdminSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

async function login(formData: FormData) {
  "use server";
  const pw = String(formData.get("password") ?? "");
  const next = String(formData.get("next") || "/admin");
  if (pw !== adminPassword()) redirect(`/admin/login?error=1&next=${encodeURIComponent(next)}`);

  const token = await issueToken();
  const csrf = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  const h = await headers();
  await persistAdminSession(token, csrf, {
    ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    userAgent: h.get("user-agent"),
  });

  const jar = await cookies();
  const secure = process.env.NODE_ENV === "production";
  // Issue 8 — 24h httpOnly session + CSRF cookie (double-submit).
  jar.set(ADMIN_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure,
    maxAge: 60 * 60 * 24,
  });
  jar.set(CSRF_COOKIE, csrf, {
    httpOnly: false,
    sameSite: "strict",
    path: "/",
    secure,
    maxAge: 60 * 60 * 24,
  });
  redirect(next.startsWith("/admin") ? next : "/admin");
}

export default async function Login({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const next = typeof sp.next === "string" ? sp.next : "/admin";
  return (
    <div className="grid min-h-screen place-items-center px-4">
      <form action={login} className="surface w-full max-w-sm p-8">
        <div className="display mb-1 text-2xl">
          Matz<span className="gold-text">Hub</span>
        </div>
        <p className="eyebrow mb-6">Operations access</p>
        <input type="hidden" name="next" value={next} />
        <label htmlFor="pw" className="mb-1.5 block text-xs text-muted">
          Password
        </label>
        <input id="pw" name="password" type="password" className="field" autoFocus required autoComplete="current-password" />
        {sp.error && (
          <p role="alert" className="mt-3 text-xs text-[--color-rose]">
            Incorrect password.
          </p>
        )}
        <button className="btn btn-primary mt-5 w-full">Sign in</button>
        <p className="mt-4 text-center text-[11px] text-subtle">Sessions expire after 24 hours. Set ADMIN_PASSWORD in your environment.</p>
      </form>
    </div>
  );
}
