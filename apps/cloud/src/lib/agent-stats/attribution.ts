// /code/stats/issues — tokens/$ and commits per issue or merge request.
//
// WHICH ISSUE A SESSION WAS FOR (goal 2026-09-26 W4, D-051) comes from what
// the session observably did: code_session_issues rows carry the ref's
// observed ladders (review_verb/build_verb), tier and turn_share, folded from
// the turns' structured actions by lib/code-sessions/profile.ts, with `role`
// derived from them — worked_on, discussed or referenced. The extractor's
// refs still join (grounded by lib/memory/extract.ts's groundSessionIssues,
// a quote in the session's own turns carrying the number), but a
// model-proposed ref with no observed action is at most `discussed` (B2). A
// session that was never extracted simply has no rows and lands in
// "Unattributed" — there is no fallback parser.
//
// No LLM call in this file: it joins
//   1. code_sessions.props.usage -> tokens/cost, via the SAME price-table
//      logic as lib/agent-stats/aggregate.ts (asRawUsage/asModelList/
//      computeCost are imported, never re-implemented);
//   2. code_session_issues -> which refs each session acted on, and each
//      ref's share of the session's turns (B11: cost x turn_share, labelled
//      an estimate);
//   3. code_session_turns -> commit events (display only): the `committed`
//      action W3 attaches to a Bash tool_use row (sha parsed from the
//      `[branch sha] subject` result line before the result was elided), or,
//      for rows imported before W3, parsed out of the ADR 0026 D10
//      `props.inputDigest` that matched `git commit`.
//
// A Bash tool_result's text is always elided by the transcript parser
// (privacy redaction, ADR 0026 D1). Before W3 the sha therefore only
// survived in the assistant's own prose a few turns later ("Committed as
// 645208b."); that keyword-anchored scan (never a bare hex scan) is kept as
// the fallback for turns carrying no action.
import type { RawUsage } from "@membral/core";
import {
  type AgentStatsSessionInput,
  type AgentStatsTokens,
  asModelList,
  asRawUsage,
} from "@/lib/agent-stats/aggregate";
import { costParentOf } from "@/lib/agent-stats/child-pricing";
import { computeCost } from "@/lib/code-sessions/price-table";
import { commitSubjectRefs, roleFromStoredVerbs, rowCarriesCost } from "@/lib/code-sessions/profile";
import { canonicalItemRef, preferredRef } from "@/lib/code-sessions/ref-canon";
import { type SessionTitleInfo, type SessionTitleRef, toSessionRefs } from "@/lib/code-sessions/session-titles";
import { BUILD_RANK, REVIEW_RANK, ROLE_RANK, type Role } from "@/lib/domain/ladder";
import { foldDiscussedKinds, itemKeyResolver } from "@/lib/domain/ref-identity";

// ---- Commit-event parsing -------------------------------------------------

export interface AttributionTurnInput {
  session_id: string;
  idx: number;
  role: string;
  kind: string;
  text: string | null;
  tool_name: string | null;
  ts: string | null;
  /** code_session_turns.props — jsonb, unvalidated at the DB boundary. Only
   * `inputDigest` (ADR 0026 D10, Bash/gh/git tool_use rows only) and the W3
   * `action`/`actions` matter here. */
  props: { inputDigest?: unknown; action?: unknown; actions?: unknown } | null | undefined;
}

export interface CommitEvent {
  /** Hex SHA. From the turn's `committed` action when the import carried one
   * (W3: parsed from the result line, B1); otherwise best-effort from nearby
   * assistant narration, null when none was found within the scan window. */
  sha: string | null;
  /** True when the sha (and subject) came from the observed action, not prose. */
  observed: boolean;
  /** The Bash tool_use turn's idx — the row a claim traces to (B1). */
  turnIdx: number;
  /** Full commit message recovered from the Bash `inputDigest`, up to
   * whatever the 400-char digest cap preserved. */
  message: string;
  /** First non-blank line of `message`. */
  subject: string;
  sessionId: string;
  /** Bash tool_use turn's timestamp. */
  at: string;
  /** True when the digest's 400-char cap cut the message off before a
   * closing marker (heredoc `EOF` / closing quote) was found. */
  truncated: boolean;
  /** The branch the commit's own `[branch sha]` result line named (observed actions only). */
  branch?: string;
}

const GIT_COMMIT_RE = /\bgit\s+commit\b/;
// Keyword-anchored on purpose (never a bare `[0-9a-f]{7,40}` scan): a bare
// scan matches ordinary hex-looking English words far too often. Requires
// "commit(ted/ting)"/"sha"/"hash" within 40 chars before the token.
const SHA_NEAR_KEYWORD_RE = /\b(?:commit(?:t?ed|ting)?|sha|hash)\b[^\n]{0,40}?\b([0-9a-f]{7,40})\b/i;
// How many turns forward (within the same session) to look for the
// assistant's narrated SHA before giving up.
const SHA_SCAN_WINDOW = 15;

function extractCommitMessage(digest: string): { message: string; subject: string; truncated: boolean } {
  // Heredoc form: git commit -m "$(cat <<'EOF'\n<message>\nEOF\n)" — the
  // convention every commit in this repo's history uses (see the git-commit
  // skill). Capture from just after the opening marker to the line that is
  // exactly "EOF"; if that closing line never appears within the digest, the
  // message was truncated by the 400-char cap and we keep whatever we have.
  const heredocMatch = digest.match(/<<-?\s*'?"?EOF'?"?\s*\n([\s\S]*)$/);
  if (heredocMatch) {
    const rest = heredocMatch[1];
    const eofIdx = rest.search(/\n?EOF\b/);
    const message = (eofIdx >= 0 ? rest.slice(0, eofIdx) : rest).trim();
    return { message, subject: firstLine(message), truncated: eofIdx < 0 };
  }

  // Simple quoted form: -m "message" or -m 'message'.
  const dquote = digest.match(/-m\s+"((?:[^"\\]|\\.)*)("?)/);
  if (dquote) {
    const closed = dquote[2] === '"';
    const message = dquote[1].trim();
    return { message, subject: firstLine(message), truncated: !closed };
  }
  const squote = digest.match(/-m\s+'([^']*)('?)/);
  if (squote) {
    const closed = squote[2] === "'";
    const message = squote[1].trim();
    return { message, subject: firstLine(message), truncated: !closed };
  }

  // Fallback: no recognizable -m form found within the (possibly truncated)
  // digest — best-effort, treat the tail after "git commit" as the message.
  const idx = digest.search(GIT_COMMIT_RE);
  const message = (idx >= 0 ? digest.slice(idx) : digest).trim();
  return { message, subject: firstLine(message), truncated: digest.length >= 400 };
}

function firstLine(message: string): string {
  return (
    message
      .split("\n")
      .find((l) => l.trim().length > 0)
      ?.trim() ?? ""
  );
}

interface CommittedAction {
  sha?: string;
  subject?: string;
  branch?: string;
}

/** The `committed` actions a turn carries (`props.actions` when several, else `props.action`). */
function committedActions(t: AttributionTurnInput): CommittedAction[] {
  const props = t.props;
  if (!props || typeof props !== "object") return [];
  const list = Array.isArray(props.actions) ? props.actions : props.action ? [props.action] : [];
  const out: CommittedAction[] = [];
  for (const a of list) {
    if (!a || typeof a !== "object") continue;
    const r = a as Record<string, unknown>;
    if (r.verb !== "committed") continue;
    // D-051 F1: a commit in another directory whose repo nothing named is not this session's.
    if (r.repoUnknown === true) continue;
    out.push({
      sha: typeof r.sha === "string" && /^[0-9a-f]{7,40}$/i.test(r.sha) ? r.sha.toLowerCase() : undefined,
      subject: typeof r.subject === "string" ? r.subject : undefined,
      branch: typeof r.branch === "string" && r.branch ? r.branch : undefined,
    });
  }
  return out;
}

/**
 * Parse commit events out of a batch of turn rows — pure, no I/O. `turns`
 * may span multiple sessions in any order; grouped and idx-sorted internally.
 * A turn carrying a `committed` action (W3) yields one event per such action
 * with the action's sha (null when the result printed none, e.g. `git
 * merge`), never consulting prose; only a turn with no action at all falls
 * back to the digest + narration scan.
 */
/** The digest's stand-in for a redacted message value (core forge-actions.ts): never a subject. */
const DIGEST_TEXT_PLACEHOLDER = "‹text›";

function hasAction(t: AttributionTurnInput): boolean {
  const props = t.props;
  if (!props || typeof props !== "object") return false;
  return (Array.isArray(props.actions) && props.actions.length > 0) || !!props.action;
}

export function parseCommitEvents(
  turns: AttributionTurnInput[],
  opts: {
    /** e2e R-3/R-5: sessions whose import carried actions (`props.actions_version` >= 1). Only the OTHER
     * sessions (pre-W3) fall back to reading a commit from the digest: in an action-aware session a
     * `git commit` with no `committed` action did not commit (it failed, or it was not one). */
    actionAwareSessions?: ReadonlySet<string>;
  } = {},
): CommitEvent[] {
  const bySession = new Map<string, AttributionTurnInput[]>();
  for (const t of turns) {
    const list = bySession.get(t.session_id);
    if (list) list.push(t);
    else bySession.set(t.session_id, [t]);
  }

  const events: CommitEvent[] = [];
  for (const [sessionId, sessionTurns] of bySession) {
    const sorted = [...sessionTurns].sort((a, b) => a.idx - b.idx);
    const actionAware = !!opts.actionAwareSessions?.has(sessionId) || sorted.some(hasAction);
    for (let i = 0; i < sorted.length; i++) {
      const t = sorted[i];
      if (t.kind !== "tool_use" || (t.tool_name ?? "").toLowerCase() !== "bash") continue;
      const digest = typeof t.props?.inputDigest === "string" ? t.props.inputDigest : undefined;

      const observed = committedActions(t);
      if (observed.length > 0) {
        // A redacted digest (‹text›) is command text, never a subject: an observed action with no
        // subject shows none.
        const fromDigest =
          digest && GIT_COMMIT_RE.test(digest) && !digest.includes(DIGEST_TEXT_PLACEHOLDER)
            ? extractCommitMessage(digest)
            : null;
        for (const a of observed) {
          const subject = a.subject ?? fromDigest?.subject ?? "";
          events.push({
            sha: a.sha ?? null,
            observed: true,
            turnIdx: t.idx,
            message: a.subject ?? fromDigest?.message ?? "",
            subject,
            sessionId,
            at: t.ts ?? "",
            truncated: a.subject ? false : (fromDigest?.truncated ?? false),
            ...(a.branch ? { branch: a.branch } : {}),
          });
        }
        continue;
      }

      if (actionAware) continue;
      if (!digest || !GIT_COMMIT_RE.test(digest)) continue;
      const redacted = digest.includes(DIGEST_TEXT_PLACEHOLDER);
      const parsed = redacted ? { message: "", subject: "", truncated: false } : extractCommitMessage(digest);
      const { message, subject, truncated } = parsed;

      let sha: string | null = null;
      for (let j = i + 1; j < sorted.length && j <= i + SHA_SCAN_WINDOW; j++) {
        const next = sorted[j];
        // A later commit's own Bash call ends this call's narration window —
        // never let a SHA mentioned after the NEXT commit attach to this one.
        if (next.kind === "tool_use" && next.tool_name === "Bash") {
          const nextDigest = typeof next.props?.inputDigest === "string" ? next.props.inputDigest : undefined;
          if (nextDigest && GIT_COMMIT_RE.test(nextDigest)) break;
        }
        if (next.role !== "assistant" || next.kind !== "prose" || !next.text) continue;
        const m = next.text.match(SHA_NEAR_KEYWORD_RE);
        if (m) {
          sha = m[1];
          break;
        }
      }

      events.push({ sha, observed: false, turnIdx: t.idx, message, subject, sessionId, at: t.ts ?? "", truncated });
    }
  }
  return events;
}

/** v4 item 2: an MR's source branch as a session's own actions showed it (opened_mr head, view, checkout). */
export interface MrBranchFact {
  ref: string;
  branch: string;
}

const MR_BRANCH_VERBS = new Set(["opened_mr", "viewed", "checked_out"]);

/** `${session_id}\u0000${idx}` of every turn whose props carry an observed action — the turns a link may land on. Pure. */
export function actionTurnKeys(turns: readonly AttributionTurnInput[]): Set<string> {
  const out = new Set<string>();
  for (const t of turns) {
    const p = t.props;
    if (!p || typeof p !== "object") continue;
    if ((Array.isArray(p.actions) && p.actions.length > 0) || (p.action && typeof p.action === "object"))
      out.add(`${t.session_id}\u0000${t.idx}`);
  }
  return out;
}

/**
 * Per session, the MR source branches its actions observed — the lineage a
 * commit's own `[branch sha]` line is matched against (v4 item 2). Pure.
 */
export function mrBranchesBySession(turns: readonly AttributionTurnInput[]): Map<string, MrBranchFact[]> {
  const out = new Map<string, MrBranchFact[]>();
  for (const t of turns) {
    const props = t.props;
    if (!props || typeof props !== "object") continue;
    const list = Array.isArray(props.actions) ? props.actions : props.action ? [props.action] : [];
    for (const a of list) {
      if (!a || typeof a !== "object") continue;
      const r = a as Record<string, unknown>;
      if (r.refKind !== "merge_request" || typeof r.ref !== "string" || typeof r.branch !== "string") continue;
      if (typeof r.verb !== "string" || !MR_BRANCH_VERBS.has(r.verb)) continue;
      if (r.branch === "main" || r.branch === "master") continue;
      const facts = out.get(t.session_id) ?? [];
      if (!facts.some((f) => f.ref === r.ref && f.branch === r.branch)) facts.push({ ref: r.ref, branch: r.branch });
      out.set(t.session_id, facts);
    }
  }
  return out;
}

// ---- Session issues (code_session_issues, migrations 099 + 103) ----------

export type SessionIssueRole = Role;

/** One code_session_issues row, as the issues route reads it. The migration
 * 103 columns are optional: a row written before W4 carries none of them. */
export interface SessionIssueRow {
  session_id: string;
  /** Qualified ref: "host/owner/repo#12", "group/project#123", or as written. */
  ref: string;
  number: number;
  kind: "issue" | "merge_request";
  role: SessionIssueRole;
  /** Highest observed review rung (B3), null/absent when none. */
  review_verb?: string | null;
  /** Highest observed build rung (B3), null/absent when none. */
  build_verb?: string | null;
  /** `inferred_ref` (D-053): the build action was observed, its ref came from the developer's prose. */
  tier?: "observed" | "discussed" | "inferred" | "inferred_ref" | null;
  /** This ref's share of the session's turns under the focus rule (B15). */
  turn_share?: number | string | null;
  related_to?: string[] | null;
  /** The turn that evidences the row (UX W5: the Issues row's #turn anchor), when the read selected it. */
  turn_idx?: number | null;
  /** The row's receipt line, when the read selected it (v3 item 6: a GitHub-sourced host-less ref). */
  evidence_quote?: string | null;
}

function higherVerb(rank: Record<string, number>, a: string | null, b: string | null | undefined): string | null {
  if (!b || !(b in rank)) return a;
  if (!a || (rank[b] ?? 0) > (rank[a] ?? 0)) return b;
  return a;
}

/** `turn_share` as a number in 0..1, or null when the row carries none (pre-W4 row). numeric columns arrive as strings. */
function rowShare(row: SessionIssueRow): number | null {
  const v = row.turn_share;
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.min(1, Math.max(0, n));
}

/**
 * e2e A-B2: rows stored as `host/o/r#N`, `o/r!N` or `o/r/-/merge_requests/N`
 * are one item (read-time merge); S5: two hosts are never one item.
 */
function issueKeyFor(rows: readonly SessionIssueRow[]): (row: Pick<SessionIssueRow, "ref" | "kind">) => string {
  const resolve = itemKeyResolver(rows);
  return (row) => resolve(row.ref, row.kind);
}

/** A session row as the sub-agent fold reads it (089: children name the parent's source_session_id). */
export interface SubAgentLinkRow {
  id: string;
  parent_source_session_id?: string | null;
  source?: string | null;
  source_session_id?: string | null;
}

/**
 * S06: child session id -> parent session id, for every sub-agent child whose
 * parent is in `sessions`. The Issues page counts a child under its parent.
 */
export function subAgentParents(sessions: readonly SubAgentLinkRow[]): Map<string, string> {
  const bySource = new Map<string, string>();
  const ids = new Set(sessions.map((s) => s.id));
  for (const s of sessions)
    if (s.source_session_id) bySource.set(`${s.source ?? ""}\u0000${s.source_session_id}`, s.id);
  const out = new Map<string, string>();
  for (const s of sessions) {
    const parent = s.parent_source_session_id;
    if (!parent) continue;
    const found = bySource.get(`${s.source ?? ""}\u0000${parent}`) ?? (ids.has(parent) ? parent : undefined);
    if (found && found !== s.id) out.set(s.id, found);
  }
  return out;
}

// ---- Per-session outcome (#93 — outcome link per session row) --------------

/** One session's outcome: the issues/MRs it worked on (from
 * code_session_issues, by ref then kind) plus its commit events (display
 * only). Empty `issues` and `commits` means "no outcome recorded". Identity is
 * (kind, ref): a glab-style issue #17 and MR !17 share the stored ref string, so the
 * kind travels with each entry and a chip links to the right forge page. */
export interface SessionOutcome {
  issues: { ref: string; kind: SessionIssueRow["kind"] }[];
  commits: CommitEvent[];
}

/**
 * Per-session "what did THIS session touch": commits grouped by session,
 * plus each session's `worked_on` issue refs. Pure, no I/O; a session with
 * neither is absent from the map (callers fall back to emptySessionOutcome).
 */
export function groupCommitEventsBySession(
  commits: CommitEvent[],
  issueRows: readonly SessionIssueRow[] = [],
): Map<string, SessionOutcome> {
  const bySession = new Map<string, SessionOutcome>();
  const issueKey = issueKeyFor(issueRows);
  const entryFor = (sessionId: string) => {
    const entry = bySession.get(sessionId) ?? { issues: [], commits: [] };
    bySession.set(sessionId, entry);
    return entry;
  };
  for (const c of commits) entryFor(c.sessionId).commits.push(c);
  for (const row of issueRows) {
    if (row.role !== "worked_on") continue;
    const entry = entryFor(row.session_id);
    if (!entry.issues.some((i) => issueKey(i) === issueKey(row))) {
      entry.issues.push({ ref: row.ref, kind: row.kind });
    }
  }
  for (const entry of bySession.values()) {
    entry.issues.sort((a, b) =>
      a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0,
    );
  }
  return bySession;
}

/** A session with no commits and no issues — same shape a caller gets
 * from `groupCommitEventsBySession(...).get(sessionId) ?? emptySessionOutcome()`. */
export function emptySessionOutcome(): SessionOutcome {
  return { issues: [], commits: [] };
}

// ---- Per-issue aggregation --------------------------------------------------

export interface IssueCommitSummary {
  sha: string | null;
  subject: string;
  at: string;
}

export interface IssueAttribution {
  /** Qualified ref; null identifies the "unattributed" bucket. */
  issue: string | null;
  kind: SessionIssueRow["kind"] | null;
  /** Sessions that worked on it (counted once globally, see below). */
  sessions: number;
  /** Sessions that only discussed or referenced it. */
  mentions: number;
  /** Turns attributed to it by turn share (a pre-W4 row credits the session's full turn count). */
  turns: number;
  tokens: AgentStatsTokens;
  /** Same "null (never 0) means no priced session contributed" rule as
   * AgentStatsTotals.cost_usd (aggregate.ts). */
  costUsd: number | null;
  /** B11: cost and tokens are the session's totals x the ref's turn share — always an estimate. */
  estimated: true;
  /** Strongest role any session had on it (worked_on > discussed > referenced); null for the unattributed bucket. */
  role: SessionIssueRole | null;
  /** Highest review rung any session observably reached on it (B3). */
  reviewVerb: string | null;
  /** Highest build rung any session observably reached on it (B3). */
  buildVerb: string | null;
  /** v4 item 2: commits tied to THIS item — on its MR's observed source branch
   * (lineage), or whose own subject names it. Never a session's other commits,
   * never a placeholder: a tied commit with no sha and no subject is counted in
   * `untitledCommits` instead. */
  commits: IssueCommitSummary[];
  /** Tied commits with neither a sha nor a subject recorded ("+N commits without a recorded subject"). */
  untitledCommits?: number;
  /** Sessions attributed here that carry no priceable usage. */
  unpricedSessions: number;
  /** D-053: every build rung here came from a row whose ref was inferred from the developer's prose (tier `inferred_ref`). */
  inferredRef: boolean;
  /** UX W5: every session this row references (touched it, or only mentioned it), a sub-agent child counted as its parent. */
  sessionIds: string[];
  /** UX W5: session id → the turn that evidences the row in THAT session (only when the row came from the session itself, not a folded child). */
  turnIdxBySession: Record<string, number>;
  /**
   * Maintainer rule: where each counted session's link lands — the turn that SHOWS the action,
   * which for work done inside a sub-agent is the CHILD session's action turn, never the
   * parent's spawn turn. Absent: link the session top.
   */
  linkBySession?: Record<string, { session_id: string; turn_idx: number }>;
  /** UX W5: the referenced sessions with display titles, newest first — attached by the route (withIssueSessionRefs). */
  sessionRefs?: SessionTitleRef[];
}

export interface AggregateIssueAttributionResult {
  /** Sorted by costUsd descending (mention-only and unpriced last), ref
   * ascending as the tie-break. */
  issues: IssueAttribution[];
  unattributed: IssueAttribution;
  /** B11: every per-ref figure is the session's cost x its turn share. */
  estimated: true;
}

function emptyMutableBucket() {
  return {
    sessionIds: new Set<string>(),
    mentionSessionIds: new Set<string>(),
    turnIdxBySession: new Map<string, number>(),
    linkBySession: new Map<string, { session_id: string; turn_idx: number; action: boolean; rank: number }>(),
    turns: 0,
    tokens: { input: 0, output: 0, cache_read: 0, cache_creation: 0 } as AgentStatsTokens,
    pricedCostSum: 0,
    pricedSessionCount: 0,
    unpricedSessionCount: 0,
    commits: [] as IssueCommitSummary[],
    untitledCommits: 0,
    role: null as SessionIssueRole | null,
    reviewVerb: null as string | null,
    buildVerb: null as string | null,
    inferredBuild: false,
    observedBuild: false,
  };
}

type MutableBucket = ReturnType<typeof emptyMutableBucket>;

function round(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

function addScaledUsage(tokens: AgentStatsTokens, usage: RawUsage, share: number): void {
  tokens.input += usage.inputTokens * share;
  tokens.output += usage.outputTokens * share;
  tokens.cache_read += usage.cacheReadInputTokens * share;
  tokens.cache_creation += usage.cacheCreationInputTokens * share;
}

function finalizeBucket(
  issue: string | null,
  kind: SessionIssueRow["kind"] | null,
  b: MutableBucket,
): IssueAttribution {
  return {
    issue,
    kind,
    sessions: b.sessionIds.size,
    mentions: b.mentionSessionIds.size,
    turns: b.turns,
    tokens: {
      input: Math.round(b.tokens.input),
      output: Math.round(b.tokens.output),
      cache_read: Math.round(b.tokens.cache_read),
      cache_creation: Math.round(b.tokens.cache_creation),
    },
    costUsd: b.pricedSessionCount > 0 ? round(b.pricedCostSum) : null,
    estimated: true,
    role: b.role,
    reviewVerb: b.reviewVerb,
    buildVerb: b.buildVerb,
    commits: b.commits,
    untitledCommits: b.untitledCommits,
    unpricedSessions: b.unpricedSessionCount,
    inferredRef: b.inferredBuild && !b.observedBuild,
    sessionIds: [...new Set([...b.sessionIds, ...b.mentionSessionIds])],
    turnIdxBySession: Object.fromEntries(b.turnIdxBySession),
    linkBySession: Object.fromEntries(
      [...b.linkBySession].map(([k, v]) => [k, { session_id: v.session_id, turn_idx: v.turn_idx }]),
    ),
  };
}

/** v4 item 2: add a commit to a bucket once (by sha), folding a sha-less subject-less one into the count. */
function addCommit(b: MutableBucket, c: CommitEvent): void {
  const subject = c.subject.trim();
  if (!c.sha && !subject) {
    b.untitledCommits += 1;
    return;
  }
  if (c.sha && b.commits.some((x) => x.sha === c.sha)) return;
  b.commits.push({ sha: c.sha, subject, at: c.at });
}

function noteRow(b: MutableBucket, row: SessionIssueRow): void {
  if (!b.role || ROLE_RANK[row.role] > ROLE_RANK[b.role]) b.role = row.role;
  b.reviewVerb = higherVerb(REVIEW_RANK, b.reviewVerb, row.review_verb);
  b.buildVerb = higherVerb(BUILD_RANK, b.buildVerb, row.build_verb);
  if (row.build_verb && row.build_verb in BUILD_RANK) {
    if (row.tier === "inferred_ref") b.inferredBuild = true;
    else b.observedBuild = true;
  }
}

/**
 * Aggregate priced sessions + their code_session_issues rows into per-issue
 * totals.
 *
 * SPLIT RULE (B11): a session's cost, tokens and turns go to each ref in
 * proportion to that ref's `turn_share` (its share of the session's turns
 * under the focus rule) — worked_on and discussed rows alike; a referenced
 * row has share 0 and gets nothing. Whatever share no row claims stays with
 * the session in `unattributed` (cost/tokens only — the session is counted
 * once, under its refs). Every figure is an estimate (`estimated: true`).
 * Rows written before W4 carry no turn_share: such a session splits equally
 * across its worked_on rows, exactly as before, so old data reads the same.
 *
 * SESSIONS vs MENTIONS: `sessions` counts every session that TOUCHED the ref
 * (a worked_on or discussed row — cost still follows only the turn share), so
 * a discussed-only ref never reads "Sessions 0"; a session on two refs counts
 * on both, so `sessions` is per ref and does not sum to the population (the
 * population is sessions on any ref + `unattributed.sessions`). `mentions`
 * counts the sessions that only discussed or referenced it.
 *
 * UNATTRIBUTED: a session with no worked_on or discussed rows (including every
 * session never extracted) lands in `unattributed` with 100% of its
 * cost/tokens, so sum(issues[].costUsd ?? 0) + (unattributed.costUsd ?? 0)
 * reconciles against the full priced-session population. A session whose rows
 * are all `discussed` is counted on those refs (not in `unattributed.sessions`),
 * so every session is counted in exactly one of: some ref, or unattributed.
 */
/**
 * v4 item 2: is commit `c` (made in `sessionId`) tied to `row`'s item — on its
 * MR's observed source branch (lineage), or its own subject names the item?
 * Never a session's other commits. Shared by the Issues page's commits column
 * and Today's per-item commit facts (open-threads.ts), so both tie alike.
 */
export function commitTiedToItem(
  c: Pick<CommitEvent, "branch" | "subject">,
  row: Pick<SessionIssueRow, "ref" | "kind">,
  sessionId: string,
  issueKey: (row: Pick<SessionIssueRow, "ref" | "kind">) => string,
  opts: {
    mrBranches?: ReadonlyMap<string, readonly MrBranchFact[]>;
    projectOf?: ReadonlyMap<string, string>;
  } = {},
): boolean {
  const key = issueKey(row);
  if (c.branch) {
    for (const f of opts.mrBranches?.get(sessionId) ?? []) {
      if (f.branch === c.branch && issueKey({ ref: f.ref, kind: "merge_request" }) === key) return true;
    }
  }
  const identity = opts.projectOf?.get(sessionId) ?? null;
  const bareOk = !!identity && /^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?\//i.test(identity);
  // Review B4: the sigil written in the subject decides the kind — a `#N` is an issue. Only on
  // GitHub, where an issue and a PR share one number space, may it name a PR row too.
  const rowHost =
    /^([a-z0-9-]+(?:\.[a-z0-9-]+)+)\//i.exec(row.ref)?.[1] ?? (bareOk ? identity?.split("/")[0] : undefined);
  const github = !!rowHost && /(^|\.)github\.[a-z]+$/i.test(rowHost);
  if (row.kind === "merge_request" && !github) return false;
  for (const written of commitSubjectRefs(c.subject, bareOk)) {
    const canon = canonicalItemRef(written, bareOk ? identity : null, row.kind);
    if (canon && issueKey({ ref: canon.ref, kind: row.kind }) === key) return true;
  }
  return false;
}

export function aggregateIssueAttribution(
  sessions: AgentStatsSessionInput[],
  commits: CommitEvent[],
  storedRows: readonly SessionIssueRow[],
  opts: {
    /** S06: child session id -> parent id (subAgentParents). A child counts as its parent's session; its cost follows its own rows, or with none the parent's items (D-066, child-pricing.ts). */
    parentOf?: ReadonlyMap<string, string>;
    /** v4 item 2: each session's observed MR source branches (mrBranchesBySession). */
    mrBranches?: ReadonlyMap<string, readonly MrBranchFact[]>;
    /** v4 item 2: each session's project `repo_identity` — a bare `#N` in a commit subject names that repo's item. */
    projectOf?: ReadonlyMap<string, string>;
    /** `${session_id}\u0000${idx}` of every turn carrying an observed action (actionTurnKeys) — where links land. */
    actionTurns?: ReadonlySet<string>;
  } = {},
): AggregateIssueAttributionResult {
  const parentOf = opts.parentOf ?? new Map<string, string>();
  // One row per item: a discussed-only GitHub row takes the kind the item was observed as.
  // v4 item 7: the role comes from the stored verbs, never from an older model pass.
  const issueRows = foldDiscussedKinds(storedRows).map((r) => {
    const role = roleFromStoredVerbs(r);
    return role === r.role ? r : { ...r, role };
  });
  const issueKey = issueKeyFor(issueRows);
  const commitTiedTo = (c: CommitEvent, row: SessionIssueRow, sessionId: string): boolean =>
    commitTiedToItem(c, row, sessionId, issueKey, opts);
  const commitsBySession = new Map<string, CommitEvent[]>();
  for (const c of commits) {
    const list = commitsBySession.get(c.sessionId);
    if (list) list.push(c);
    else commitsBySession.set(c.sessionId, [c]);
  }
  const rowsBySession = new Map<string, SessionIssueRow[]>();
  for (const r of issueRows) {
    const list = rowsBySession.get(r.session_id);
    if (list) list.push(r);
    else rowsBySession.set(r.session_id, [r]);
  }

  const buckets = new Map<string, { ref: string; kind: SessionIssueRow["kind"]; bucket: MutableBucket }>();
  const bucketFor = (row: SessionIssueRow) => {
    const key = issueKey(row);
    const found = buckets.get(key);
    if (found) {
      found.ref = preferredRef(found.ref, row.ref);
      return found.bucket;
    }
    const bucket = emptyMutableBucket();
    buckets.set(key, { ref: row.ref, kind: row.kind, bucket });
    return bucket;
  };
  const unattributed = emptyMutableBucket();
  // D-066: a session "has rows" for pricing only when one of them prices under D-056.
  const pricedSessionIds = new Set(issueRows.filter((r) => rowCarriesCost(r)).map((r) => r.session_id));

  const rootOf = (id: string): string => {
    const seen = new Set<string>([id]);
    let cur = id;
    for (let p = parentOf.get(cur); p !== undefined && !seen.has(p); p = parentOf.get(cur)) {
      seen.add(p);
      cur = p;
    }
    return cur;
  };

  for (const s of sessions) {
    const sessionCommits = commitsBySession.get(s.id) ?? [];
    const ownRows = rowsBySession.get(s.id) ?? [];
    // D-066 (child-pricing.ts, shared with Today): a sub-agent child is COUNTED as its parent's
    // session. With rows of its own, its cost follows only those rows. With none, it is priced on the
    // nearest ancestor's items in that ancestor's proportions (priced rows only, D-056), never on the
    // parent's focus at spawn time (inference, D-055); no priced ancestor leaves it unattributed.
    const costParent = costParentOf(s.id, parentOf, (id) => pricedSessionIds.has(id));
    // Every session in a chain counts as its chain root (Today's recursive ownerOf does the same).
    const countId = rootOf(s.id);
    // One row per (ref, kind): the strongest role wins when a session has several.
    const strongestPerRef = (list: readonly SessionIssueRow[]) => {
      const out = new Map<string, SessionIssueRow>();
      for (const r of list) {
        const key = issueKey(r);
        const prev = out.get(key);
        const stronger =
          !prev ||
          ROLE_RANK[r.role] > ROLE_RANK[prev.role] ||
          (ROLE_RANK[r.role] === ROLE_RANK[prev.role] && (rowShare(r) ?? 0) > (rowShare(prev) ?? 0));
        if (stronger) out.set(key, r);
      }
      return out;
    };
    // The session's own rows drive its roles, links and mentions; the rows that SPLIT its cost are
    // the cost-parent's when it is row-less for pricing.
    const ownByRef = strongestPerRef(ownRows);
    const splitByRef = costParent ? strongestPerRef(rowsBySession.get(costParent) ?? []) : ownByRef;
    const split = (byRef: Map<string, SessionIssueRow>) => {
      const workedOn = new Map<string, SessionIssueRow>();
      const costed = new Map<string, SessionIssueRow>();
      for (const [key, r] of byRef) {
        if (r.role === "worked_on") workedOn.set(key, r);
        if (r.role === "worked_on" || r.role === "discussed") costed.set(key, r);
      }
      return { workedOn, costed };
    };
    // Own rows decide sessions, mentions and commit ties; ONLY the shares (cost, tokens, turns)
    // come from the cost-parent's rows when this session is row-less for pricing (D-066).
    const { workedOn, costed: ownCosted } = split(ownByRef);
    const { workedOn: splitWorkedOn, costed } = split(splitByRef);
    for (const [, r] of ownByRef) {
      if (!(r.role === "worked_on" || r.role === "discussed")) bucketFor(r).mentionSessionIds.add(countId);
      if (r.role === "discussed") bucketFor(r).mentionSessionIds.add(countId);
      noteRow(bucketFor(r), r);
      // The #turn anchor only when the row is this session's own (a folded child's turn index belongs to the child).
      const turnMap = bucketFor(r).turnIdxBySession;
      if (r.session_id === countId && typeof r.turn_idx === "number" && !turnMap.has(countId))
        turnMap.set(countId, r.turn_idx);
      // The link: an action turn wins over a turn without one (a parent's sub-agent spawn row);
      // among action turns the counted session's own comes first.
      if (typeof r.turn_idx === "number") {
        const links = bucketFor(r).linkBySession;
        const cand = {
          session_id: r.session_id,
          turn_idx: r.turn_idx,
          action: !!opts.actionTurns?.has(`${r.session_id}\u0000${r.turn_idx}`),
          rank: ROLE_RANK[r.role] ?? 0,
        };
        const prev = links.get(countId);
        // An action turn first; then the stronger row (a comment beats a passing view); then the counted session's own.
        const better =
          !prev ||
          (cand.action && !prev.action) ||
          (cand.action === prev.action &&
            (cand.rank > prev.rank ||
              (cand.rank === prev.rank && cand.session_id === countId && prev.session_id !== countId)));
        if (better) links.set(countId, cand);
      }
    }

    const usage = asRawUsage(s.props?.usage);
    const models = asModelList(s.props?.models);
    const cost = usage ? computeCost(usage, models[0]) : undefined;
    const turnCount = s.turn_count ?? 0;

    // Every session that touched the ref (worked_on or discussed) counts on it — a discussed-only
    // ref never reads "Sessions 0" (maintainer, review NIT 8). Commits tie to the session's OWN rows.
    for (const [, row] of ownCosted) {
      bucketFor(row).sessionIds.add(countId);
      if (row.role === "worked_on")
        for (const c of sessionCommits) if (commitTiedTo(c, row, s.id)) addCommit(bucketFor(row), c);
    }

    if (costed.size === 0) {
      unattributed.sessionIds.add(countId);
      unattributed.turns += turnCount;
      if (cost && usage) {
        unattributed.pricedCostSum += cost.amount;
        unattributed.pricedSessionCount += 1;
        addScaledUsage(unattributed.tokens, usage, 1);
      } else {
        unattributed.unpricedSessionCount += 1;
      }
    } else {
      // Shares: turn_share where the rows carry it; otherwise (pre-W4 rows) an
      // equal split across the worked_on rows.
      const shares = new Map<string, number>();
      const anyShare = [...costed.values()].some((r) => rowShare(r) !== null);
      // v4 item 1: a share prices only a row whose verbs are build evidence (or an MR review);
      // a triage/comment/close-only row derived before v4 keeps its verbs, never its share.
      if (anyShare) {
        for (const [key, r] of costed) shares.set(key, rowCarriesCost(r) ? (rowShare(r) ?? 0) : 0);
      } else {
        const priced = [...splitWorkedOn].filter(([, r]) => rowCarriesCost(r));
        for (const [key] of priced) shares.set(key, 1 / priced.length);
      }
      let claimed = 0;
      for (const v of shares.values()) claimed += v;
      if (claimed > 1) {
        for (const [key, v] of shares) shares.set(key, v / claimed);
        claimed = 1;
      }

      for (const [key, row] of costed) {
        const share = shares.get(key) ?? 0;
        const bucket = bucketFor(row);
        bucket.turns += anyShare ? Math.round(turnCount * share) : turnCount;
        if (cost && usage && share > 0) {
          bucket.pricedCostSum += cost.amount * share;
          bucket.pricedSessionCount += 1;
          addScaledUsage(bucket.tokens, usage, share);
        }
        bucket.sessionIds.add(countId);
        if (!cost || !usage) bucket.unpricedSessionCount += 1;
      }
      // The share no ref claimed stays with the session.
      const rest = 1 - claimed;
      if (rest > 1e-9) {
        unattributed.turns += anyShare ? Math.round(turnCount * rest) : 0;
        if (cost && usage) {
          unattributed.pricedCostSum += cost.amount * rest;
          unattributed.pricedSessionCount += 1;
          addScaledUsage(unattributed.tokens, usage, rest);
        }
      }
    }
    for (const c of sessionCommits) {
      if (![...workedOn.values()].some((r) => commitTiedTo(c, r, s.id))) addCommit(unattributed, c);
    }
  }

  // S06: a child folded into a parent that is counted on a ref is not also an unattributed session.
  for (const { bucket } of buckets.values()) for (const id of bucket.sessionIds) unattributed.sessionIds.delete(id);

  const issues = [...buckets.values()]
    .map(({ ref, kind, bucket }) => finalizeBucket(ref, kind, bucket))
    .sort((a, b) => {
      const costA = a.costUsd ?? -1;
      const costB = b.costUsd ?? -1;
      if (costA !== costB) return costB - costA;
      return (a.issue ?? "").localeCompare(b.issue ?? "");
    });

  return { issues, unattributed: finalizeBucket(null, null, unattributed), estimated: true };
}

/**
 * UX W5: every row (and the unattributed bucket) with its sessions as
 * titled refs, newest first — `titles` comes from ONE lookup over every id
 * the result references (the route calls lookupTitlesOnce with
 * `issueSessionIds`). Pure.
 */
export function withIssueSessionRefs<T extends { issues: IssueAttribution[]; unattributed: IssueAttribution }>(
  result: T,
  titles: ReadonlyMap<string, SessionTitleInfo>,
): T {
  const attach = (row: IssueAttribution): IssueAttribution => ({
    ...row,
    sessionRefs: toSessionRefs(
      row.sessionIds,
      titles,
      (id) => row.linkBySession?.[id]?.turn_idx ?? row.turnIdxBySession[id],
      (id) => row.linkBySession?.[id]?.session_id,
    ),
  });
  return { ...result, issues: result.issues.map(attach), unattributed: attach(result.unattributed) };
}

/** Every session id an Issues result references — the one title lookup's input. */
export function issueSessionIds(row: Pick<IssueAttribution, "sessionIds">): string[] {
  return row.sessionIds;
}
