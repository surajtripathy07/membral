"use client";

// W9 fix pass 2 (after-critique finding #11): the LLM-written project
// summary sits directly under the <h1> — the last "The project 'X' is
// focused on developing..." boilerplate on these five pages, and on stale
// rollups it describes a feature that was deleted. Can't delete it (the
// rollup pass isn't in this task's scope), so it's clamped to two lines
// with a disclosure instead of running full-length as the first thing a
// visitor reads.
import { useState } from "react";

const CLAMP_THRESHOLD_CHARS = 200;

/** Case, whitespace and trailing punctuation do not make a sentence new (review F16). */
export function normalizeSentence(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\s.!?…:;,]+$/u, "");
}

/** `whatBuilt` unless it repeats the summary once normalised. */
export function dedupWhatBuilt(summary: string, whatBuilt: string): string {
  return normalizeSentence(whatBuilt) === normalizeSentence(summary) ? "" : whatBuilt;
}

export function ProjectSummary({ summary, whatBuilt: whatBuiltRaw }: { summary: string; whatBuilt: string }) {
  const [expanded, setExpanded] = useState(false);
  // Goal 2026-09-26 P0c: a stored rollup (pre-fix fallback, or an LLM that
  // echoed itself) may carry what_built === summary; never print a sentence twice.
  const whatBuilt = dedupWhatBuilt(summary, whatBuiltRaw);
  const combinedLength = summary.length + whatBuilt.length;
  const isLong = combinedLength > CLAMP_THRESHOLD_CHARS;

  return (
    <div className="mt-3 max-w-[70ch] space-y-2 text-body-sm text-ink-2">
      <div className={isLong && !expanded ? "line-clamp-2" : undefined}>
        <p>{summary}</p>
        {whatBuilt && <p>{whatBuilt}</p>}
      </div>
      {isLong && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="text-label text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}
