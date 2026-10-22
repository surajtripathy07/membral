import { finish } from "./assemble.js";
import type { Partial } from "./git.js";
import { parseForgeUrl, qualifyNumber } from "./refs.js";
import {
  ITEM_URL_IN_RESULT,
  MCP_TITLE_JSON,
  MERGE_PENDING,
  parseState,
  VIEW_BRANCH_JSON,
  VIEW_HEAD_REF_NAME_JSON,
  VIEW_HEAD_REF_NESTED_JSON,
  WEB_URL_JSON,
} from "./results.js";
import type { ForgeAction, ForgeRefKind } from "./types.js";

// --- MCP ---------------------------------------------------------------------

const MCP_IID_KEYS = [
  "merge_request_iid",
  "mr_iid",
  "pull_number",
  "pullNumber",
  "pr_number",
  "issue_iid",
  "issue_number",
  "issueNumber",
  "iid",
  "number",
];
const MCP_TRIAGE_KEYS = [
  "labels",
  "add_labels",
  "remove_labels",
  "assignee_ids",
  "assignees",
  "assignee",
  "milestone",
  "milestone_id",
];

function mcpRef(kind: ForgeRefKind, input: Record<string, unknown>): { ref?: string; project?: string } {
  let project: string | undefined;
  const pid = input.project_id ?? input.projectId ?? input.project;
  if (typeof pid === "string" && !/^\d+$/.test(pid)) {
    try {
      project = decodeURIComponent(pid).replace(/^\/+|\/+$/g, "");
    } catch {
      project = pid;
    }
  }
  if (!project && typeof input.owner === "string" && typeof input.repo === "string")
    project = `${input.owner}/${input.repo}`;
  for (const key of MCP_IID_KEYS) {
    const v = input[key];
    if (typeof v === "number" && Number.isInteger(v)) return { ref: qualifyNumber(kind, String(v), project), project };
    if (typeof v === "string" && /^\d+$/.test(v)) return { ref: qualifyNumber(kind, v, project), project };
  }
  return { project };
}

const MCP_LISTING = /^(list|search)_/;
// A bare plural noun (`mr_discussions`, `get_issue_comments`) is a listing too.
const MCP_PLURAL = /_(notes|comments|discussions|diffs|changes|commits|pipelines)$/;
const RESULT_ITEM_NUMBER = /"(?:iid|number)"\s*:\s*"?(\d+)"?/;

/** The result's first JSON `iid`/`number` equals the number `ref` ends in. */
function resultTiedToRef(result: string, ref: string | undefined): boolean {
  const own = ref ? /(\d+)$/.exec(ref)?.[1] : undefined;
  if (!own) return false;
  const shown = RESULT_ITEM_NUMBER.exec(result)?.[1];
  return shown !== undefined && Number(shown) === Number(own);
}

/** The result's first JSON `iid`/`number` is some other number than the one `ref` ends in. */
function resultShowsOtherItem(result: string, ref: string | undefined): boolean {
  const shown = RESULT_ITEM_NUMBER.exec(result)?.[1];
  if (shown === undefined) return false;
  const own = ref ? /(\d+)$/.exec(ref)?.[1] : undefined;
  return own === undefined || Number(shown) !== Number(own);
}

export function mcpAction(
  tool: string,
  input: Record<string, unknown>,
  result: string | undefined,
  isError: boolean,
): ForgeAction[] {
  const t = tool.toLowerCase();
  // `_` is a word character, so `\bmr\b` never matched `mr_discussions`.
  const isMr = /merge_request|pull_request|pullrequest|(?:^|_)(?:mr|pr)s?(?:_|$)/.test(t);
  const isIssue = /issue/.test(t);
  const kind: ForgeRefKind | null = isMr ? "merge_request" : isIssue ? "issue" : null;
  if (!kind) return [];
  const { ref } = mcpRef(kind, input);
  const p: Partial = { verb: "navigated", refKind: kind, ref };
  // W3 D9 single-item rule: a listing (`list_*`, `search_*`, a plural-noun tool) never ties its
  // result's state/title to this ref, even when the call names one.
  const listing = MCP_LISTING.test(t) || MCP_PLURAL.test(t);
  let getter = false;

  // Undo/removal and edits of an existing note are no verb at all:
  // `unapprove_*` is not an approval, `delete_*_note` / `update_*_note` post nothing new.
  if (/^(un[a-z]+|delete|remove|destroy)_/.test(t)) return [];
  if (/^(update|edit|modify|resolve)_.*(note|comment|discussion|thread)/.test(t)) return [];

  // Reads first: `list_merge_request_notes` / `get_issue_comments` fetch
  // comments, they never post one (F3 of the 2026-09-26 review).
  if (/^(get|read|fetch|show)_/.test(t) || /_read$/.test(t)) {
    p.verb = "viewed";
    if (!listing) getter = true;
  } else if (listing) {
    // A bare plural noun (`mr_discussions`) is a listing too.
    if (!ref) return [];
    p.verb = "viewed";
  } else if (
    /^(create|add|post|reply|new)_.*(note|comment|discussion|thread|reply)/.test(t) ||
    /_(note|comment)$/.test(t)
  ) {
    p.verb = "commented";
  } else if (/approve/.test(t)) {
    p.verb = "approved";
  } else if (/^merge_/.test(t)) {
    // Queued auto-merge has not merged anything yet (F4).
    if (input.merge_when_pipeline_succeeds === true || input.auto_merge === true) return [];
    p.verb = "merged";
  } else if (/^(create|open)_(merge_request|pull_request)$/.test(t)) {
    p.verb = "opened_mr";
  } else if (/review/.test(t)) {
    const ev = String(input.event ?? input.body_event ?? "").toUpperCase();
    p.verb = ev === "APPROVE" ? "approved" : "commented";
  } else if (/^close_/.test(t)) {
    p.verb = "closed";
  } else if (/^reopen_/.test(t)) {
    if (!ref) return [];
    p.verb = "reopened";
  } else if (/^(update|edit|set)_/.test(t) || /_write$/.test(t)) {
    const stateEv = String(input.state_event ?? input.state ?? "").toLowerCase();
    if (/close/.test(stateEv)) p.verb = "closed";
    // glab-family `state_event: "reopen"`, GitHub `state: "open"` on an existing item.
    else if (ref && (/reopen/.test(stateEv) || stateEv === "open")) p.verb = "reopened";
    // Triage is of an existing item: labels on a create (no ref) are not triage.
    else if (ref && MCP_TRIAGE_KEYS.some((k) => input[k] !== undefined)) p.verb = "triaged";
    else return [];
  } else {
    return [];
  }

  if (result) {
    const state = parseState(result);
    // W3 D9 single-item rule: state and title are this ref's own only when the result's JSON
    // `iid`/`number` is this ref's number (a listing, or a getter that returned another item,
    // gives neither) — `parseState`/`MCP_TITLE_JSON` take the result's FIRST match.
    // A merge/close call acts on one item: its result is that item unless it shows another number.
    const tied = !listing && resultTiedToRef(result, p.ref);
    const mutated = (p.verb === "merged" || p.verb === "closed") && !listing && !resultShowsOtherItem(result, p.ref);
    if (state && ((p.verb === "viewed" && getter && tied) || mutated)) p.state = state;
    if (p.verb === "viewed" && getter && tied) {
      const titleMatch = MCP_TITLE_JSON.exec(result);
      if (titleMatch) p.title = titleMatch[1];
      const branchMatch =
        VIEW_BRANCH_JSON.exec(result) ?? VIEW_HEAD_REF_NAME_JSON.exec(result) ?? VIEW_HEAD_REF_NESTED_JSON.exec(result);
      if (branchMatch) p.branch = branchMatch[1];
    }
    // A merge call whose result shows the item still open (or a queued merge) did not merge it.
    if (p.verb === "merged" && ((state && state !== "merged") || MERGE_PENDING.test(result))) return [];
    // A reopen whose result still shows it closed did not reopen it.
    if (p.verb === "reopened") {
      if (state && state !== "opened") return [];
      p.state = "opened";
    }
    if (p.verb === "opened_mr") {
      const m = WEB_URL_JSON.exec(result) ?? ITEM_URL_IN_RESULT.exec(result);
      const parsed = m ? parseForgeUrl(m[1] ?? m[0]) : null;
      if (parsed?.ref) {
        p.url = parsed.url;
        p.ref = parsed.ref;
        p.refKind = parsed.refKind;
        p.proven = true;
      }
    }
  }
  if (isError && !p.proven) return [];
  return [finish(p, "mcp")];
}
