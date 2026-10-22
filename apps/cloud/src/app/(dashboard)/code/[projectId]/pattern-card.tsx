"use client";

// Goal 2026-09-26 P9 / W10 — the "Friday" card: "You ran `npm test` → `Edit ts`
// → `git commit` in 9 sessions this month — draft a skill?". Reads the
// patterns the nightly step stored in code_projects.props.patterns (≤ 3)
// and shows each with its drafted skill body, copy-able. Membral installs
// nothing (B9): the developer pastes the body into their own repo. Tokens
// only (docs/design/tokens.md). Renders nothing when there is no pattern.
import { useId, useState } from "react";
import { relativeDay } from "@/lib/format/dates";
import { renderSkillBody } from "@/lib/patterns/draft-skill";
import type { StoredPattern } from "@/lib/patterns/storage";

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          setCopied(false);
        }
      }}
      className="rounded-sm border border-line bg-raised px-2 py-1 text-label text-ink-2 hover:border-line-strong hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
    >
      {copied ? "Copied" : "Copy SKILL.md"}
    </button>
  );
}

function PatternRow({ pattern, nowIso }: { pattern: StoredPattern; nowIso: string }) {
  const [open, setOpen] = useState(false);
  const draftId = useId();
  const draft = pattern.draft;
  const body = draft ? renderSkillBody(draft, pattern) : null;
  const lastSeen = relativeDay(pattern.lastSeenAt, nowIso);
  return (
    <li className="space-y-2 py-3 first:pt-0 last:pb-0">
      <p className="text-body-sm leading-relaxed text-ink-2">
        You ran{" "}
        {pattern.steps.map((step, i) => (
          <span key={`${step}-${i}`}>
            {i > 0 && <span className="text-muted"> → </span>}
            <code className="rounded-xs bg-raised px-1.5 py-0.5 font-mono text-micro text-ink">{step}</code>
          </span>
        ))}{" "}
        in <span className="text-ink">{pattern.sessionCount} sessions</span> this month
        {lastSeen && <span className="text-muted"> · last {lastSeen}</span>}
        {draft ? " — draft a skill?" : "."}
      </p>
      {draft && body && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              aria-controls={draftId}
              className="text-label text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
            >
              {open ? "Hide draft" : `Show draft: ${draft.name}`}
            </button>
            <span className="text-micro text-muted">
              {draft.source === "llm" ? "drafted by the model" : "drafted from the sequence"} · Membral installs nothing
            </span>
            <CopyButton text={body} />
          </div>
          {open && (
            <pre
              id={draftId}
              className="max-h-80 overflow-auto rounded-sm border border-line-soft bg-sunken p-3 font-mono text-micro leading-relaxed text-ink-2">
              {body}
            </pre>
          )}
        </div>
      )}
    </li>
  );
}

export function PatternCard({ patterns, now }: { patterns: StoredPattern[]; now: string }) {
  if (patterns.length === 0) return null;
  return (
    <section className="rounded-card border border-line bg-surface p-4">
      <h2 className="mb-2 section-label">Repeated in your sessions</h2>
      <ul className="divide-y divide-line-soft">
        {patterns.map((p) => (
          <PatternRow key={p.key} pattern={p} nowIso={now} />
        ))}
      </ul>
    </section>
  );
}
