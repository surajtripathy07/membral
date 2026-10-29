"use client";

// W9 fix pass 2 (after-critique finding #7): the spine's whole idea is
// two-level contrast between a prompt (text-lead) and its collapsed
// activity (text-micro) — a single pasted-terminal-dump prompt rendering at
// ~1,500px unbroken erases that contrast entirely. Clamp long prompts to 12
// lines with a native toggle; short prompts (the common case) render
// exactly as before, no toggle shown.
import { useState } from "react";
import { stripHtmlComments } from "@/lib/code-sessions/view";
import { markQuote } from "./quote-mark";

// Heuristic, not a measured line count (no DOM access at this layer): long
// enough that a ~65ch measure at text-lead reliably exceeds 12 lines.
const CLAMP_THRESHOLD_CHARS = 640;

/** `fromParentAgent`: this is a sub-agent session's opening prompt — written by the spawning agent, not the person, so it's labelled as such. */
export function PromptText({
  text: rawText,
  fromParentAgent = false,
  quote = null,
}: {
  text: string;
  fromParentAgent?: boolean;
  /** The quote a memory record cites (`?quote=`): marked in the prompt when it is there, and the clamp starts open so the mark is visible. */
  quote?: string | null;
}) {
  const text = stripHtmlComments(rawText);
  const marked = markQuote(text, quote);
  const [expanded, setExpanded] = useState(marked !== null);
  const isLong = text.length > CLAMP_THRESHOLD_CHARS;

  return (
    <div>
      {fromParentAgent && <p className="mb-1 font-mono text-micro text-muted">prompt from the parent agent</p>}
      <p className={`text-lead leading-relaxed text-ink ${isLong && !expanded ? "line-clamp-[12]" : ""}`}>
        <span className="mr-1.5 font-mono text-accent">$</span>
        {marked ?? text}
      </p>
      {isLong && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-1.5 text-label text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
        >
          {expanded ? "Show less" : "Show full prompt →"}
        </button>
      )}
    </div>
  );
}
