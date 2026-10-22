// Issue grounding for code sessions (code_session_issues): qualifies, grounds
// and attributes the issue/MR refs a session touched. Moved verbatim from
// lib/memory/extract.ts (G2 step 2.1); extract.ts re-exports its public names.

import {
  type BuildProfileOptions,
  type BuildRung,
  buildProfileDetailed,
  type DerivedRole,
  deriveRole,
  type KnownBranchMr,
  type ProfileChildSession,
  type ProfileTier,
  type ProfileTrace,
  type ProfileTurnInput,
  type RefProfile,
  type ReviewRung,
  type SessionProfile,
  type UserNamedRef,
} from "@/lib/code-sessions/profile";
import {
  canonicalItemRef,
  hasExplicitRefSyntax,
  normalizeHostPrefix,
  preferredRef,
} from "@/lib/code-sessions/ref-canon";
import { stripHarnessContext } from "@/lib/code-sessions/view";
import { itemKeyResolver } from "@/lib/domain/ref-identity";
import { MIN_NORMALIZED_QUOTE_CHARS } from "@/lib/memory/grounding";
import { normalizeQuote, quoteMatchesTurnText } from "@/lib/memory/normalize";
import type { TurnRow } from "@/lib/memory/render";
import { SessionIssueMention, type SessionIssueParsed, WorkedSpan, type WorkedSpanParsed } from "@/lib/memory/schema";

// --- Session issues (code_session_issues, migrations 099 + 103).

/**
 * A grounded, qualified issue/MR reference for one session, with what the
 * session observably did on it (goal 2026-09-26 W4, D-051). `role` is
 * DERIVED (profile.ts's deriveRole) from the observed ladders — the
 * extractor's own role is ignored (B2) — EXCEPT in a session with no
 * structured actions at all (imported by a CLI older than W3): there nothing
 * was observable, so the pre-W4 behaviour stands — the model's role, an
 * equal split of the session's cost (turn_share null), tier `inferred`.
 */
export interface GroundedSessionIssue {
  ref: string;
  number: number;
  kind: SessionIssueParsed["kind"];
  role: DerivedRole;
  /**
   * Where `role` came from: `observed` (derived from actions), `model` (an
   * action-less session's extractor role), `default` (an action-less
   * session whose reply carried no role — the writer keeps a stored row's
   * role for the same ref instead, so re-extraction never flips it).
   */
  role_source: "observed" | "model" | "default";
  evidence_quote: string;
  turn_idx: number;
  /** Highest review rung observed (B3), null when none. */
  review_verb: ReviewRung | null;
  /** Highest build rung observed (B3), null when none. */
  build_verb: BuildRung | null;
  /** `inferred` = an action-less session's row (role from the model, not observed). */
  tier: ProfileTier | "inferred";
  /** Share of the session's turns under the focus rule (B15); 0 for a model-only ref; null for an `inferred` row (equal split at read time, like pre-W4 rows). */
  turn_share: number | null;
  related_to: string[];
  /**
   * D-057: `model_segment` when this row's build rung came from the session-issue association
   * (lib/memory/session-association.ts), not from an observed link. Internal (audit, evaluation,
   * rollback) — never a user-facing tier. Absent on every other row.
   */
  source?: "model_segment";
  /** D-057: the association segments that linked this row, with their evidence and reason. */
  segments?: AssociationSegmentRecord[];
}

/** D-057: one model segment as stored on its row (`code_session_issues.segment_evidence`). */
export interface AssociationSegmentRecord {
  from_turn: number;
  to_turn: number;
  evidence: { turn: number; quote: string }[];
  reason: string;
  /** Build action turns (main-session idx) the segment claimed. */
  claimed_turns: number[];
}

const BARE_ISSUE_REF = /^[#!]?(\d+)$/;
export const FORGE_ITEM_SEGMENTS = new Set(["issues", "issue", "pull", "pulls", "merge_requests", "pull-requests"]);

export function parseHttpUrl(s: string): URL | null {
  if (!/^https?:\/\//i.test(s)) return null;
  try {
    return new URL(s);
  } catch {
    return null;
  }
}

/** The issue number a ref points at: the item after an issues/pull/merge_requests URL segment, else the last digit run (a URL's query and fragment ignored). Null when the ref carries no number. */
export function issueRefNumber(ref: string): number | null {
  const trimmed = ref.trim();
  const url = parseHttpUrl(trimmed);
  if (url) {
    const segs = url.pathname.split("/").filter(Boolean);
    for (let i = segs.length - 2; i >= 0; i--) {
      if (FORGE_ITEM_SEGMENTS.has(segs[i].toLowerCase()) && /^\d+$/.test(segs[i + 1])) return Number(segs[i + 1]);
    }
  }
  const m = (url ? url.pathname : trimmed).match(/(\d+)(?!.*\d)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * One canonical ref per issue, so the same issue written two ways lands in
 * one bucket and #123 in two repos never does:
 *   - bare "#123" / "123" / "!123" -> "<projectIdentity>#123"
 *   - a forge URL (…/issues/123, …/pull/45, …/-/merge_requests/7) -> "host/project#N"
 *   - "owner/repo#45" naming this session's own project -> "<projectIdentity>#45"
 *   - anything else -> as written, trimmed.
 * `projectIdentity` is code_projects.repo_identity (host/owner/repo when the
 * session's repo had a remote).
 */
export function qualifyIssueRef(ref: string, projectIdentity: string, number: number): string {
  // e2e A-B2: one canonicaliser for every written form (URL, scheme-less URL
  // path, `owner/repo!N`, bare `#N`/`!N`) — lib/threads/ref-canon.ts.
  const c = canonicalItemRef(ref, projectIdentity);
  if (c && c.number === number) return c.ref;
  return ref.trim().replace(/[.,;:)\]]+$/, "");
}

/** A turn as grounding reads it: `idx`/`text` for quotes, plus (when present) what the profile builder reads. */
export type IssueGroundingTurn = Pick<TurnRow, "idx" | "text"> & {
  role?: string;
  kind?: string;
  tool_name?: string | null;
  file_path?: string | null;
  props?: (TurnRow["props"] & { action?: unknown; actions?: unknown; toolUseId?: unknown }) | null;
};

const MAX_ISSUE_QUOTE_CHARS = 500;

/** A profile ref (`owner/repo!N`, `#N`, …) in code_session_issues' qualified shape (`host/owner/repo#N`). */
function qualifyProfileRef(ref: string, projectIdentity: string): { ref: string; number: number } | null {
  const m = /^(.*?)([#!])(\d+)$/.exec(ref);
  if (!m) return null;
  const number = Number(m[3]);
  if (!Number.isSafeInteger(number)) return null;
  return { ref: qualifyIssueRef(`${m[1]}#${m[3]}`, projectIdentity, number), number };
}

/** Does any turn carry a structured action (W3 `props.action` / `props.actions`)? A CLI older than W3 sends none. */
export function sessionHasActions(turns: ReadonlyArray<{ props?: unknown }>): boolean {
  for (const t of turns) {
    const props = t.props;
    if (!props || typeof props !== "object") continue;
    const p = props as { action?: unknown; actions?: unknown };
    if (p.action && typeof p.action === "object" && !Array.isArray(p.action)) return true;
    if (Array.isArray(p.actions) && p.actions.length > 0) return true;
  }
  return false;
}

function profileTurns(turns: readonly IssueGroundingTurn[]): ProfileTurnInput[] {
  return turns.map((t) => ({
    idx: t.idx,
    role: t.role ?? "assistant",
    kind: t.kind ?? "prose",
    tool_name: t.tool_name ?? null,
    file_path: t.file_path ?? null,
    props: t.props ?? null,
  }));
}

/** A stored placeholder for an elided tool result — never a receipt for anything. */
const ELIDED_RESULT = /^\s*\[tool_result elided\b/i;

/** The first receipt-worthy text of a turn: its text or input digest, never an elided-result placeholder. */
function receiptText(texts: readonly string[]): string | undefined {
  return texts.find((s) => s.trim().length > 0 && !ELIDED_RESULT.test(s))?.trim();
}

/**
 * The receipt for a profile-only row: the proving action's own command line
 * (its text or digest) or, failing that, the ref as the action named it — a
 * fact of the transcript, never model text. A rung proved only inside a
 * folded sub-agent (B16) is receipted at the parent's spawn turn with the
 * child's own command line: a child's turn idx is never looked up among the
 * parent's turns (it would land on an unrelated parent turn).
 */
function observedEvidence(
  p: RefProfile,
  turns: readonly IssueGroundingTurn[],
  children: readonly ProfileChildSession[] = [],
): { evidence_quote: string; turn_idx: number } {
  const rungs = [p.review_verb, p.build_verb, p.triaged ? "triaged" : null, "opened", "referenced"] as const;
  const proofs = rungs.map((r) => (r ? p.evidence[r] : undefined)).filter((e) => e !== undefined);
  const own = proofs.find((e) => !e.child);
  const quoteOf = (text: string | undefined) => (text ?? p.ref).slice(0, MAX_ISSUE_QUOTE_CHARS);
  if (own) {
    const turn = turns.find((t) => t.idx === own.idx);
    return { evidence_quote: quoteOf(turn ? receiptText(turnSearchTexts(turn)) : undefined), turn_idx: own.idx };
  }
  const fromChild = proofs.find((e) => !!e.child);
  const child = fromChild ? children.find((c) => c.id === fromChild.child) : undefined;
  if (fromChild && child) {
    const spawn = child.spawnToolUseId
      ? turns.find((t) => (t.kind ?? "prose") === "tool_use" && t.props?.toolUseId === child.spawnToolUseId)
      : undefined;
    // A child with no spawn row folds in after the session's last turn (profile.ts flatten).
    const idx = spawn?.idx ?? turns.reduce((m, t) => Math.max(m, t.idx), 0);
    const ct = child.turns.find((t) => t.idx === fromChild.idx);
    const digest = (ct?.props as { inputDigest?: unknown } | null | undefined)?.inputDigest;
    return { evidence_quote: quoteOf(typeof digest === "string" ? receiptText([digest]) : undefined), turn_idx: idx };
  }
  const turn = turns.find((t) => t.idx === p.first_turn_idx);
  return {
    evidence_quote: quoteOf(turn ? receiptText(turnSearchTexts(turn)) : undefined),
    turn_idx: p.first_turn_idx,
  };
}

function turnSearchTexts(t: IssueGroundingTurn): string[] {
  const out: string[] = [];
  if (t.text) out.push(t.text);
  const digest = t.props?.inputDigest;
  if (typeof digest === "string" && digest) out.push(digest);
  return out;
}

/** A user prose turn whose prompt carried pastes (`props.ownerText`), read as the owner's own words only. */
function ownerTextOnly(t: IssueGroundingTurn): IssueGroundingTurn {
  const own = (t.props as { ownerText?: unknown } | null | undefined)?.ownerText;
  if (t.role !== "user") return t;
  if (typeof own === "string") return { ...t, text: stripHarnessContext(own) };
  // v4 item 4: a row stored before the parser split it out — harness-injected context
  // (system reminders, a Membral context card) is never the owner's prose.
  if ((t.kind ?? "prose") === "prose" && typeof t.text === "string") {
    const stripped = stripHarnessContext(t.text);
    if (stripped !== t.text) return { ...t, text: stripped };
  }
  return t;
}

/** A sub-agent's user-role prose turn, marked as the parent agent's brief (D-051 F2). */
function asAgentBrief(t: IssueGroundingTurn): IssueGroundingTurn {
  if (t.role !== "user" || t.props?.nonOwner) return t;
  const kind = t.kind ?? "prose";
  if (kind === "tool_result" || kind === "tool_use") return t;
  return { ...t, props: { ...(t.props ?? {}), nonOwner: "agent_brief" } };
}

/** The owner's own prose line: a user turn that is not a tool call or result, nor text the owner did not write (`props.nonOwner`). */
function isUserProse(t: IssueGroundingTurn): boolean {
  const kind = t.kind ?? "prose";
  return t.role === "user" && kind !== "tool_result" && kind !== "tool_use" && !t.props?.nonOwner;
}

/** A turn carries at least one action not marked `repoUnknown` (D-051 F1). */
function hasKnownRepoAction(t: IssueGroundingTurn): boolean {
  const props = t.props as { action?: unknown; actions?: unknown } | null | undefined;
  if (!props) return false;
  const list = Array.isArray(props.actions) && props.actions.length > 0 ? props.actions : [props.action];
  return list.some((a) => !!a && typeof a === "object" && (a as { repoUnknown?: unknown }).repoUnknown !== true);
}

/**
 * A forge tool call: a turn carrying a structured action, the result of one,
 * or (pre-W3 session, no actions) a digested command.
 */
function isForgeCallTurn(hit: IssueGroundingTurn, turns: readonly IssueGroundingTurn[], inferred: boolean): boolean {
  const kind = hit.kind ?? "prose";
  // D-051 F1: a call whose every action ran in another, unnamed repo is no receipt for this project.
  const hasAction = (t: IssueGroundingTurn) => sessionHasActions([t]) && hasKnownRepoAction(t);
  if (hasAction(hit)) return true;
  if (inferred && kind === "tool_use" && typeof hit.props?.inputDigest === "string") return true;
  const useId = hit.props?.toolUseId;
  if (kind === "tool_result" && typeof useId === "string") {
    const call = turns.find((t) => t !== hit && t.kind === "tool_use" && t.props?.toolUseId === useId);
    if (call && hasAction(call)) return true;
  }
  return false;
}

/** `text` names item `number` of `kind` in ref syntax: `#N` (an issue, or a GitHub PR), `!N` (MR only), or an item URL path of that kind. */
function namesItemInSyntax(text: string, number: number, kind: SessionIssueParsed["kind"]): boolean {
  const n = String(number);
  const lead = "(?:^|[^&\\w]|[\\w.-]/[\\w.-]+)";
  const marker = kind === "merge_request" ? "[#!]" : "#";
  if (new RegExp(`${lead}${marker}${n}(?!\\d)`).test(text)) return true;
  const segs = kind === "merge_request" ? "merge_requests|pull|pulls|pull-requests" : "issues|issue";
  return new RegExp(`/(?:-/)?(?:${segs})/${n}(?!\\d)`, "i").test(text);
}

/**
 * D-053 (prompt v13): the extractor's mentions of one ref, validated against
 * the transcript by a Zod refinement — each kept mention's turn is a USER
 * PROSE turn of this session (never an assistant line, tool output, or a
 * sub-agent's brief), its quote is a verbatim span of that turn's text, and
 * the quote names this ref in ref syntax (`#41`, `!17`, its URL). Whether the
 * developer is naming the work item (not pasting someone else's text, not
 * picking a list position) is the model's judgement, made in the prompt — no
 * word list or pattern over the prose decides it. Returns the kept turn idxs.
 * Pure; never throws.
 */
export function groundMentions(
  mentions: readonly unknown[],
  ref: { number: number; kind: SessionIssueParsed["kind"] },
  turns: readonly IssueGroundingTurn[],
): number[] {
  const schema = SessionIssueMention.superRefine((m, ctx) => {
    const t = turns.find((x) => x.idx === m.turn_idx);
    if (!t || !isUserProse(t) || (t.kind ?? "prose") !== "prose" || !t.text) {
      ctx.addIssue({ code: "custom", message: "turn_idx is not a user prose turn" });
      return;
    }
    if (!quoteMatchesTurnText(m.quote, t.text)) {
      ctx.addIssue({ code: "custom", message: "quote is not in that turn" });
      return;
    }
    if (!namesItemInSyntax(m.quote, ref.number, ref.kind)) {
      ctx.addIssue({ code: "custom", message: "quote does not name the ref" });
    }
  });
  const out: number[] = [];
  for (const m of mentions) {
    const parsed = schema.safeParse(m);
    if (parsed.success && !out.includes(parsed.data.turn_idx)) out.push(parsed.data.turn_idx);
  }
  return out;
}

/**
 * D-053: the developer's own mentions of the refs the extractor proposed —
 * only the user turns the extractor returned under the ref's `mentions`, each
 * one validated by `groundMentions`. The mentions of every issue entry that
 * canonicalises to the same ref are pooled (windows each return their own).
 * What lets "For #51 … / now #53 …" attach each build action to the ref named
 * last before it. Pure.
 */
export function collectUserNamedRefs(
  refs: ReadonlyArray<{
    ref: string;
    number: number;
    kind: SessionIssueParsed["kind"];
    mentions?: readonly unknown[];
    worked_span?: unknown;
  }>,
  turns: readonly IssueGroundingTurn[],
): UserNamedRef[] {
  const pooled = new Map<
    string,
    { ref: string; number: number; kind: SessionIssueParsed["kind"]; mentions: unknown[]; spans: unknown[] }
  >();
  for (const r of refs) {
    const id = `${r.kind}\u0000${r.ref}`;
    const entry = pooled.get(id) ?? { ref: r.ref, number: r.number, kind: r.kind, mentions: [], spans: [] };
    entry.mentions.push(...(r.mentions ?? []));
    if (r.worked_span !== undefined && r.worked_span !== null) entry.spans.push(r.worked_span);
    pooled.set(id, entry);
  }
  const out: UserNamedRef[] = [];
  for (const r of pooled.values()) {
    const idxs = groundMentions(r.mentions, r, turns);
    const spanTo = new Map<number, number>();
    for (const sp of r.spans) {
      const g = groundWorkedSpan(sp, idxs, turns);
      if (g) spanTo.set(g.from_turn, Math.max(spanTo.get(g.from_turn) ?? g.to_turn, g.to_turn));
    }
    for (const idx of idxs) {
      const to = spanTo.get(idx);
      out.push(
        to === undefined ? { ref: r.ref, refKind: r.kind, idx } : { ref: r.ref, refKind: r.kind, idx, spanTo: to },
      );
    }
  }
  return out.sort((a, b) => a.idx - b.idx);
}

/**
 * D-055: the extractor's `worked_span` for one ref, validated by Zod against
 * the session — from_turn must be one of the ref's validated mention turns,
 * to_turn >= from_turn and no later than the session's last turn. Invalid →
 * null (ignored; inference then falls back to "until another ref is named or
 * an explicit-ref action occurs"). Pure; never throws.
 */
export function groundWorkedSpan(
  raw: unknown,
  mentionIdxs: readonly number[],
  turns: readonly IssueGroundingTurn[],
): WorkedSpanParsed | null {
  const lastIdx = turns.reduce((m, t) => Math.max(m, t.idx), -1);
  const schema = WorkedSpan.superRefine((v, ctx) => {
    if (!mentionIdxs.includes(v.from_turn)) ctx.addIssue({ code: "custom", message: "from_turn is not a mention" });
    if (v.to_turn > lastIdx) ctx.addIssue({ code: "custom", message: "to_turn past the session's last turn" });
  });
  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** v3: `host/owner/repo` (a repo with a forge remote) — never a local path or a `code-project:` placeholder. */
export function isForgeRepoIdentity(identity: string): boolean {
  return /^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?\/[^/\s]+\/[^\s]*[^/\s]$/i.test(identity.trim());
}

/**
 * Host-stripped, lower-cased `owner/repo` of a qualified ref or a project identity. A REPO comparison
 * (e2e R-7: is this the project's repo, or one an action named?), not item identity — items key
 * through `itemKeyResolver` with their host kept (D-064).
 */
function repoKeyOf(qualified: string): string {
  const at = qualified.lastIndexOf("#");
  const prefix = at > 0 ? qualified.slice(0, at) : qualified;
  const segs = prefix
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .split("/")
    .filter(Boolean);
  if (segs.length >= 3 && segs[0].includes(".")) segs.shift();
  return segs.join("/");
}

/** e2e R-7: the repos the session's own forge actions named (their ref or URL), host-stripped. */
function reposNamedByActions(turns: ReadonlyArray<{ props?: unknown }>, projectIdentity: string): Set<string> {
  const out = new Set<string>();
  for (const t of turns) {
    const props = t.props as { action?: unknown; actions?: unknown } | null | undefined;
    if (!props || typeof props !== "object") continue;
    const list = [props.action, ...(Array.isArray(props.actions) ? props.actions : [])];
    for (const a of list) {
      if (!a || typeof a !== "object") continue;
      if ((a as { repoUnknown?: unknown }).repoUnknown === true) continue;
      const { ref, url, refKind } = a as { ref?: unknown; url?: unknown; refKind?: unknown };
      for (const w of [url, ref]) {
        if (typeof w !== "string") continue;
        const kind = refKind === "merge_request" ? "merge_request" : "issue";
        const c = canonicalItemRef(w.replace(/!(\d+)$/, "#$1"), projectIdentity, kind);
        if (c) out.add(repoKeyOf(c.ref));
      }
    }
  }
  return out;
}

/** Does the receipt line itself spell this owner/repo (case-insensitive)? */
function quoteNamesRepo(quote: string, repo: string): boolean {
  if (!repo) return false;
  // N4: whole path segments only — `acme/billing` is named by `codehub.example/acme/billing/issues/5`,
  // never by `xacme/billing-old`.
  const escaped = repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\w.-])${escaped}(?![\\w-]|\\.\\w)`).test(quote.toLowerCase());
}

/**
 * C-4 (N10): may a MODEL-only ref (no observed action names it) become a
 * thread row? Only when its evidence turn is the owner's own prose line, or a
 * forge tool call (a turn carrying a structured action, or the result of one;
 * in a pre-W3 session with no actions, a digested command), or when the ref
 * as written names this session's own project explicitly. A number the
 * assistant repeats from an email, calendar or other non-forge text is none
 * of those — it may still live on as a plain memory, never as a thread.
 */
function modelRefGrounded(
  writtenRef: string,
  qualifiedRef: string,
  number: number,
  hit: IssueGroundingTurn,
  turns: readonly IssueGroundingTurn[],
  projectIdentity: string,
  inferred: boolean,
  quote: string,
): boolean {
  if (isUserProse(hit)) return true;
  // A user-role line the owner did not write (a paste, shell output, a compaction
  // summary, an agent brief) never grounds a model-only ref, even when it spells the repo.
  if (hit.role === "user" && hit.props?.nonOwner) return false;
  if (isForgeCallTurn(hit, turns, inferred)) return true;
  // D-051 F3: any other line (assistant prose, pasted or tool text) keeps a ref only when the
  // receipt itself spells this project's repo — a bare `#N` there is never qualified to the project.
  const written = writtenRef.trim().replace(/[.,;:)\]]+$/, "");
  return (
    !BARE_ISSUE_REF.test(written) &&
    qualifiedRef === `${projectIdentity}#${number}` &&
    quoteNamesRepo(quote, repoKeyOf(qualifiedRef))
  );
}

/**
 * Merge the extractor's refs with the session's OBSERVED refs and derive each
 * row's role (goal 2026-09-26 W4; B2 observed beats inferred).
 *
 * Model refs: kept only when (a) the evidence_quote is found in one of the
 * session's turns — the same normalized substring check
 * findResolutionEvidenceTurn uses (a tool call's input digest counts as that
 * turn's text), at least MIN_NORMALIZED_QUOTE_CHARS long — and (b) the quote
 * contains the ref's number as a standalone digit run. Language-agnostic.
 *
 * Observed refs (profile.ts, from the turns' structured actions) are rows
 * whether or not the model named them; their receipt is the proving turn's
 * own text/digest. A ref both offered and observed is one row carrying the
 * model's quote and the observed ladders. Role, per the Vocabulary's Role
 * rule: worked_on <=> review >= reviewed, build >= committed or triaged;
 * referenced <=> an observed ref with no turn of the session (viewed in
 * passing); discussed otherwise — every model-only ref included, with
 * turn_share 0. The extractor's own `role` is ignored — unless the session
 * came from a pre-W3 CLI (no `actionsVersion` stamp and no actions): then every row is
 * a model row with the model's role (`default` -> discussed, the writer
 * keeps a stored role), tier `inferred`, turn_share null (equal split).
 * D-051 B16: `childSessions` (the session's sub-agents) fold into the
 * profile, so a child's commit or push on a ref shows as this session's
 * build rung for it.
 * A model ref and an observed ref are the same row when `itemKeyResolver`
 * (D-064) over the session's model + observed refs keys them alike: hosts are
 * kept, so the same owner/repo + number on two forges is two rows, and a
 * host-less spelling joins a hosted one only when exactly one host in that
 * scope holds the item. The model's (URL-qualified) spelling wins. Duplicates keep the first. Pure; never throws.
 */
export function groundSessionIssues(
  issues: readonly SessionIssueParsed[],
  turns: readonly IssueGroundingTurn[],
  projectIdentity: string,
  opts: {
    profile?: SessionProfile;
    actionsVersion?: number | null;
    subAgent?: boolean;
    /** D-051 B16: this session's sub-agent sessions — their actions fold into this session's profile at the spawn turn. */
    childSessions?: readonly ProfileChildSession[];
    /** D-055: earlier sessions' open-MR source branches (same user + project). */
    knownBranches?: readonly KnownBranchMr[];
    /** D-055: `code_sessions.git_branch` and the project's default branch when known. */
    startBranch?: string | null;
    defaultBranch?: string | null;
    /** D-055 kill switch override (default: MEMBRAL_INFER_REF via profile.ts `inferRefEnabled`). */
    inferRef?: boolean;
    /**
     * D-057 out-param: set to the profile's build-action trace when this call folded the profile
     * itself (not for an `opts.profile`, nor an action-less session) — the session-issue
     * association reads which build actions no observed evidence linked.
     */
    trace?: { value?: ProfileTrace };
  } = {},
): GroundedSessionIssue[] {
  // "Old CLI, no action data" is decided by the parser's stamp
  // (code_sessions.props.actions_version), never by an empty action list: a
  // current session that ran no git/gh command has none and is still
  // observed data (its model-only refs stay `discussed`). A session with
  // actions but no stamp was parsed by an action-aware CLI that predates it.
  // R3 ADV: a project identity read from a `www.` or ported remote is the same project as its canonical host.
  projectIdentity = normalizeHostPrefix(projectIdentity.trim());
  const actionAware = typeof opts.actionsVersion === "number" && opts.actionsVersion >= 1;
  const children = opts.childSessions ?? [];
  // D-051 F2: in a sub-agent session every user-role line is the parent agent's brief, never the
  // owner's words — it grounds no owner mention and no discussed ref (only observed actions count).
  if (opts.subAgent) turns = turns.map(asAgentBrief);
  // A prompt with pasted spans grounds owner quotes and named refs on its owner-only text.
  turns = turns.map(ownerTextOnly);
  const inferred =
    !opts.profile && !actionAware && !sessionHasActions(turns) && !children.some((c) => sessionHasActions(c.turns));

  // The extractor's refs, grounded first: D-053 needs them before the profile
  // is folded (a ref-less commit attaches to the ref the developer named).
  const modelRefs: {
    issue: SessionIssueParsed;
    ref: string;
    number: number;
    kind: SessionIssueParsed["kind"];
    quote: string;
    hit: IssueGroundingTurn;
  }[] = [];
  const projectRepo = repoKeyOf(projectIdentity);
  const actionRepos = reposNamedByActions([...turns, ...children.flatMap((c) => c.turns)], projectIdentity);
  for (const issue of issues) {
    // A-B3: only ref syntax is a ref — `review-17049.md` is a file name.
    const canon = canonicalItemRef(issue.ref, projectIdentity, issue.kind);
    if (!canon) continue;
    const number = canon.number;
    let quote = issue.evidence_quote;
    const evidenceOk =
      normalizeQuote(quote).length >= MIN_NORMALIZED_QUOTE_CHARS && new RegExp(`(?<!\\d)${number}(?!\\d)`).test(quote);
    let hit = evidenceOk
      ? turns.find((t) => turnSearchTexts(t).some((text) => quoteMatchesTurnText(quote, text)))
      : undefined;
    // A-B3: the quote must show the number AS a ref (`#N`, `!N`, an item URL),
    // unless it is a forge call's own line (`glab mr view 17049`).
    if (hit && !hasExplicitRefSyntax(quote, number) && !isForgeCallTurn(hit, turns, inferred)) hit = undefined;
    if (!hit) {
      // e2e R-3 (S05 "For #53: …"): an evidence quote too short or not
      // verbatim drops the entry — unless one of its `mentions` grounds (a
      // user prose line naming the item, validated by `groundMentions`); that
      // mention is then the receipt.
      const idx = groundMentions(issue.mentions ?? [], { number, kind: canon.kind }, turns)[0];
      const m = (issue.mentions ?? []).find((x) => x.turn_idx === idx);
      hit = idx === undefined ? undefined : turns.find((t) => t.idx === idx);
      if (!hit || !m) continue;
      quote = m.quote;
    }
    let ref = canon.ref;
    // e2e R-7: an owner/repo the model wrote that is neither this project nor
    // any repo a forge action of the session named, and that the receipt line
    // itself does not name (the model took it from elsewhere, e.g. a typo in
    // its own reply): re-qualified to the project when the receipt shows the
    // number as a ref, else dropped as ungrounded.
    const repo = repoKeyOf(ref);
    if (repo !== projectRepo && !actionRepos.has(repo) && !quoteNamesRepo(quote, repo)) {
      if (!hasExplicitRefSyntax(quote, number)) continue;
      ref = `${projectIdentity}#${number}`;
    }
    modelRefs.push({ issue, ref, number, kind: canon.kind, quote, hit });
  }

  const userRefs =
    inferred || opts.profile || opts.subAgent
      ? []
      : collectUserNamedRefs(
          modelRefs.map((m) => ({
            ref: m.ref,
            number: m.number,
            kind: m.kind,
            mentions: m.issue.mentions,
            worked_span: m.issue.worked_span,
          })),
          turns,
        );
  const detailed = (t: ProfileTurnInput[], o: BuildProfileOptions): SessionProfile => {
    const d = buildProfileDetailed(t, o);
    if (opts.trace) opts.trace.value = d.trace;
    return d.profile;
  };
  const profile = inferred
    ? null
    : (opts.profile ??
      detailed(profileTurns(turns), {
        userRefs,
        childSessions: [...children],
        knownBranches: opts.knownBranches,
        startBranch: opts.startBranch,
        defaultBranch: opts.defaultBranch,
        // D-051 F1: a bare ref joins only this project's qualified spelling.
        projectRepo: projectRepo || null,
        // v3: a bare `#N` in a commit subject names this project's item only when it is a forge repo.
        projectIsForgeRepo: isForgeRepoIdentity(projectIdentity),
        projectHost: isForgeRepoIdentity(projectIdentity) ? projectIdentity.split("/")[0].toLowerCase() : null,
        ...(opts.inferRef !== undefined ? { inferRef: opts.inferRef } : {}),
      }));
  const observedRefs: { p: RefProfile; number: number; ref: string }[] = [];
  for (const p of profile?.refs ?? []) {
    const q = qualifyProfileRef(p.ref, projectIdentity);
    if (q) observedRefs.push({ p, number: q.number, ref: q.ref });
  }
  // D-064: one key over the session's whole scope (model refs + observed refs).
  const keyOf = itemKeyResolver([
    ...modelRefs.map((m) => ({ ref: m.ref, kind: m.kind })),
    ...observedRefs.map((o) => ({ ref: o.ref, kind: o.p.refKind })),
  ]);
  const observed = new Map<string, { p: RefProfile; number: number; ref: string }>();
  for (const o of observedRefs) {
    const key = keyOf(o.ref, o.p.refKind);
    if (!observed.has(key)) observed.set(key, o);
  }
  const relatedQualified = (p: RefProfile) =>
    p.related_to.map((r) => qualifyProfileRef(r, projectIdentity)?.ref ?? r).sort();

  const out: GroundedSessionIssue[] = [];
  const seen = new Set<string>();
  const push = (
    ref: string,
    number: number,
    kind: SessionIssueParsed["kind"],
    p: RefProfile | null,
    receipt: { evidence_quote: string; turn_idx: number },
    modelRole: SessionIssueParsed["role"],
  ) => {
    const key = keyOf(ref, kind);
    if (seen.has(key)) return;
    seen.add(key);
    if (inferred) {
      // v4 item 7: no action data means no verb — the role comes from verbs only, so the model's
      // `worked_on` is never shown; the row is a mention with its receipt, and carries no cost.
      out.push({
        ref,
        number,
        kind,
        role: "referenced",
        role_source: modelRole ? "model" : "default",
        evidence_quote: receipt.evidence_quote,
        turn_idx: receipt.turn_idx,
        review_verb: null,
        build_verb: null,
        tier: "inferred",
        turn_share: 0,
        related_to: [],
      });
      return;
    }
    out.push({
      ref,
      number,
      kind,
      role: deriveRole(p),
      role_source: "observed",
      evidence_quote: receipt.evidence_quote,
      turn_idx: receipt.turn_idx,
      review_verb: p?.review_verb ?? null,
      build_verb: p?.build_verb ?? null,
      tier: p ? p.tier : "discussed",
      turn_share: p ? p.turn_share : 0,
      related_to: p ? relatedQualified(p) : [],
    });
  };

  for (const { issue, ref, number, kind, quote, hit } of modelRefs) {
    const obs = observed.get(keyOf(ref, kind));
    // D-051 F2: a sub-agent session contributes only what it observably did — a ref its brief or
    // its own narration names, with no action on it, is never a row.
    if (!obs && opts.subAgent) continue;
    if (!obs && !modelRefGrounded(issue.ref, ref, number, hit, turns, projectIdentity, inferred, quote)) continue;
    // R3 ADV 3: a host-less model spelling matched to an observed hosted row stores the hosted
    // spelling (the canonical shape, so the forge link works); a hosted model spelling stays.
    const stored = obs ? preferredRef(ref, obs.ref) : ref;
    push(stored, number, kind, obs?.p ?? null, { evidence_quote: quote, turn_idx: hit.idx }, issue.role);
  }
  for (const { p, number, ref } of observed.values()) {
    push(ref, number, p.refKind, p, observedEvidence(p, turns, children), undefined);
  }
  return out;
}
