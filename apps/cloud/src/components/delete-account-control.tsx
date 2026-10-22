"use client";

// "Delete my account" (issue #22 / truthfulness audit F7) — requires typing
// DELETE before the button enables, then POSTs { confirmation: "DELETE" } to
// /api/account/delete (which does the same check server-side — see that
// route's header comment for the cascade-delete audit). On success, signs
// out client-side (the account — and its session — no longer exist server
// side either way) and sends the browser to "/".
import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

export function DeleteAccountControl({ accessToken }: { accessToken: string }) {
  const [confirmText, setConfirmText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canDelete = confirmText === "DELETE";

  async function handleDelete() {
    if (!canDelete || loading) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/account/delete", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ confirmation: "DELETE" }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? "Could not delete account");
      }
      const supabase = createClient();
      await supabase.auth.signOut();
      window.location.href = "/";
    } catch (e) {
      setError((e as Error).message);
      setLoading(false);
    }
  }

  return (
    <div className="space-y-3 rounded-card border border-error bg-surface p-5">
      <h3 className="text-sm font-semibold text-error">Delete my account</h3>
      <p className="text-xs text-muted">
        Permanently deletes your account and everything tied to it — conversations, memories, API
        keys, device sign-ins. This can&apos;t be undone. Consider exporting your data first.
      </p>
      <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
        <label htmlFor="delete-confirm" className="text-xs text-muted shrink-0">
          Type <span className="font-mono text-ink">DELETE</span> to confirm:
        </label>
        <input
          id="delete-confirm"
          type="text"
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
          className="rounded-sm border border-line bg-surface px-2 py-1 text-sm text-ink font-mono w-32"
        />
      </div>
      <button
        type="button"
        onClick={handleDelete}
        disabled={!canDelete || loading}
        className="rounded-sm border border-error text-error hover:bg-error hover:text-canvas disabled:opacity-40 disabled:cursor-not-allowed px-4 py-2 text-sm font-medium transition-colors"
      >
        {loading ? "Deleting…" : "Delete my account"}
      </button>
      {error && <p className="text-sm text-error">{error}</p>}
    </div>
  );
}
