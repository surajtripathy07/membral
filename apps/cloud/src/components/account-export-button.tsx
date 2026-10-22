"use client";

// "Export my data" (issue #22 / truthfulness audit F8) — downloads the
// account's full server-side record (conversations with messages, extracted
// memories, profile basics) from GET /api/account/export. Bearer-token
// authed, same pattern as ApiKeyManager.
//
// Round-5 verification BLOCKER 1: the route now streams NDJSON (one JSON
// object per line, paginated server-side) instead of buffering one JSON
// blob — fixes silent truncation past 1000 rows and the Vercel response-body
// cap. `res.blob()` below still works unchanged against a streamed response
// (it reads the stream to completion either way); only the file extension/
// MIME type and the help text changed.
import { useState } from "react";

export function AccountExportButton({ accessToken }: { accessToken: string }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleExport() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/account/export", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? "Export failed");
      }
      const disposition = res.headers.get("content-disposition") ?? "";
      const match = disposition.match(/filename="([^"]+)"/);
      const filename = match?.[1] ?? "membral-export.ndjson";
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={handleExport}
        disabled={loading}
        className="rounded-sm border border-line-strong hover:border-ink disabled:opacity-50 text-ink px-4 py-2 text-sm font-medium transition-colors"
      >
        {loading ? "Preparing export…" : "Export my data"}
      </button>
      <p className="text-xs text-muted">
        Downloads an NDJSON file (one JSON record per line) with your conversations (messages
        included), extracted memories, and profile basics.
      </p>
      {error && <p className="text-sm text-error">{error}</p>}
    </div>
  );
}
