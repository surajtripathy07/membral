"use client";

import { useState } from "react";
import { ShowAll } from "@/components/ui/show-all";
import { formatDateTimeUtc } from "@/lib/format/dates";

export interface DeviceKeyRow {
  id: string;
  prefix: string;
  label: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  revoked: boolean;
}

interface DeviceKeysListProps {
  initialKeys: DeviceKeyRow[];
  accessToken: string;
}

// Deterministic (UTC, fixed format) — NEVER toLocaleString/toLocaleDateString
// here: `initialKeys` arrives as a prop from settings/page.tsx (an async
// Server Component), so it's populated on BOTH the SSR render and the very
// first client hydration render (unlike a client-fetched-after-mount list,
// which is empty on both passes and so never actually hits this diff).
// `toLocaleString(undefined, ...)` resolves the runtime's default
// locale/timezone, which differs between Node (SSR) and the browser
// (hydration) and produces a React hydration mismatch — this was live on
// /code/[projectId]'s session rows for the same reason; see
// lib/format/dates.ts's formatAbsoluteUtc for the sibling fix.

export function DeviceKeysList({ initialKeys, accessToken }: DeviceKeysListProps) {
  const [keys, setKeys] = useState(initialKeys);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  async function revoke(id: string) {
    setRevokingId(id);
    try {
      const res = await fetch(`/api/keys/devices/${id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (res.ok) {
        setKeys((prev) => prev.map((k) => (k.id === id ? { ...k, revoked: true } : k)));
      }
    } finally {
      setRevokingId(null);
    }
  }

  if (keys.length === 0) {
    return (
      <p className="text-sm text-muted">
        No device keys yet — approve a <code className="font-mono">membral setup</code> sign-in from the{" "}
        <a href="/device" className="text-accent hover:underline">
          device page
        </a>{" "}
        to see one here. Needs the CLI —{" "}
        <a href="/setup" className="text-accent hover:underline">
          see Setup
        </a>
        .
      </p>
    );
  }

  // UX audit B9 (/settings route table, "Device sign-ins"): cap at 3, then
  // "+N" — an account with many CLI sign-ins used to push everything below
  // it (Context card, Account, Delete) down the page.
  return (
    <ShowAll
      items={keys}
      initial={3}
      label={(n) => `+${n} more device${n === 1 ? "" : "s"}`}
      className="divide-y divide-line-soft"
      renderItem={(k) => (
        <div
          key={k.id}
          className="flex items-center justify-between gap-3 py-2 first:pt-0"
        >
          <div className="min-w-0 space-y-0.5">
            <div className="flex items-center gap-2">
              <code className="font-mono text-sm text-ink-2">{k.prefix}…</code>
              {k.label && <span className="truncate text-sm text-muted">{k.label}</span>}
              {k.revoked && (
                <span className="rounded-xs border border-line px-1.5 py-0.5 text-xs text-muted">Revoked</span>
              )}
            </div>
            <p className="text-xs text-muted">
              Created {formatDateTimeUtc(k.createdAt)} · Last used {formatDateTimeUtc(k.lastUsedAt)}
            </p>
          </div>
          {!k.revoked && (
            <button
              type="button"
              onClick={() => revoke(k.id)}
              disabled={revokingId === k.id}
              className="shrink-0 rounded-sm border border-line-strong px-3 py-1.5 text-xs font-medium text-error hover:border-error transition-colors disabled:opacity-50"
            >
              {revokingId === k.id ? "Revoking…" : "Revoke"}
            </button>
          )}
        </div>
      )}
    />
  );
}
