"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useState } from "react";

export default function ResellerLogin() {
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const router = useRouter();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/reseller-auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone, name }),
      });
      const data = (await res.json()) as { ok: boolean; error?: string };
      if (!res.ok || !data.ok) {
        setError(data.error || "Could not authenticate");
        setBusy(false);
        return;
      }
      router.push("/reseller/dashboard");
    } catch {
      setError("Something went wrong. Refresh and try again.");
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-[70vh] place-items-center px-4 py-12">
      <form onSubmit={submit} className="surface w-full max-w-sm p-6">
        <div className="mb-2 flex items-center gap-2.5">
          <Image src="/web-app-manifest-512x512.png" alt="MatzHub" width={30} height={30} className="rounded" />
          <p className="eyebrow">Reseller access</p>
        </div>
        <h1 className="font-display text-2xl text-ink">Private channel</h1>
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-muted">
          Verified resellers get margin data, a private catalogue view, and order attribution. If this is your first
          time, we&apos;ll set the account up in one step.
        </p>
        <div className="mt-5 space-y-3">
          <div>
            <label htmlFor="rl-name" className="field-label">Business name</label>
            <input id="rl-name" className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder="Your shop name" />
          </div>
          <div>
            <label htmlFor="rl-phone" className="field-label">WhatsApp number</label>
            <input id="rl-phone" className="field" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="91XXXXXXXXXX" type="tel" required />
          </div>
        </div>
        {error && <p role="alert" className="mt-3 text-[12px] text-danger">{error}</p>}
        <button className="btn btn-solid mt-5 w-full" disabled={busy}>
          {busy ? "Verifying…" : "Continue"}
        </button>
        <p className="mt-4 text-center text-[11px] text-muted">
          Access is reviewed against active selling channels. The number you use for orders matters.
        </p>
      </form>
    </div>
  );
}
