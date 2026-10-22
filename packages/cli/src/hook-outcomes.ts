// Prompt-hook outcome summary per session (recall-precision W3b, "Membral on
// Membral" signals). The prompt hook (prompt-hook.ts) appends one JSON line
// per invocation to ~/.membral/hook.log: {ts, hook: "prompt", reason, session?}.
// Only the client sees those lines, so the upload path folds them into a small
// per-session summary sent with the session (RawCodeSession.hookOutcomes) and
// stored server-side as code_sessions.props.hook_outcomes.
//
// BUCKETS (from the `reason` text prompt-hook.ts writes):
//   injected   — "served N record(s)"
//   timeout    — the CLI's own budget or request timeout ran out: "timeout after N ms" (older logs),
//                "deferred after N ms (budget …, sent=…)", "timeout in N ms (request sent, no response)"
//   budget_hit — "timeout in N ms": the server's recall budget ran out and it
//                answered with nothing
//   errors     — "http …", "network error", "bad_response", "error …"
//   empty      — any other server answer with no lines (no_match,
//                unknown_repo, …)
//   (none)     — "skipped …": the hook decided locally not to ask; counted in
//                `calls` only
// `calls` counts every logged invocation for the session.
//
// Best-effort: a missing or unreadable log yields an empty map. Lines without
// a `session` (hooks from before this field) are ignored.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HookOutcomeSummary, RawCodeSession } from "@membral/core";

export type HookBucket = "injected" | "empty" | "budget_hit" | "timeout" | "errors" | null;

export function defaultHookLogPath(): string {
  return join(homedir(), ".membral", "hook.log");
}

/** Bucket of one prompt-hook outcome line (the `reason` field). Pure. */
export function classifyHookOutcome(reason: string): HookBucket {
  const r = reason.replace(/^prompt-recall:( continuation)?\s*/, "");
  if (r.startsWith("skipped ")) return null;
  if (/^served \d+ record/.test(r)) return "injected";
  if (r.startsWith("timeout after ") || r.startsWith("deferred after ")) return "timeout";
  // Must precede the budget_hit rule: the same "timeout in N ms" prefix, but the server never answered.
  if (/^timeout in \d+ ms \(request sent/.test(r)) return "timeout";
  if (/^timeout\b/.test(r)) return "budget_hit";
  if (/^(http |network error|bad_response|error\b)/.test(r)) return "errors";
  return "empty";
}

const zero = (): HookOutcomeSummary => ({ calls: 0, injected: 0, empty: 0, budget_hit: 0, timeout: 0, errors: 0 });

/** Folds hook.log text into per-session summaries. Pure. */
export function summarizeHookLog(text: string): Map<string, HookOutcomeSummary> {
  const out = new Map<string, HookOutcomeSummary>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!row || typeof row !== "object") continue;
    const { hook, reason, session } = row as { hook?: unknown; reason?: unknown; session?: unknown };
    if (hook !== "prompt" || typeof reason !== "string" || typeof session !== "string" || !session) continue;
    const s = out.get(session) ?? zero();
    out.set(session, s);
    s.calls += 1;
    const bucket = classifyHookOutcome(reason);
    if (bucket) s[bucket] += 1;
  }
  return out;
}

export function readHookOutcomes(path: string = defaultHookLogPath()): Map<string, HookOutcomeSummary> {
  try {
    return summarizeHookLog(readFileSync(path, "utf8"));
  } catch {
    return new Map();
  }
}

/** The session with its hook summary attached, or unchanged when the log has none for it. */
export function withHookOutcomes(session: RawCodeSession, outcomes: Map<string, HookOutcomeSummary>): RawCodeSession {
  const summary = outcomes.get(session.sourceSessionId);
  return summary ? { ...session, hookOutcomes: summary } : session;
}
