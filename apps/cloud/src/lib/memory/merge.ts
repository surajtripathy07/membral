// Memory v1, source C — grounding + merge (docs/design/memory-v1.md §2, §3
// "Shared by all three": idempotency + cross-window dedupe).
//
// GROUNDING: `quote` must normalize to an exact substring of SOME turn in
// the session — checked at the model's claimed `turn_idx` first, then by an
// exact-quote search across every turn, REPAIRING `turn_idx` on a hit (so a
// parser reindex can't silently unverify every record). For `kind ===
// "outcome"`, `ref` must also appear in the receipt turn's `props.
// inputDigest` or its `text` — matching the DB check
// `(verified = false or quote is not null or kind = 'outcome')`, an outcome
// CAN be verified with no quote at all, purely via the ref check.
//
// MERGE (no second LLM pass): first collapse exact `content_hash` matches
// (free — every record already carries a verbatim quote + turn index, so
// "same record" is mechanical), THEN collapse embedding cosine >= 0.93
// matches, in both cases keeping the LATER window's record. KNOWN
// LIMITATION (explicit per the design's own build-plan step 4): receipts are
// NOT unioned when two windows produce the same record — the later window's
// single receipt (quote/turn_idx/turn_role) replaces the earlier one
// wholesale, because `session_memories` has exactly one receipt column set
// per row (§2: turn_idx is a plain int, not an array). A future schema
// change to a receipts array would be needed to actually union them.
//
// DETERMINISTIC FIXES (step2b, docs/goals/2026-09-13_memory-v1-build_goal.md
// finding table): `applyDeterministicFixes` runs BEFORE grounding, on the
// model's raw output, in this fixed order —
//   1. G — blocker durable override (resolved_in_session -> durable).
//   2. E — ref repair from the receipt turn's digest/text when the model's
//      `ref` doesn't literally appear there; a range ref splits into one
//      record per member only when every member is present.
//   3. D — classifyRef overrides `ref_kind` from the (repaired) ref's shape.
//   4. F — phone/email redaction on text/quote/ref/thread, plus (step2d
//      finding 2) an outcome `ref` that is an absolute/home-relative path is
//      made repo-relative when inside the repo, kept as-is when outside it;
//      an outcome whose `ref` still carries a redaction marker afterward is
//      DROPPED (never stored with a scrubbed, unusable ref) and counted in
//      `dropped_pii`.
import { createHash } from "node:crypto";
import { redactPii } from "@membral/core";
import { vectorThreshold } from "@/lib/llm/embedding-family";
import { log } from "@/lib/log";
import { cosineSimilarity } from "./embed";
import { type GroundingFailure, groundAgainstTurns, groundRefIssue, groundRefTitle } from "./grounding";
import { normalizeQuote } from "./normalize";
import { relativizeRefPath, toRepoRelativePath } from "./paths";
import { classifyRef, isBranchShaped, isBranchWellKnown } from "./ref-kind";
import { detectOutcomeHints, type OutcomeHint, type TurnRole, type TurnRow } from "./render";
import type { MemoryKind, MemoryRecordParsed, RefKind } from "./schema";

/**
 * Issue #162: three steps below drop a record after it already passed Zod,
 * with no trace of why. Every one of those drops — and every repair that
 * keeps a record instead — now emits exactly one line here, via the same
 * structured logger the rest of lib/memory uses (`@/lib/log`). Never logs
 * `text`/`quote`/`thread` — those ARE the personal data these steps process,
 * only the classification is safe to log.
 */
function logMergeFix(step: string, action: "dropped" | "repaired", kind: MemoryKind, reason: string): void {
  log.warn(`memory-merge: ${action}`, { step, action, kind, reason });
}

export interface GroundedRecord {
  windowIndex: number;
  kind: MemoryKind;
  text: string;
  quote: string | null;
  turn_idx: number;
  turn_role: TurnRole;
  ref: string | null;
  ref_kind: RefKind | null;
  /** D10 (migration 117): the ref's title, verbatim in the receipt turn; null when absent or ungrounded. */
  ref_title?: string | null;
  /** D10 (migration 117): on an MR/PR ref, the issue it addresses — only when the stored quote names both. */
  ref_issue?: string | null;
  /** D10 (migration 117): "stated" | "inferred" — set exactly when ref_issue is. */
  ref_issue_basis?: "stated" | "inferred" | null;
  durable: boolean;
  thread: string | null;
  scope: "project" | "global";
  confidence: number;
  verified: boolean;
  contentHash: string;
  paths: string[];
  /** Why grounding failed (`null` when verified) — the caller stores it as `retire_reason = "unverified:<reason>"` (D3 decision B). */
  unverifiedReason?: GroundingFailure | null;
  /** step2d finding 15: true when no receipt turn resolved at all (by idx or by quote) — `turn_idx` was clamped to the session's last turn rather than left pointing at nothing. Counted by the caller as `dangling_receipts`. */
  dangling: boolean;
  /** Review v6 R2-m4: written by the user-turn pass — stored as `extraction_pass = 'user'` so --reverify keeps the user-turns-only constraint. */
  userPass?: boolean;
  /** C-6/migration 107: the owner's own priority flag, re-gated here against the GROUND-TRUTH receipt turn role (never the model's claim) the same way `turn_role` above is — `raw.priority` already survived `parseMemoryRecord`'s kind/turn_role gate, but that gate trusted the model's `turn_role`, not the resolved receipt turn's. */
  priority: boolean;
  /** Prompt v12: the offered open blocker (another session's live row id) the extraction call judged this blocker the same problem as — write.ts's `dropCrossSessionDuplicates` links the recurrence chain on it before any cosine fallback. */
  recursOfHint?: string;
}

/** Whitespace-only normalization for the quote<->turn-text substring check — NEVER case-folds, so "exact substring" stays exact. */
export function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Looser normalization for content_hash stability (case + whitespace) — a
 * re-run that gets byte-identical model output modulo casing/spacing must
 * still hash the same. Exported (step2e finding 4, issue #151) so write.ts's
 * `supersedeRecords` can detect a CROSS-SESSION duplicate by `text` alone —
 * see its own doc comment.
 */
export function normalizeForHash(s: string): string {
  return normalizeWhitespace(s).toLowerCase();
}

/**
 * UX W6 ("You said" shown twice, differing only in a trailing '.'): the key
 * write.ts compares a new record against LIVE stored records on —
 * `normalizeForHash` (case + whitespace) with any trailing punctuation run
 * dropped, the same trailing set Today's `normalizeQuote` drops. Interior
 * punctuation is kept, so "#12, #3" and "#123" stay distinct. NOT used for
 * `content_hash` (that stays byte-stable across releases).
 */
export function normalizeForDedup(s: string): string {
  return normalizeForHash(s).replace(/[\s.,;:!?…'"”’)\]]+$/u, "");
}

export function computeContentHash(text: string, receiptTurnText: string, promptVersion: string): string {
  return createHash("sha256")
    .update(`${normalizeForHash(text)}\n${receiptTurnText}\n${promptVersion}`)
    .digest("hex");
}

function findTurnByIdx(turns: TurnRow[], idx: number): TurnRow | undefined {
  return turns.find((t) => t.idx === idx);
}

function checkOutcomeRef(ref: string | undefined, turn: TurnRow | undefined): boolean {
  if (!ref || !turn) return false;
  const digest = typeof turn.props?.inputDigest === "string" ? turn.props.inputDigest : "";
  return digest.includes(ref) || (turn.text ?? "").includes(ref);
}

// --- Finding G: a blocker's durable is earned deterministically, never guessed mid-arc.

/** Finding G: for kind "blocker" with an answered `resolved_in_session`, `durable` is computed — never taken from the model's own guess — as `!resolved_in_session`. Every other kind, and a blocker where the model left `resolved_in_session` unanswered, keeps the model's `durable` untouched (mid-session check-ins may omit it; §3 says only the end check-in/tail capture may judge durability, and tail capture always sees the whole excerpt, so an omission here is a model miss, not a designed gap — falling back to its own `durable` is still safer than assuming either true or false). */
export function applyBlockerDurableOverride(raw: MemoryRecordParsed): MemoryRecordParsed {
  if (raw.kind !== "blocker" || raw.resolved_in_session === undefined) return raw;
  return { ...raw, durable: !raw.resolved_in_session };
}

// --- Finding E: ref repair from the receipt turn's digest/text.

const RANGE_REF = /^#?(\d+)\s*-\s*#?(\d+)$/;
/** Max members a range ref is allowed to expand to — a guard against a garbled model answer like "#1-#99999" silently generating tens of thousands of records. */
const MAX_RANGE_MEMBERS = 25;

/** Finding E: `#133-#138` -> `["#133", ..., "#138"]`, or `null` when `ref` isn't range-shaped or the range is absurdly large. */
export function splitRangeRef(ref: string): string[] | null {
  const m = ref.trim().match(RANGE_REF);
  if (!m) return null;
  const start = Number(m[1]);
  const end = Number(m[2]);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || end - start + 1 > MAX_RANGE_MEMBERS) {
    return null;
  }
  const members: string[] = [];
  for (let n = start; n <= end; n++) members.push(`#${n}`);
  return members;
}

// step2e finding 2 (docs/goals/2026-09-13_memory-v1-build_goal.md; issue
// #151): a sha found by a bare scan is only trustworthy near the same
// commit/sha/hash keyword attribution.ts's own `SHA_NEAR_KEYWORD_RE`
// requires (lib/agent-stats/attribution.ts's header: "never a bare hex
// scan, to avoid matching incidental hex-looking words") — a bare scan over
// a whole turn's prose can just as easily land on a dummy PAN number or a
// phone number that happens to satisfy the hex shape.
const SHA_NEAR_KEYWORD = /\b(?:commit(?:t?ed|ting)?|sha|hash)\b[^\n]{0,40}?\b([0-9a-f]{7,40})\b/i;

/** Finding E: the best sha/`#N`/URL the receipt turn's digest or text actually contains, for repairing a ref the model got wrong (a file path, a range, or anything else that isn't literally present). `null` when nothing better is found. */
export function findRefInDigestOrText(turn: TurnRow | undefined): string | null {
  if (!turn) return null;
  const digest = typeof turn.props?.inputDigest === "string" ? turn.props.inputDigest : "";
  const haystack = `${digest}\n${turn.text ?? ""}`;
  const url = haystack.match(/https?:\/\/\S+/);
  if (url) return url[0].replace(/[)\].,;:'"]+$/, "");
  const sha = haystack.match(SHA_NEAR_KEYWORD);
  if (sha) return sha[1];
  const issue = haystack.match(/#\d+/);
  if (issue) return issue[0];
  return null;
}

// --- step2e finding 1/2: corroborating an ambiguously-shaped ref before trusting it.

/** Finding 1: a bare integer (`"42"` or `"#42"`) is only trustworthy as an issue reference when the receipt turn's OWN digest/text contains that exact `#N` token or an issue URL ending `/issues/N` — otherwise it is far more likely the model echoing some other number entirely (a turn index, per finding 1's mechanism below). */
function isIssueRefCorroborated(ref: string, turn: TurnRow | undefined): boolean {
  if (!turn) return false;
  const n = ref.trim().replace(/^#/, "");
  const digest = typeof turn.props?.inputDigest === "string" ? turn.props.inputDigest : "";
  const haystack = `${digest}\n${turn.text ?? ""}`;
  return new RegExp(`#${n}\\b`).test(haystack) || new RegExp(`/issues/${n}\\b`).test(haystack);
}

/** Finding 2: a ref shaped like a hex sha is only trustworthy as "commit" when the receipt turn is itself a `git commit`/`git push` tool call (the ref IS that action), or the exact ref token sits within 40 chars of a commit/sha/hash keyword somewhere in the turn — the same bar attribution.ts holds a sha to. A dummy PAN/phone-shaped string that merely co-occurs in the turn's prose fails this. */
function isCommitRefCorroborated(ref: string, turn: TurnRow | undefined): boolean {
  if (!turn) return false;
  const digest = typeof turn.props?.inputDigest === "string" ? turn.props.inputDigest : "";
  if (/\bgit\s+(?:commit|push)\b/.test(digest)) return true;
  const haystack = `${digest}\n${turn.text ?? ""}`;
  const re = new RegExp(SHA_NEAR_KEYWORD.source, "gi");
  let m: RegExpExecArray | null = re.exec(haystack);
  while (m) {
    if (m[1].toLowerCase() === ref.toLowerCase()) return true;
    m = re.exec(haystack);
  }
  return false;
}

// --- step2e finding 1: a "commit: <subject>" quote is the Delivered-block hint's own text, not a transcript line.

const COMMIT_QUOTE_PREFIX = /^commit:\s*/i;

function extractShaFromHint(hint: string): string | null {
  const m = hint.match(/\bsha=([0-9a-f]{7,40})\b/i);
  return m ? m[1] : null;
}

function findMatchingCommitHint(quote: string, turns: TurnRow[]): OutcomeHint | undefined {
  const q = quote.trim();
  const hints = detectOutcomeHints(turns).filter((h) => h.hint.toLowerCase().startsWith("commit:"));
  return hints.find((h) => h.hint === q || h.hint.startsWith(q) || q.startsWith(h.hint));
}

/**
 * Finding 1 (step2e, issue #151): a `quote` of the shape "commit: <subject>"
 * is not a transcript line at all — it is the model echoing render.ts's own
 * `renderDeliveredBlock` hint text, because a Bash `git commit` tool_use
 * turn renders to the model as a bare `[tool: Bash]` with nothing quotable
 * in it. The hint's OWN `[#N]` prefix is that turn's line number, not an
 * issue — the two fabrication patterns this fixes are the model copying
 * that N into `ref` and calling it `#N`/`ref_kind:"issue"` (six of the
 * sample's twenty outcomes), or copying the bare word "commit" itself into
 * `ref`. Both the receipt (`turn_idx`/`turn_role`) and `ref` are re-derived
 * from the SAME deterministic hint detection the header already showed the
 * model (never re-trusting anything the model wrote), and the synthesized
 * quote is dropped — finding 3 forbids ever storing a synthesized "commit:"
 * prefix as if it were verbatim transcript text, and there is nothing
 * verbatim to quote from a Bash tool_use turn's rendered line regardless.
 * Returns `[]` ("hallucinated ref", counted by the caller) when no matching
 * hint exists or the matching hint carries no sha.
 */
/**
 * D10: a record whose `ref` is swapped (repaired, split from a range, or
 * re-derived from a commit hint) loses `ref_title`/`ref_issue` — they were
 * claimed about the ORIGINAL ref and never carry over to another one.
 */
export function withSwappedRef(
  raw: MemoryRecordParsed,
  patch: Partial<MemoryRecordParsed> & { ref: string },
): MemoryRecordParsed {
  const next = { ...raw, ...patch };
  return patch.ref === raw.ref ? next : stripRefExtras(next);
}

/** D10: the record without `ref_title`/`ref_issue`. */
export function stripRefExtras(r: MemoryRecordParsed): MemoryRecordParsed {
  const { ref_title: _title, ref_issue: _issue, ref_issue_basis: _basis, ...rest } = r;
  return rest;
}

function resolveCommitHintedOutcome(raw: MemoryRecordParsed, turns: TurnRow[]): MemoryRecordParsed[] {
  const hint = findMatchingCommitHint(raw.quote ?? "", turns);
  if (!hint) {
    logMergeFix("hallucinated_ref", "dropped", raw.kind, "commit-shaped quote matched no Delivered-block hint");
    return [];
  }

  const sha = extractShaFromHint(hint.hint);
  if (sha) {
    // N1 (review round 2): only log "repaired" when the ref itself actually
    // changed — a hint that merely reconfirms the model's own ref is not a
    // repair, and the diff-based counter (applyDeterministicFixes) agrees.
    if (sha !== raw.ref) {
      logMergeFix("hallucinated_ref", "repaired", raw.kind, "sha recovered from the matching commit hint");
    }
    return [
      withSwappedRef(raw, {
        turn_idx: hint.turn_idx,
        turn_role: hint.turn_role,
        ref: sha,
        ref_kind: "commit",
        quote: undefined,
      }),
    ];
  }

  logMergeFix("hallucinated_ref", "dropped", raw.kind, "commit hint carried no sha");
  return [];
}

/**
 * Finding E: when an outcome's `ref` doesn't literally appear in its
 * receipt turn (the model invented, mis-copied, or range-compressed it),
 * repair it from what the turn's `inputDigest`/text actually contains
 * BEFORE the grounding/verify step ever runs — repairing a range ref can
 * yield more than one output record (one per range member), which is why
 * this returns an array. Never touches a non-outcome record, and never
 * touches a ref that's already present in the receipt turn.
 *
 * step2e (issue #151) adds two corroboration gates ahead of the original
 * finding-E logic — see this file's header for findings 1/2 in full:
 *   - a "commit: <subject>" quote is re-grounded entirely against the real
 *     commit hint (`resolveCommitHintedOutcome`) before anything else runs.
 *   - a bare-integer or hex-shaped `ref` that the receipt turn does NOT
 *     actually corroborate is treated as absent (repaired from the
 *     digest/text like any other bad ref, or DROPPED — "hallucinated ref",
 *     counted by the caller — when nothing better is found). Every other
 *     ref shape keeps the original, pre-step2e behavior of never dropping a
 *     record outright.
 */
export function repairOutcomeRef(raw: MemoryRecordParsed, turns: TurnRow[]): MemoryRecordParsed[] {
  if (raw.kind !== "outcome" || !raw.ref) return [raw];

  if (raw.quote && COMMIT_QUOTE_PREFIX.test(raw.quote)) {
    return resolveCommitHintedOutcome(raw, turns);
  }

  const receiptTurn = findTurnByIdx(turns, raw.turn_idx);
  const trimmedRef = raw.ref.trim();
  const bareInteger = /^#?\d+$/.test(trimmedRef);
  const hexCommitShape = !bareInteger && classifyRef(trimmedRef) === "commit";

  if (bareInteger && !isIssueRefCorroborated(trimmedRef, receiptTurn)) {
    const found = findRefInDigestOrText(receiptTurn);
    if (found) {
      if (found !== trimmedRef) {
        logMergeFix(
          "hallucinated_ref",
          "repaired",
          raw.kind,
          "uncorroborated bare-integer ref replaced from the receipt turn",
        );
      }
      return [withSwappedRef(raw, { ref: found })];
    }
    logMergeFix(
      "hallucinated_ref",
      "dropped",
      raw.kind,
      "uncorroborated bare-integer ref, nothing usable in the receipt turn",
    );
    return [];
  }
  if (hexCommitShape && !isCommitRefCorroborated(trimmedRef, receiptTurn)) {
    const found = findRefInDigestOrText(receiptTurn);
    if (found) {
      if (found !== trimmedRef) {
        logMergeFix("hallucinated_ref", "repaired", raw.kind, "uncorroborated hex ref replaced from the receipt turn");
      }
      return [withSwappedRef(raw, { ref: found })];
    }
    logMergeFix("hallucinated_ref", "dropped", raw.kind, "uncorroborated hex ref, nothing usable in the receipt turn");
    return [];
  }

  if (checkOutcomeRef(raw.ref, receiptTurn)) return [raw];

  // N1 (review round 2): the two repairs below were counted (the
  // before/after diff in applyDeterministicFixes) but never logged — every
  // repair now emits exactly one line here too.
  const rangeMembers = splitRangeRef(raw.ref);
  if (rangeMembers) {
    const allPresent = rangeMembers.every((member) => checkOutcomeRef(member, receiptTurn));
    if (allPresent) {
      logMergeFix(
        "hallucinated_ref",
        "repaired",
        raw.kind,
        "range ref split into its member refs, all present in the receipt turn",
      );
      return rangeMembers.map((member) => withSwappedRef(raw, { ref: member }));
    }
    if (rangeMembers[0] !== raw.ref) {
      logMergeFix(
        "hallucinated_ref",
        "repaired",
        raw.kind,
        "range ref not fully corroborated, kept as its first member only",
      );
    }
    return [withSwappedRef(raw, { ref: rangeMembers[0] })];
  }

  const found = findRefInDigestOrText(receiptTurn);
  if (found) {
    if (found !== raw.ref) {
      logMergeFix(
        "hallucinated_ref",
        "repaired",
        raw.kind,
        "uncorroborated ref replaced from the receipt turn's digest/text",
      );
    }
    return [withSwappedRef(raw, { ref: found })];
  }

  // S1 (review round 2): a branch-shaped ref that is neither literally in
  // the receipt turn/digest (checked above) nor repairable (just above) is
  // DROPPED, not kept on trust alone — the shape allowlist alone can't
  // fully close the free-text-as-branch gate (a plausible-but-fabricated
  // `fix/99-typo` can satisfy the tightened shape without ever having been
  // said). Every other ref shape keeps the original, pre-step2e behavior of
  // never dropping a record outright — this gate is branch-specific.
  //
  // R2-S1 (review round 3): the round-2 gate over-dropped three ways —
  // (a) `main`/`master`/`develop` are the repo's well-known default
  // branches and were trusted outright at HEAD, long before turn-literal
  // corroboration existed at all, so they're exempted here the same way.
  // (b) a tool commonly renders `git push -u origin feature/x` — the turn
  // names the branch as `feature/x`, never as the ref's own
  // `origin/feature/x` — so a leading `origin/` is stripped before the
  // substring check. (c) the receipt turn alone is too narrow: a branch is
  // often named in a NEIGHBOURING tool-result turn (e.g. `* [new branch]
  // feature/x -> feature/x`) rather than the turn the model cited as the
  // receipt. `turns` here is the whole session (every caller passes
  // `allTurns`, not a window slice — see tail-capture.ts), so the search
  // below checks every turn's digest/text, not just the receipt turn.
  const trimmedForBranchCheck = raw.ref.trim();
  if (isBranchShaped(trimmedForBranchCheck)) {
    const searchable = trimmedForBranchCheck.replace(/^origin\//i, "");
    const corroborated = isBranchWellKnown(trimmedForBranchCheck) || turns.some((t) => checkOutcomeRef(searchable, t));
    if (corroborated) return [raw];
    logMergeFix(
      "hallucinated_ref",
      "dropped",
      raw.kind,
      "branch-shaped ref not found literally anywhere in the session",
    );
    return [];
  }
  return [raw];
}

// --- Finding D: deterministic ref_kind classification.

/** Finding D: overrides the model's `ref_kind` with `classifyRef`'s deterministic reading of the (possibly Finding-E-repaired) `ref` string — kept as the model's own answer only when the shape is genuinely ambiguous (`classifyRef` returns `undefined`). */
export function overrideRefKind(raw: MemoryRecordParsed): MemoryRecordParsed {
  if (raw.kind !== "outcome" || !raw.ref) return raw;
  const classified = classifyRef(raw.ref);
  if (classified === undefined) return raw;
  return { ...raw, ref_kind: classified };
}

// --- Finding F: phone/email redaction + ref path relativization; a ref-shape allowlist that drops an outcome PII can't be scrubbed out of.

const VALID_OUTCOME_REF_SHAPE = [
  /^https?:\/\//i, // URL
  /^[0-9a-f]{7,40}$/i, // sha
  /^#?\d+$/, // issue/PR number
  /^v\d/i, // tag
  // repo-relative path (has an extension).
  /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*\.[A-Za-z0-9]+$/,
  // step2d finding 2: an absolute or home-relative path is still a valid,
  // openable reference (just not this repo's own file when off-repo) — a
  // path is a correctness concern, not PII, so it is never rejected here.
  /^\/[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*\.[A-Za-z0-9]+$/,
  /^~\/[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*\.[A-Za-z0-9]+$/,
  // step2e finding 2: an opaque artifact id (a third-party workflow/template
  // id, etc.) must contain at least one LETTER — a pure-digit token here is
  // indistinguishable from a phone number or an issue number typed without
  // its `#`, so it is never accepted through this catch-all shape (it may
  // still be repaired to something better, or dropped, upstream in
  // `repairOutcomeRef`).
  /^(?=.*[A-Za-z])[A-Za-z0-9_-]{6,40}$/,
];

/** Finding F: is `ref` still a real, openable reference after redaction? A ref that redaction fully or partially scrubbed (contains the `[redacted]` marker) is never valid — a half-redacted phone number is useless as a receipt, whatever shape survives. Issue #162: a real git branch name is NOT PII (was being rejected by every shape below and silently dropped as "PII scrub") — checked via ref-kind.ts's `isBranchShaped`, the SAME predicate `classifyRef` uses, rather than a second independently-drifting regex (that drift is what caused round 1's bug — see ref-kind.ts's header). */
export function isValidOutcomeRefShape(ref: string): boolean {
  if (!ref || ref.includes("[redacted]")) return false;
  if (isBranchShaped(ref)) return true;
  return VALID_OUTCOME_REF_SHAPE.some((re) => re.test(ref));
}

/**
 * Finding F, narrowed by step2d finding 2 (docs/goals/2026-09-13_memory-v1-build_goal.md;
 * issue #151): redacts phone/email (`packages/core/src/sessions/redact.ts`)
 * on `text`/`quote`/`ref`/`thread` — home-directory paths are no longer
 * touched there (they aren't PII; see redact.ts's header). An outcome `ref`
 * that is an absolute/home-relative path is additionally made repo-relative
 * when it's inside `repoPath` (the session's `cwd`), and left as-is when
 * it's outside — still a valid opener, just not this repo's own file.
 */
export function redactRecordPii(raw: MemoryRecordParsed, repoPath: string | undefined): MemoryRecordParsed {
  return {
    ...raw,
    text: redactPii(raw.text),
    quote: raw.quote ? redactPii(raw.quote) : raw.quote,
    ref: raw.ref ? relativizeRefPath(redactPii(raw.ref), repoPath) : raw.ref,
    thread: raw.thread ? redactPii(raw.thread) : raw.thread,
  };
}

/** S2 (review round 2): did redaction actually scrub a phone/email span from `before` on `field`? True only when `after` carries the `[redacted]` marker and `before` did not — a field that already contained the literal marker text, or a field `relativizeRefPath` changed with no PII in it at all, is never counted. */
function fieldWasPiiRedacted(before: string | undefined, after: string | undefined): boolean {
  return !!after?.includes("[redacted]") && !before?.includes("[redacted]");
}

/** S2 (review round 2): true only when `redactRecordPii` introduced the `[redacted]` marker somewhere it wasn't already — never true for a ref that merely got relativized (`relativizeRefPath`), which isn't a PII repair. */
function wasPiiRedacted(before: MemoryRecordParsed, after: MemoryRecordParsed): boolean {
  return (
    fieldWasPiiRedacted(before.text, after.text) ||
    fieldWasPiiRedacted(before.quote, after.quote) ||
    fieldWasPiiRedacted(before.ref, after.ref) ||
    fieldWasPiiRedacted(before.thread, after.thread)
  );
}

export interface DeterministicFixResult {
  /** The fixed records to ground — 0 (PII- or hallucinated-ref-dropped outcome), 1 (the common case), or more (a repaired range ref). */
  records: MemoryRecordParsed[];
  /** Outcomes dropped because their `ref` was no longer a valid, openable shape after PII redaction — folds into `props.memory_extraction.dropped_pii`. */
  droppedPii: number;
  /** step2e finding 1 (docs/goals/2026-09-13_memory-v1-build_goal.md; issue #151): outcomes `repairOutcomeRef` dropped outright because their `ref` could not be corroborated by the receipt turn at all, nor repaired from its digest/text (a bare-integer/hex-shaped ref, or a "commit:" quote with no matching real commit hint) — folds into `props.memory_extraction.dropped_hallucinated_ref`. */
  droppedHallucinatedRef: number;
  /** Issue #162 (renamed N2, review round 2): every `repairOutcomeRef`/`resolveCommitHintedOutcome` path that changed a record's `ref` and KEPT the record — a hallucination recovery, a range ref split into its members, or a benign mis-copy fix are all counted here, not hallucinations alone — folds into `props.memory_extraction.repaired_ref`. */
  repairedRef: number;
  /** Issue #162: `redactRecordPii` scrubbed a phone/email span from text/quote/ref/thread and the record was still valid afterward (kept) — folds into `props.memory_extraction.repaired_pii`. */
  repairedPii: number;
}

/**
 * Runs every step2b/step2e deterministic fix on one raw model record, in the
 * fixed order documented at the top of this file (G, then E, then D, then
 * F). Never throws; never mutates `raw`. This is the ONLY entry point
 * tail-capture.ts calls — the individual fixes above are exported solely
 * for direct unit testing.
 */
export function applyDeterministicFixes(
  raw: MemoryRecordParsed,
  turns: TurnRow[],
  repoPath: string | undefined,
): DeterministicFixResult {
  const durabilityFixed = applyBlockerDurableOverride(raw);
  const refRepaired = repairOutcomeRef(durabilityFixed, turns);
  // step2e finding 1: `repairOutcomeRef` returning zero records for an
  // outcome IS the "hallucinated ref, dropped" case — every other kind
  // always returns exactly one record from repairOutcomeRef (it's a no-op
  // for them), so this can only ever fire for kind "outcome".
  const droppedHallucinatedRef = raw.kind === "outcome" && refRepaired.length === 0 ? 1 : 0;
  // Issue #162: the inverse — repairOutcomeRef/resolveCommitHintedOutcome
  // KEPT the record but changed its ref (logged at the repair site itself,
  // inside those functions); counted here from the before/after diff so the
  // caller can report it without those functions changing their (tested)
  // array-of-records return shape.
  const repairedRef =
    raw.kind === "outcome" && refRepaired.length > 0 && refRepaired.some((r) => r.ref !== raw.ref) ? 1 : 0;
  const refKindFixed = refRepaired.map(overrideRefKind);

  const records: MemoryRecordParsed[] = [];
  let droppedPii = 0;
  let repairedPii = 0;
  for (const candidate of refKindFixed) {
    const redacted = redactRecordPii(candidate, repoPath);
    if (redacted.kind === "outcome" && !isValidOutcomeRefShape(redacted.ref ?? "")) {
      droppedPii++;
      logMergeFix(
        "pii_scrub",
        "dropped",
        candidate.kind,
        redacted.ref?.includes("[redacted]")
          ? "outcome ref no longer openable after PII redaction"
          : "outcome ref did not match any recognized, safe-to-store shape",
      );
      continue;
    }
    // S2 (review round 2): `redactRecordPii` also runs `relativizeRefPath`,
    // which changes a plain absolute-path ref with no PII in it at all
    // (`/Users/x/dev/repo/src/foo.ts` -> `src/foo.ts` inside that repo) — a
    // before/after diff over all four fields over-counted THAT as a PII
    // repair. Count (and log) a PII repair only when redaction actually
    // introduced the `[redacted]` marker somewhere it wasn't already.
    if (wasPiiRedacted(candidate, redacted)) {
      repairedPii++;
      logMergeFix("pii_scrub", "repaired", candidate.kind, "phone/email span redacted, record kept");
    }
    // D10: any path that changed the ref (incl. PII redaction / path
    // relativizing) drops the title and MR->issue edge claimed for the old one.
    records.push(redacted.ref === raw.ref ? redacted : stripRefExtras(redacted));
  }
  return { records, droppedPii, droppedHallucinatedRef, repairedRef, repairedPii };
}

/**
 * Grounds one raw model record against the session's turns: verifies (and
 * repairs) `turn_idx`/`turn_role`, sets `verified`, and computes its
 * content_hash. The verification itself is grounding.ts's
 * `groundAgainstTurns` — the SAME predicate verify.ts runs at serve time
 * (D3 decision A2, 2026-09-24), so the stored `verified` flag can never
 * disagree with the render-time re-check. Never throws — an ungroundable
 * record is returned with `verified: false` and `unverifiedReason` set (the
 * caller retires it on write, decision B; never a delete) — EXCEPT a
 * "preference" whose resolved receipt turn is an assistant turn, which is
 * dropped outright (returns `null`): the DB's check1 (`kind <> 'preference'
 * or turn_role = 'user'`) would reject the row and fail its whole batch
 * (step2d finding 4: a preference is definitionally the OWNER's).
 */
export function groundRecord(
  raw: MemoryRecordParsed & { recurs_of?: string },
  turns: TurnRow[],
  promptVersion: string,
  windowIndex: number,
  opts: { userTurnsOnly?: boolean } = {},
): GroundedRecord | null {
  const result = groundAgainstTurns(
    {
      kind: raw.kind,
      text: raw.text,
      quote: raw.quote ?? null,
      ref: raw.ref ?? null,
      turn_idx: raw.turn_idx,
      userTurnsOnly: opts.userTurnsOnly,
    },
    turns,
  );
  let turnIdx = result.turn_idx;
  const receiptTurn = findTurnByIdx(turns, turnIdx);

  // step2d finding 4: turn_role ALWAYS comes from the resolved receipt turn
  // (the transcript) — never the model's own claim. Falls back to the
  // model's own turn_role only when no receipt turn resolves at all (a
  // dangling turn_idx, handled below).
  const turnRole: TurnRole = receiptTurn?.role ?? raw.turn_role;

  if (raw.kind === "preference" && receiptTurn && turnRole !== "user") {
    // Issue #162: `turnRole` above is already ground truth — the resolved
    // receipt turn's OWN role, never the model's claim — so there is no
    // "corrected" turn_role left to flip to here; the record itself is
    // mis-attributed (a preference is definitionally the OWNER's words, and
    // this receipt turn is the ASSISTANT's). Forcing turn_role to "user"
    // would misrepresent who actually said it, which is worse than dropping
    // it — and the DB's own check1 constraint (`kind <> 'preference' or
    // turn_role = 'user'`) would reject the row as written regardless. So:
    // drop, not repair.
    logMergeFix("owner_voice_mismatch", "dropped", "preference", "receipt turn is the assistant's, not the owner's");
    return null;
  }
  // review v6 m3: a user-turn-pass record (the pass asks for USER-stated
  // facts) whose receipt is not a user turn is dropped the same way — it
  // was quoting the assistant context line.
  if (opts.userTurnsOnly && turnRole !== "user") {
    logMergeFix("user_turn_only", "dropped", raw.kind, "user-turn pass record whose receipt is not a user turn");
    return null;
  }

  // step2d finding 15: a receipt turn_idx matching no turn in the session
  // (never resolved by idx, quote, or ref) is "dangling" — clamp it to the
  // session's last turn rather than storing an index that opens nothing.
  const dangling = !receiptTurn;
  if (dangling && turns.length > 0) {
    turnIdx = Math.max(...turns.map((t) => t.idx));
  }

  const receiptText = receiptTurn?.text ?? raw.quote ?? "";
  const contentHash = computeContentHash(raw.text, receiptText, promptVersion);

  // D10: title and MR->issue edge ride on the verified receipt only; each
  // drops alone (logged), never the record. A title that PII redaction would
  // change is dropped rather than stored half-scrubbed.
  const refKind = (raw.ref_kind as RefKind | undefined) ?? null;
  const groundedTitle = result.verified ? groundRefTitle(raw.ref_title, raw.ref, receiptTurn) : null;
  const refTitle = groundedTitle !== null && redactPii(groundedTitle) === groundedTitle ? groundedTitle : null;
  const refIssue = result.verified
    ? groundRefIssue({ ref: raw.ref, quote: result.quote }, raw.ref_issue, raw.ref_issue_basis, turns)
    : null;
  if (raw.ref_issue && refIssue === null)
    logMergeFix("ref_issue", "dropped", raw.kind, "not an MR->issue edge the quote or session shows");

  return {
    windowIndex,
    kind: raw.kind,
    text: raw.text,
    quote: result.quote ?? null,
    turn_idx: turnIdx,
    turn_role: turnRole,
    ref: raw.ref ?? null,
    ref_kind: refKind,
    ref_title: refTitle,
    ref_issue: refIssue?.issue ?? null,
    ref_issue_basis: refIssue?.basis ?? null,
    durable: raw.durable,
    thread: raw.thread ?? null,
    scope: raw.scope,
    confidence: raw.confidence,
    verified: result.verified,
    unverifiedReason: result.reason,
    contentHash,
    paths: raw.kind === "decision" && result.verified ? modelPathsSeenInSession(raw.paths, receiptTurn, turns) : [],
    dangling,
    priority: raw.priority === true && turnRole === "user",
    ...(raw.kind === "blocker" && raw.recurs_of ? { recursOfHint: raw.recurs_of } : {}),
    ...(opts.userTurnsOnly ? { userPass: true } : {}),
  };
}

/**
 * True for a record a SUB-AGENT session must not keep: a preference or
 * blocker whose receipt turn is role "user". In a sub-agent session that
 * turn is the parent agent's brief, not the owner, so it is neither the
 * owner's standing rule nor the owner's open gate. `turn_role` here is the
 * ground-truth role of the resolved receipt turn (`groundRecord`), never the
 * model's claim. The caller applies this only to sub-agent sessions.
 */
export function isSubAgentBriefRecord(record: Pick<GroundedRecord, "kind" | "turn_role">): boolean {
  return (record.kind === "preference" || record.kind === "blocker") && record.turn_role === "user";
}

/**
 * Prompt v21: a decision may name the file it rules on in `paths`. Grounding
 * keeps such a path only when the receipt turn's text or some session turn
 * (its file_path or text) shows it verbatim, so an invented path never reaches
 * blocker resolution or ranking. Callers pass only verified decisions.
 */
export function modelPathsSeenInSession(
  paths: readonly string[] | undefined,
  receiptTurn: TurnRow | undefined,
  turns: readonly TurnRow[],
): string[] {
  return (paths ?? []).filter(
    (p) =>
      typeof p === "string" &&
      p.length > 0 &&
      ((receiptTurn?.text ?? "").includes(p) ||
        turns.some((t) => (t.file_path ?? "").includes(p) || (t.text ?? "").includes(p))),
  );
}

/** Longest model-supplied path kept; anything longer is noise, not a file. */
const MODEL_PATH_MAX = 200;

/**
 * Prompt v21: the stored `paths` are the computed edited-file paths first, then
 * the grounded model paths that pass the filter: no URL, control character or
 * NUL, at most MODEL_PATH_MAX chars, unchanged by PII redaction, an absolute
 * path only when it lies inside the repo (made relative), no drive letter, no
 * ".." segment. Deduped and capped at the schema's 20.
 */
export function unionModelPaths(
  computed: readonly string[],
  fromModel: readonly string[] | undefined,
  repoPath?: string,
): string[] {
  const out = [...new Set(computed)];
  for (const raw of fromModel ?? []) {
    if (out.length >= 20) break;
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point.
    if (!trimmed || trimmed.length > MODEL_PATH_MAX || trimmed.includes("://") || /[\u0000-\u001f\u007f]/.test(trimmed))
      continue;
    if (redactPii(trimmed) !== trimmed) continue;
    if (/^[A-Za-z]:/.test(trimmed) || trimmed.startsWith("\\")) continue;
    const rel = toRepoRelativePath(trimmed, repoPath)?.replace(/^\.\//, "");
    if (!rel || rel.split(/[\\/]/).includes("..")) continue;
    if (!out.includes(rel)) out.push(rel);
  }
  return out;
}

/**
 * Files touched (Edit/Write) strictly between the receipt turn and the next
 * USER prose turn (design §2: "paths... filled deterministically from the
 * files touched between the receipt turn and the next user prose turn"),
 * made repo-relative (step2d finding 2) — an entry outside `repoPath` (or
 * one that can't be related to it at all, `repoPath` unknown) is DROPPED:
 * `paths` is an indexed lookup column (`memory_search(path)`, the push's
 * recently-edited-files overlap), and an off-repo path can never match
 * either, so keeping it is pure noise, never a privacy concern.
 */
export function computePaths(receiptTurnIdx: number, turns: TurnRow[], repoPath?: string): string[] {
  const sorted = [...turns].sort((a, b) => a.idx - b.idx);
  const nextUserProseIdx =
    sorted.find((t) => t.idx > receiptTurnIdx && t.kind === "prose" && t.role === "user")?.idx ??
    Number.POSITIVE_INFINITY;
  const paths = new Set<string>();
  for (const t of sorted) {
    if (t.idx <= receiptTurnIdx || t.idx >= nextUserProseIdx) continue;
    if (t.kind === "tool_use" && (t.tool_name === "Edit" || t.tool_name === "Write") && t.file_path) {
      const rel = toRepoRelativePath(t.file_path, repoPath);
      if (rel) paths.add(rel);
    }
  }
  return [...paths];
}

/**
 * Collapses exact content_hash duplicates. Review v6 M3: a verified copy
 * always beats an unverified one (an overlap window's stitched quote must
 * never cost a grounded fact); between copies of equal status the earlier
 * receipt turn wins, then the LATER window. Deterministic for any input
 * order of equal-status, equal-turn copies given ascending windowIndex.
 */
export function dedupeByContentHash<T extends GroundedRecord>(records: T[]): T[] {
  const byHash = new Map<string, T>();
  for (const r of records) {
    const prior = byHash.get(r.contentHash);
    if (!prior || preferOver(r, prior)) byHash.set(r.contentHash, keepRecursHint(r, prior));
  }
  return [...byHash.values()];
}

/**
 * e2e R-4: the main pass (offered the open blockers) and the user-turn pass
 * can both find one blocker; whichever copy wins the collapse keeps the
 * other's `recursOfHint`, so the model's recurrence link is never lost.
 */
function keepRecursHint<T extends GroundedRecord>(winner: T, loser: T | undefined): T {
  if (!loser || winner.recursOfHint || !loser.recursOfHint) return winner;
  return { ...winner, recursOfHint: loser.recursOfHint };
}

/** True when `next` should replace `prior` among duplicates: verified > unverified, then earlier turn, then later window. */
function preferOver(next: GroundedRecord, prior: GroundedRecord): boolean {
  if (next.verified !== prior.verified) return next.verified;
  if (next.turn_idx !== prior.turn_idx) return next.turn_idx < prior.turn_idx;
  return true;
}

/**
 * D3 decision C3(c) (2026-09-24): the key two records of one session are
 * "near-identical" on — `normalizeQuote` (NFKC, one quote class, case-fold,
 * whitespace) with every character that is not a letter or digit in ANY
 * script removed. Language-agnostic by construction (Unicode `\p{L}\p{N}`,
 * no word lists), so "Use zsh, not bash." and "use zsh not bash" collide
 * while any difference in actual words does not.
 */
export function normalizedTextKey(text: string): string {
  // review v6 m2: a punctuation run becomes ONE space, never nothing — so
  // "#12, #3" and "#123" (or "1.20" and "12.0") stay distinct.
  return normalizeQuote(text)
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * D3 decision C3(c): collapses near-identical records WITHIN one session
 * (same kind + `normalizedTextKey`) before insert — the overlap between
 * windows and the separate user-turn pass (C2) both re-find the same fact.
 * `content_hash` alone misses these: it folds in the receipt turn's text,
 * so the same sentence grounded on two different turns hashes differently.
 * Same preference as `dedupeByContentHash` (review v6 M3): verified first,
 * then the earlier receipt turn, then the later one (the
 * same "later window wins" rule as `dedupeByContentHash`). Order of the
 * surviving records follows their first appearance.
 */
export function dedupeByNormalizedText<T extends GroundedRecord>(records: T[]): { kept: T[]; dropped: number } {
  const byKey = new Map<string, T>();
  for (const r of records) {
    const key = `${r.kind}\u0000${normalizedTextKey(r.text)}`;
    const prior = byKey.get(key);
    if (!prior || preferOver(r, prior)) byKey.set(key, keepRecursHint(r, prior));
  }
  const kept = [...byKey.values()];
  return { kept, dropped: records.length - kept.length };
}

export interface EmbeddedGroundedRecord extends GroundedRecord {
  /** `null` when this record's embedding batch failed (step2d finding 8) — never discarded, just excluded from cosine dedupe/supersede below. */
  embedding: number[] | null;
}

/**
 * Collapses embedding cosine >= threshold duplicates, keeping the LATER
 * window's record (`records` must be sorted ascending by windowIndex before
 * calling — dedupeByContentHash's Map iteration order doesn't guarantee
 * this, since a re-set doesn't move a key's position). Receipts are NOT
 * unioned on a merge — see this file's header. A record with a `null`
 * embedding (finding 8: its batch failed) is never matched against anything
 * and is always kept as its own record — there is nothing to compare it on.
 */
export function dedupeByCosine(records: EmbeddedGroundedRecord[], threshold?: number): EmbeddedGroundedRecord[] {
  // L8: the cut is calibrated per embedding family; an uncalibrated model keeps every record.
  const familyCut = vectorThreshold("in_batch_dedupe");
  if (records.length > 0 && familyCut === null) return [...records];
  const cut = threshold ?? familyCut ?? 1;
  const kept: EmbeddedGroundedRecord[] = [];
  for (const rec of records) {
    if (!rec.embedding) {
      kept.push(rec);
      continue;
    }
    const embedding = rec.embedding;
    const matchIdx = kept.findIndex((k) => k.embedding && cosineSimilarity(k.embedding, embedding) >= cut);
    if (matchIdx >= 0) {
      kept[matchIdx] = keepRecursHint(rec, kept[matchIdx]); // later window wins
    } else {
      kept.push(rec);
    }
  }
  return kept;
}
