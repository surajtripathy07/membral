// The observed forge/git actions of ONE tool_use turn, shaped for the session
// page's activity line ("Bash · commented on owner/repo#145").
//
// Source: the turn's own `code_session_turns.props.action(s)` (goal
// 2026-09-26 W3, D-051) — the same structured actions attribution folds in
// profile.ts, read through its exported `turnActions` (so a `repoUnknown`
// action is dropped here exactly as it is there). Every field is the parser's
// fixed-shape, already-redacted, capped value (packages/core forge-actions.ts,
// B10); nothing here reads the transcript text. `props.inputDigest` is the
// parser's redacted command digest (ADR 0026 D10) — message/body values
// already replaced with `‹text›` — and is the only command text shown.
//
// Links: a ref is qualified the way attribution stores it (a bare `#N` onto
// the session's project, a host-less `owner/repo#N` via hostlessRefQualifier
// with this turn's digest/url as the receipt), then linked only through
// `forgeUrl` (with the page's data-derived glab-family hosts) — plain text
// whenever that returns null. Pure.
import { forgeUrl } from "@/lib/format/forge-url";
import { turnActions } from "./profile";
import { canonicalItemRef, hostlessRefQualifier } from "./ref-canon";

export type TurnAction = ReturnType<typeof turnActions>[number];

export interface TurnActionView {
  /** Verb phrase before the target: "commented on", "pushed to", "opened PR". */
  verb: string;
  /** What the action touched, or null when the verb stands alone ("ran tests"). */
  target: { text: string; href: string | null; mono: boolean } | null;
}

/** Actions + redacted command digest pulled out of a turn's jsonb props (tool_use rows only). */
export function readTurnObserved(props: Record<string, unknown> | null | undefined): {
  actions: TurnAction[];
  inputDigest: string | null;
} {
  if (!props || typeof props !== "object") return { actions: [], inputDigest: null };
  const actions = turnActions({ idx: 0, role: "assistant", kind: "tool_use", props });
  const inputDigest = typeof props.inputDigest === "string" && props.inputDigest.trim() ? props.inputDigest : null;
  return { actions, inputDigest };
}

/** First line of the redacted digest, capped for a one-line muted mono render. */
export function digestFirstLine(digest: string | null | undefined, max = 160): string | null {
  if (!digest) return null;
  const line = digest.split("\n")[0].trim();
  if (!line) return null;
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

interface ItemTarget {
  text: string;
  href: string | null;
  github: boolean;
}

/** `github.com/acme/api!12` → "acme/api#12" (linked); `#145` in a session on github.com/o/r → "o/r#145" (linked); no host → plain. */
function itemTarget(a: TurnAction, projectIdentity: string | null, glabHosts?: readonly string[]): ItemTarget | null {
  if (!a.ref) return null;
  const kind = a.refKind === "merge_request" ? "merge_request" : "issue";
  const canon = canonicalItemRef(a.ref, projectIdentity, kind);
  if (!canon) return { text: a.ref, href: null, github: false };
  // The action's own result URL (and its ref) are the receipt a host-less `owner/repo#N` is qualified from.
  const qualified = hostlessRefQualifier([projectIdentity])(canon.ref, [a.url, a.ref].filter(Boolean).join(" "));
  const m = /^([^/\s#!]+\.[^/\s#!]+)\/(.+)#(\d+)$/.exec(qualified);
  const host = m ? m[1].toLowerCase() : null;
  const github = !!host && /(^|\.)github\./i.test(host);
  const body = m ? `${m[2]}#${m[3]}` : qualified;
  // A merge request off GitHub reads `!N` (as the shared refLabel does on Today and Issues).
  const text = kind === "merge_request" && !github ? body.replace(/#(\d+)$/, "!$1") : body;
  return { text, href: forgeUrl(qualified, { kind, glabHosts }), github };
}

const ITEM_VERBS: Record<string, string> = {
  viewed: "viewed",
  checked_out: "checked out",
  commented: "commented on",
  approved: "approved",
  merged: "merged",
  closed: "closed",
  reopened: "reopened",
  triaged: "triaged",
  committed: "committed on",
  pushed: "pushed",
  rewrote: "rewrote",
  navigated: "opened",
  referenced: "referenced",
};

function viewOf(a: TurnAction, projectIdentity: string | null, glabHosts?: readonly string[]): TurnActionView | null {
  const isItem = a.refKind === "issue" || a.refKind === "merge_request";
  const item = isItem ? itemTarget(a, projectIdentity, glabHosts) : null;
  const plain = (text: string) => ({ text, href: null, mono: true });
  const linked = (t: ItemTarget) => ({ text: t.text, href: t.href, mono: true });

  if (a.verb === "tested") return { verb: "ran tests", target: null };
  if (a.verb === "opened_mr") {
    const pr = item ? item.github : a.source === "cli" && !!a.url && /github\./i.test(a.url);
    const noun = pr ? "PR" : "MR";
    if (item) return { verb: `opened ${noun}`, target: linked(item) };
    return { verb: `opened ${noun}`, target: a.branch ? plain(`from ${a.branch}`) : null };
  }
  if (a.verb === "opened") return { verb: "filed", target: item ? linked(item) : null };
  if (a.verb === "committed" && !item) {
    const sha = a.sha ? shortSha(a.sha) : a.refKind === "commit" && a.ref ? shortSha(a.ref) : null;
    const where = a.branch ? ` to ${a.branch}` : "";
    return { verb: "committed", target: sha || where ? plain(`${sha ?? ""}${where}`.trim()) : null };
  }
  if (a.verb === "pushed" && !item) {
    const branch = a.branch ?? (a.refKind === "branch" ? a.ref : undefined);
    return { verb: "pushed", target: branch ? plain(`to ${branch}`) : null };
  }
  if ((a.verb === "checked_out" || a.verb === "navigated" || a.verb === "rewrote") && !item) {
    const branch = a.refKind === "branch" ? a.ref : a.branch;
    const verb = a.verb === "rewrote" ? "rewrote" : "switched to";
    const target = branch ?? (a.sha ? shortSha(a.sha) : a.ref);
    return { verb, target: target ? plain(target) : null };
  }
  const verb = ITEM_VERBS[a.verb] ?? a.verb.replace(/_/g, " ");
  if (item) return { verb, target: linked(item) };
  return a.ref ? { verb, target: plain(a.ref) } : { verb, target: null };
}

/**
 * One view per distinct action, in command order. A chained command's
 * `actions` already includes its headline `action`, so `turnActions` reads
 * one or the other, never both; identical phrases (same verb + target) fold.
 * `glabHosts`: hosts the page's data shows are glab-family (forge-url.ts `glabHostsFrom`) — their refs link glab-style.
 */
export function turnActionViews(
  actions: readonly TurnAction[],
  projectIdentity: string | null,
  glabHosts?: readonly string[],
): TurnActionView[] {
  const out: TurnActionView[] = [];
  const seen = new Set<string>();
  for (const a of actions) {
    const v = viewOf(a, projectIdentity, glabHosts);
    if (!v) continue;
    const key = `${v.verb}\u0000${v.target?.text ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}
