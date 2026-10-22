"use client";

import { useState } from "react";
import { NodePicker } from "@/components/second-brain/node-picker";
import type { PickerNode } from "@/lib/second-brain/edit-targets";

interface LifeAreaOption {
  id: string;
  label: string;
}

interface CodeProjectOption {
  id: string;
  label: string;
}

interface ApiKeyManagerProps {
  initialPrefix: string | null;
  /** Area scope of the stored key: null = all of my memories, else a LifeArea id. */
  initialScopeNodeId: string | null;
  /** Code-project scope of the stored key (ADR 0021 Q7): null, else a code_projects.id. */
  initialScopeCodeProjectId: string | null;
  /** LifeAreas available as scope options (reuses the #60 node picker). */
  lifeAreas: LifeAreaOption[];
  /** Code projects available as scope options (ADR 0021 Q7). */
  codeProjects: CodeProjectOption[];
  accessToken: string;
  /** Optional callback fired with the freshly generated key (only available once). */
  onGenerated?: (key: string) => void;
}

// A key is area-scoped XOR code-project-scoped XOR unscoped (single-scope
// model). We model the current selection as one tagged value so the UI can
// never present "both" — the same invariant the server + DB enforce.
type Scope = { kind: "all" } | { kind: "area"; id: string } | { kind: "code"; id: string };

const ALL: Scope = { kind: "all" };

function sameScope(a: Scope, b: Scope): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "all" || b.kind === "all") return a.kind === b.kind;
  return a.id === b.id;
}

export function ApiKeyManager({
  initialPrefix,
  initialScopeNodeId,
  initialScopeCodeProjectId,
  lifeAreas,
  codeProjects,
  accessToken,
  onGenerated,
}: ApiKeyManagerProps) {
  const initialScope: Scope = initialScopeNodeId
    ? { kind: "area", id: initialScopeNodeId }
    : initialScopeCodeProjectId
      ? { kind: "code", id: initialScopeCodeProjectId }
      : ALL;

  // The freshly-minted API key is only available in the browser at generation
  // time — held in client state so the MCP config snippet can include it.
  const [prefix, setPrefix] = useState(initialPrefix);
  const [savedScope, setSavedScope] = useState<Scope>(initialScope);
  const [chosenScope, setChosenScope] = useState<Scope>(initialScope);
  const [fullKey, setFullKey] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  const displayKey = fullKey
    ? revealed
      ? fullKey
      : `${fullKey.slice(0, 8)}${"*".repeat(24)}`
    : prefix
      ? `${prefix}${"*".repeat(24)}`
      : null;

  const labelFor = (scope: Scope): string => {
    if (scope.kind === "all") return "All of my memories";
    if (scope.kind === "area") return lifeAreas.find((a) => a.id === scope.id)?.label ?? "Unknown area";
    return codeProjects.find((p) => p.id === scope.id)?.label ?? "Unknown code project";
  };

  // LifeAreas only, mapped to the shared picker's node shape (issue #60 reuse).
  const pickerNodes: PickerNode[] = lifeAreas.map((a) => ({
    id: a.id,
    label: a.label,
    type: "LifeArea",
    kind: null,
    parent_id: null,
  }));

  async function generate() {
    setLoading(true);
    try {
      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          scope_node_id: chosenScope.kind === "area" ? chosenScope.id : null,
          scope_code_project_id: chosenScope.kind === "code" ? chosenScope.id : null,
        }),
      });
      if (!res.ok) throw new Error("Failed to generate key");
      const data = await res.json();
      setFullKey(data.api_key);
      setPrefix(data.api_key.slice(0, 8));
      setSavedScope(chosenScope);
      setRevealed(true);
      onGenerated?.(data.api_key);
    } finally {
      setLoading(false);
    }
  }

  async function revoke() {
    setLoading(true);
    try {
      const res = await fetch("/api/keys", {
        method: "DELETE",
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) throw new Error("Failed to revoke key");
      setFullKey(null);
      setPrefix(null);
      setRevealed(false);
      setSavedScope(ALL);
      setChosenScope(ALL);
    } finally {
      setLoading(false);
    }
  }

  function handleCopy() {
    if (fullKey) {
      navigator.clipboard.writeText(fullKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  const scopeChanged = !sameScope(chosenScope, savedScope);

  return (
    <div className="space-y-3">
      {displayKey ? (
        <div className="space-y-1.5">
          {!fullKey && <p className="text-xs text-muted">Active key</p>}
          <div className="flex items-center gap-3">
            <code className="flex-1 rounded-sm bg-sunken border border-line px-4 py-2.5 text-sm font-mono text-ink-2">
              {displayKey}
            </code>
            {fullKey && (
              <>
                <button
                  onClick={() => setRevealed(!revealed)}
                  className="rounded-sm border border-line-strong px-3 py-2 text-sm text-ink-2 hover:text-ink hover:border-ink transition-colors"
                >
                  {revealed ? "Hide" : "Reveal"}
                </button>
                <button
                  onClick={handleCopy}
                  className="rounded-sm border border-line-strong px-3 py-2 text-sm text-ink-2 hover:text-ink hover:border-ink transition-colors"
                >
                  {copied ? "Copied!" : "Copy"}
                </button>
              </>
            )}
          </div>
          {/* Scope of the stored key, shown alongside the prefix. */}
          <p className="text-xs text-muted">
            Scope:{" "}
            <span className={savedScope.kind === "all" ? "text-muted" : "text-accent"}>
              {labelFor(savedScope)}
            </span>
          </p>
        </div>
      ) : (
        <p className="text-sm text-muted">No API key generated yet.</p>
      )}

      {/* Scope picker for the NEXT (re)generate. "All of my memories" is the default. */}
      <div className="space-y-1.5">
        <p className="text-xs text-muted">
          {displayKey ? "Scope for the regenerated key" : "Scope for the new key"}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setChosenScope(ALL)}
            className={`rounded-sm border px-3 py-2 text-sm transition-colors ${
              chosenScope.kind === "all"
                ? "border-accent text-accent"
                : "border-line-strong text-ink-2 hover:text-ink hover:border-ink"
            }`}
          >
            All of my memories
          </button>
          <button
            type="button"
            onClick={() => setPickerOpen(true)}
            disabled={lifeAreas.length === 0}
            className={`rounded-sm border px-3 py-2 text-sm transition-colors disabled:opacity-40 ${
              chosenScope.kind === "area"
                ? "border-accent text-accent"
                : "border-line-strong text-ink-2 hover:text-ink hover:border-ink"
            }`}
          >
            {chosenScope.kind === "area" ? `Area: ${labelFor(chosenScope)}` : "A single life area…"}
          </button>
          {/* A single code project (ADR 0021 Q7). Native select keeps it simple
              and preserves the XOR: picking here clears any area selection. */}
          <select
            value={chosenScope.kind === "code" ? chosenScope.id : ""}
            disabled={codeProjects.length === 0}
            onChange={(e) => setChosenScope(e.target.value ? { kind: "code", id: e.target.value } : ALL)}
            className={`rounded-sm border px-3 py-2 text-sm transition-colors disabled:opacity-40 ${
              chosenScope.kind === "code"
                ? "border-accent text-accent"
                : "border-line-strong text-ink-2 hover:text-ink hover:border-ink"
            }`}
          >
            <option value="">A single code project…</option>
            {codeProjects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
        {lifeAreas.length === 0 && codeProjects.length === 0 && (
          <p className="text-xs text-muted">
            You have no life areas or code projects yet — add memories or import a coding session to scope a key.
          </p>
        )}
        {displayKey && scopeChanged && (
          <p className="text-xs text-warn">
            Regenerating will change this key&apos;s scope to {labelFor(chosenScope)}.
          </p>
        )}
      </div>

      <div className="flex gap-3">
        <button
          onClick={generate}
          disabled={loading}
          className="rounded-sm border border-ink px-4 py-2 text-sm font-medium text-ink hover:bg-ink hover:text-canvas transition-colors disabled:opacity-50"
        >
          {loading ? (
            <span className="inline-flex items-center gap-2">
              <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current/30 border-t-current" />
              Working...
            </span>
          ) : displayKey ? (
            "Regenerate"
          ) : (
            "Generate API Key"
          )}
        </button>
        {displayKey && (
          <button
            onClick={revoke}
            disabled={loading}
            className="rounded-sm border border-line-strong px-4 py-2 text-sm font-medium text-error hover:border-error transition-colors disabled:opacity-50"
          >
            Revoke
          </button>
        )}
      </div>

      {fullKey && (
        <p className="flex items-center gap-1.5 text-xs text-ok">
          <svg className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          Key generated — copy it now, it won&apos;t be shown again after you leave this page.
        </p>
      )}

      {pickerOpen && (
        <NodePicker
          title="Scope this key to a life area"
          subtitle="The key will only be able to read conversations and memories within this area."
          nodes={pickerNodes}
          emptyHint="No life areas found."
          onPick={(node) => {
            setChosenScope({ kind: "area", id: node.id });
            setPickerOpen(false);
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  );
}
