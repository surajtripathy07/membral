// Memory v1, source C — deterministic ref_kind classification (finding D,
// docs/goals/2026-09-13_memory-v1-build_goal.md 2b; step2b-brief.md finding
// D). The model's own `ref_kind` guess landed wrong for plainly-shaped refs
// (14/72 `other` on membral-personal alone) — this classifies the
// STRUCTURED `ref` string itself and overrides the model's answer whenever
// the shape is unambiguous. `undefined` means "the shape doesn't tell us
// anything" — the caller keeps the model's own answer in that case only.
import type { RefKind } from "./schema";

// step2e finding 2 (docs/goals/2026-09-13_memory-v1-build_goal.md; issue
// #151): a real git sha is 7-40 hex characters, but so is any 7-40 DIGIT
// string (decimal digits are a subset of hex) — a phone number or a dummy
// PAN-shaped id can coincidentally satisfy the old, purely-decimal-friendly
// regex and get classified "commit". Requiring at least one non-decimal hex
// letter (a-f) rules out the pure-digit case (a bare phone number, an issue
// number written without its `#`) while still matching every real sha,
// which is drawn from a uniformly random byte space and so contains a
// letter well over 99% of the time at this length. This is a SHAPE
// tightening only — a hex-and-letter string that still isn't a real commit
// (e.g. a dummy alnum id) is caught downstream by merge.ts's
// `repairOutcomeRef` keyword-proximity corroboration, which this module has
// no turn context to perform itself.
const HEX_SHA = /^(?=.*[a-f])[0-9a-f]{7,40}$/i;
const ISSUE_NUMBER = /^#?\d+$/;
const TAG = /^v\d/i;
const MD_PATH = /\.md$/i;

// Issue #162 round 1: widened from `origin/|main|master` only — a general
// branch name (`feature/some-branch-adr`) was falling through to
// `undefined` here, and separately DROPPED outright by merge.ts's twin
// allowlist regex (`VALID_OUTCOME_REF_SHAPE`) as if it were unscrubbed PII.
//
// Issue #162 round 2 (review B1/S1): that widened shape alone was too
// loose two ways at once — it swallowed every repo-relative FILE path
// (`src/foo.ts`, `apps/cloud/src/lib/memory/merge.ts` both end in a
// letter-led extension, same as a real branch name would look), and it let
// plain multi-word slash text through as a "branch" (`and/or`, `Jane/Doe`,
// a bare directory like `src/lib/memory`, a home path carrying a
// username). `isBranchShaped` below requires an actual branch signal —
// a literal `origin/…|main|master|develop`, a known branch-type prefix
// (`feature/…`, `fix/…`, …), or at least one hyphen/digit somewhere in the
// string — and rejects a domain-shaped first segment (`github.com/…`) and
// anything whose last segment looks like a real file (a letter-led
// extension; a version number like `1.2.0` is digit-led and is NOT a
// file). Exported so merge.ts's `VALID_OUTCOME_REF_SHAPE` allowlist uses
// the exact same predicate instead of a second, independently-drifting
// copy of the regex (that drift is what caused round 1's bug).
const BRANCH_LITERAL = /^(origin\/[\w.-]+|main|master|develop)$/i;
const BRANCH_GENERIC = /^[A-Za-z][\w-]*(?:\/[A-Za-z0-9][\w.-]*)+$/;
const BRANCH_KNOWN_PREFIX = /^(feature|fix|release|hotfix|chore|bugfix|docs|refactor|origin)\//i;
const BRANCH_FILE_EXTENSION = /\.[A-Za-z][A-Za-z0-9]{0,7}$/;

export function isBranchShaped(ref: string): boolean {
  const trimmed = ref.trim();
  if (BRANCH_LITERAL.test(trimmed)) return true;
  if (!BRANCH_GENERIC.test(trimmed)) return false;
  const firstSegment = trimmed.slice(0, trimmed.indexOf("/"));
  if (firstSegment.includes(".")) return false; // domain-shaped, e.g. github.com/acme/repo
  if (BRANCH_FILE_EXTENSION.test(trimmed)) return false; // a real file path, e.g. src/foo.ts
  if (BRANCH_KNOWN_PREFIX.test(trimmed)) return true;
  return /[-0-9]/.test(trimmed); // rules out plain word pairs (and/or, Jane/Doe) and bare dirs (src/lib/memory)
}

// R2-S1 (review round 3): `main`/`master`/`develop` (bare, no `origin/`
// prefix — merge.ts strips that separately) are the repo's well-known
// default branches. HEAD trusted them outright before issue #162 ever
// touched this file; the round-2 literal-in-turn gate must keep doing the
// same instead of demanding they be spelled out verbatim in a turn, which a
// tool's plain `git push` rarely does.
const BRANCH_WELL_KNOWN = /^(main|master|develop)$/i;
export function isBranchWellKnown(ref: string): boolean {
  return BRANCH_WELL_KNOWN.test(ref.trim());
}

/** Classifies a URL's ref_kind from its host/path/hash shape alone. Returns "other" for any recognized https URL that doesn't match a more specific shape (never undefined — a bare URL is never ambiguous, it's simply generic). */
function classifyUrl(url: URL): RefKind {
  if (url.hostname.includes("claude.ai") && url.pathname.includes("/artifacts/")) return "doc";
  if (url.hash.includes("issuecomment")) return "comment";
  if (url.pathname.includes("/commit/")) return "commit";
  if (url.pathname.includes("/pull/")) return "pr";
  if (url.pathname.includes("/merge_requests/")) return "mr";
  if (url.pathname.includes("/issues/")) return "issue";
  if (url.pathname.includes("/actions/runs/")) return "deploy";
  if (url.pathname.includes("/releases/")) return "release";
  return "other";
}

/**
 * Deterministic ref_kind classification from the `ref` string's shape.
 * `undefined` = ambiguous, keep the model's own `ref_kind` (or "other" if it
 * gave none). Never throws on a malformed URL — falls through to the
 * non-URL shape checks instead.
 */
export function classifyRef(ref: string): RefKind | undefined {
  const trimmed = ref.trim();
  if (!trimmed) return undefined;

  if (/^https?:\/\//i.test(trimmed)) {
    try {
      return classifyUrl(new URL(trimmed));
    } catch {
      // Malformed URL text — fall through to the shape checks below.
    }
  }

  if (HEX_SHA.test(trimmed)) return "commit";
  if (ISSUE_NUMBER.test(trimmed)) return "issue";
  if (MD_PATH.test(trimmed)) return "doc";
  // TAG checked before isBranchShaped (review B1): a tag like `v1/api` also
  // structurally looks branch-shaped (has a digit), so TAG must win first —
  // it did before round 1 widened BRANCH and put it ahead of TAG by accident.
  if (TAG.test(trimmed)) return "tag";
  if (isBranchShaped(trimmed)) return "branch";
  return undefined;
}
