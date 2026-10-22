// D-057 evaluation core (docs/design/session-issue-association.md §7): run one
// fixture case through the same path production uses — parse → ground (observed
// profile, D-053 inference OFF) → association call → the two overrides — and
// score EVERY build action the model linked against the case's expectation.
//
// Scoring (review B5):
//   - every build action (edit, commit, push; timed or untimed sub-agent) has an
//     expected item or null: a commit's comes from `expected` by sha (a commit
//     missing from `expected` expects null); an edit expects what the next commit
//     of the same (sub-)session expects; a push what the last commit on its
//     branch expects;
//   - a link is correct only when its FULL identity — repo, kind, number —
//     equals the expected item (or an `alsoOk` item); anything else, including
//     another repo's #41 or PR #41 for issue #41, is wrong;
//   - a link to a `mustNot` item is wrong whatever the expectation;
//   - recall: build actions with a non-null expectation that got exactly it.
// A link counts as wrong if ANY run produces it (the script aggregates runs).
// Pure apart from the injected LLM; never writes anywhere.

import type { BuildTrace, KnownBranchMr, ProfileChildSession, ProfileTrace } from "@/lib/code-sessions/profile";
import type { LlmClient } from "@/lib/llm/client";
import { groundSessionIssues, type IssueGroundingTurn } from "./extract";
import {
  type AssocCandidate,
  type AssocSegment,
  type AssocStatus,
  applyAssociation,
  callAssociation,
  candidatesFromTurns,
  claimedBuilds,
  finalizeCandidates,
} from "./session-association";

export const EVAL_PROJECT = "github.com/acme/billing";

export type EvalSet = "d053" | "pivot" | "return" | "confusable" | "robustness";

/**
 * An item as a case writes it: `#41` (issue of the eval repo), `!60` (its
 * PR), or `owner/repo#41` / `host/owner/repo#41` (an issue elsewhere).
 */
export type CaseRef = string;

/** One expected link: the commit `sha` should land on `ref` (null = on nothing). */
export interface ExpectedLink {
  sha: string;
  ref: CaseRef | null;
  /** Other outcomes that are not wrong. */
  alsoOk?: CaseRef[];
}

export interface EvalCase {
  id: string;
  set: EvalSet;
  description: string;
  turns: IssueGroundingTurn[];
  candidates: AssocCandidate[];
  /** Every commit of the session, by sha. */
  expected: ExpectedLink[];
  /** Items no build action of this session may be linked to. */
  mustNot: CaseRef[];
  extra?: { startBranch?: string; knownBranches?: KnownBranchMr[]; childSessions?: ProfileChildSession[] };
}

/** Full identity: lower-cased qualified ref + kind. */
export function identityOf(ref: CaseRef): string {
  const m = /^(.*?)([#!])(\d+)$/.exec(ref.trim());
  if (!m) return ref.toLowerCase();
  const kind = m[2] === "!" ? "merge_request" : "issue";
  const prefix = m[1] ? (m[1].split("/").length >= 3 ? m[1] : `github.com/${m[1]}`) : EVAL_PROJECT;
  return `${prefix.toLowerCase()}#${m[3]}|${kind}`;
}

export function linkIdentity(ref: string, kind: string | null): string {
  return `${ref.toLowerCase()}|${kind ?? "issue"}`;
}

export interface EvalLink {
  caseId: string;
  verb: string;
  sha?: string;
  file?: string;
  branch?: string;
  turn: number;
  ref: string;
  kind: string | null;
  fromTurn: number;
  toTurn: number;
  evidence: { turn: number; quote: string }[];
  reason: string;
  verdict: "correct" | "wrong";
  expected: CaseRef | null;
}

export interface EvalMiss {
  caseId: string;
  verb: string;
  sha?: string;
  turn: number;
  expected: CaseRef;
}

export interface EvalCaseResult {
  caseId: string;
  set: EvalSet;
  status: AssocStatus | "not_candidate";
  costUsd: number;
  links: EvalLink[];
  /** Build actions with a non-null expectation the run did not link to it. */
  missed: EvalMiss[];
  /** Build actions with a non-null expectation (recall's denominator). */
  expectedLinks: number;
  segments: AssocSegment[];
}

/** Ground a case the way production does (flag-independent observed profile), returning the trace. */
export function groundCase(c: EvalCase): {
  trace: ProfileTrace | undefined;
  rows: ReturnType<typeof groundSessionIssues>;
} {
  const trace: { value?: ProfileTrace } = {};
  const rows = groundSessionIssues([], c.turns, EVAL_PROJECT, {
    actionsVersion: 1,
    inferRef: false,
    trace,
    ...(c.extra?.startBranch ? { startBranch: c.extra.startBranch } : {}),
    ...(c.extra?.knownBranches ? { knownBranches: c.extra.knownBranches } : {}),
    ...(c.extra?.childSessions ? { childSessions: c.extra.childSessions } : {}),
  });
  return { trace: trace.value, rows };
}

/** The case's candidates plus what the session's own actions show (as production's fetchAssocCandidates). */
export function caseCandidates(c: EvalCase): AssocCandidate[] {
  const map = new Map<string, AssocCandidate>();
  candidatesFromTurns([...c.turns, ...(c.extra?.childSessions ?? []).flatMap((s) => s.turns)], EVAL_PROJECT, map);
  // The case's titled candidates win over what the turns showed.
  for (const k of c.candidates) {
    const q = k.ref.startsWith("#") ? `${EVAL_PROJECT}${k.ref}` : k.ref;
    for (const [key, v] of map) if (v.ref === q && v.kind === k.kind) map.delete(key);
    map.set(`${k.kind}\u0000${q}`, { ...k, ref: q });
  }
  return finalizeCandidates(map, EVAL_PROJECT);
}

/** The expectation of every build action (see the header). */
export function expectationOf(c: EvalCase, trace: ProfileTrace): Map<BuildTrace, ExpectedLink | null> {
  const out = new Map<BuildTrace, ExpectedLink | null>();
  const bySha = (sha: string | undefined) =>
    sha ? (c.expected.find((e) => sha.startsWith(e.sha) || e.sha.startsWith(sha)) ?? null) : null;
  const builds = trace.builds;
  builds.forEach((b, i) => {
    if (b.verb === "committed") {
      out.set(b, bySha(b.sha) ?? { sha: b.sha ?? "?", ref: null });
      return;
    }
    if (b.verb === "edited") {
      const next = builds.slice(i + 1).find((x) => x.verb === "committed" && x.child === b.child);
      out.set(b, next ? (bySha(next.sha) ?? { sha: next.sha ?? "?", ref: null }) : null);
      return;
    }
    const prev = builds
      .slice(0, i)
      .reverse()
      .find((x) => x.verb === "committed" && (!b.branch || x.branch === b.branch));
    out.set(b, prev ? (bySha(prev.sha) ?? { sha: prev.sha ?? "?", ref: null }) : null);
  });
  return out;
}

/** Score one case's segments. Pure. */
export function scoreCase(
  c: EvalCase,
  segments: readonly AssocSegment[],
  trace: ProfileTrace | undefined,
): { links: EvalLink[]; missed: EvalMiss[]; expectedLinks: number } {
  const links: EvalLink[] = [];
  if (!trace) {
    const expectedLinks = c.expected.filter((e) => e.ref !== null).length;
    return { links, missed: [], expectedLinks };
  }
  const expect = expectationOf(c, trace);
  const mustNot = new Set(c.mustNot.map(identityOf));
  const linked = new Map<BuildTrace, string>();
  for (const seg of segments) {
    if (!seg.ref) continue;
    const id = linkIdentity(seg.ref, seg.kind);
    for (const b of claimedBuilds(seg, trace)) {
      linked.set(b, id);
      const exp = expect.get(b) ?? null;
      const ok =
        !mustNot.has(id) &&
        !!exp?.ref &&
        (identityOf(exp.ref) === id || (exp.alsoOk ?? []).some((r) => identityOf(r) === id));
      links.push({
        caseId: c.id,
        verb: b.verb,
        ...(b.sha ? { sha: b.sha } : {}),
        ...(b.file ? { file: b.file } : {}),
        ...(b.branch ? { branch: b.branch } : {}),
        turn: b.mainIdx,
        ref: seg.ref,
        kind: seg.kind,
        fromTurn: seg.from_turn,
        toTurn: seg.to_turn,
        evidence: seg.evidence,
        reason: seg.reason,
        verdict: ok ? "correct" : "wrong",
        expected: exp?.ref ?? null,
      });
    }
  }
  const missed: EvalMiss[] = [];
  let expectedLinks = 0;
  for (const [b, exp] of expect) {
    if (!exp?.ref || b.landed !== null) continue;
    expectedLinks += 1;
    if (linked.get(b) !== identityOf(exp.ref))
      missed.push({ caseId: c.id, verb: b.verb, ...(b.sha ? { sha: b.sha } : {}), turn: b.mainIdx, expected: exp.ref });
  }
  return { links, missed, expectedLinks };
}

/** Run one case through the association with `llm`. Never throws. */
export async function runEvalCase(llm: LlmClient, c: EvalCase): Promise<EvalCaseResult> {
  const { trace, rows } = groundCase(c);
  if (!trace || !trace.builds.some((b) => b.landed === null)) {
    const { expectedLinks } = scoreCase(c, [], trace);
    return {
      caseId: c.id,
      set: c.set,
      status: "not_candidate",
      costUsd: 0,
      links: [],
      missed: [],
      expectedLinks,
      segments: [],
    };
  }
  const res = await callAssociation(llm, {
    sessionId: `eval:${c.id}`,
    projectIdentity: EVAL_PROJECT,
    turns: c.turns,
    trace,
    candidates: caseCandidates(c),
    childSessions: c.extra?.childSessions ?? [],
  });
  // Exercise the production merge too (it must accept whatever validated).
  applyAssociation(rows, res.segments, trace, EVAL_PROJECT);
  const { links, missed, expectedLinks } = scoreCase(c, res.segments, trace);
  return {
    caseId: c.id,
    set: c.set,
    status: res.status,
    costUsd: res.costUsd,
    links,
    missed,
    expectedLinks,
    segments: res.segments,
  };
}

export interface EvalSetSummary {
  set: string;
  cases: number;
  linksMade: number;
  correct: number;
  wrong: number;
  expectedLinks: number;
  precision: number | null;
  recall: number | null;
  malformedOrFailed: number;
  overCap: number;
}

/** Precision = correct ÷ links made (every build action scored); recall = correct expected links ÷ expected links. Per set, one run. */
export function summarize(cases: readonly EvalCase[], results: readonly EvalCaseResult[]): EvalSetSummary[] {
  const sets = [...new Set(cases.map((c) => c.set))];
  return sets.map((set) => {
    const rs = results.filter((r) => r.set === set);
    const links = rs.flatMap((r) => r.links);
    const correct = links.filter((l) => l.verdict === "correct").length;
    const wrong = links.length - correct;
    const expectedLinks = rs.reduce((n, r) => n + r.expectedLinks, 0);
    const hit = expectedLinks - rs.reduce((n, r) => n + r.missed.length, 0);
    return {
      set,
      cases: cases.filter((c) => c.set === set).length,
      linksMade: links.length,
      correct,
      wrong,
      expectedLinks,
      precision: links.length > 0 ? correct / links.length : null,
      recall: expectedLinks > 0 ? hit / expectedLinks : null,
      malformedOrFailed: rs.filter((r) => r.status !== "ok" && r.status !== "not_candidate" && r.status !== "over_cap")
        .length,
      overCap: rs.filter((r) => r.status === "over_cap").length,
    };
  });
}
