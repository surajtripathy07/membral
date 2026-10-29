// Memory v1 record schema — the one shape every capture source produces and
// every read tool serves (docs/design/memory-v1.md §2). `source`, `agent_id`,
// `branch` and `head_sha` are attached server-side, never asked of the model.
// Owned by the §8.2 build (#151); other steps import, they do not edit.

import { z } from "zod";
import { MEMORY_TEXT_MAX_HARD } from "./memory-limits";

export const MEMORY_KINDS = ["outcome", "decision", "learning", "blocker", "preference"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

/**
 * The `session_memories.kind` of a synthesized session handoff (migration 136, docs/design/2026-10-25_agent-authored-handoff.md).
 * Deliberately NOT in MEMORY_KINDS: that list is what extraction writes and what search, recall and the UI tabs read
 * by default, and a long per-session note would win relevance matches against the short records. Serving it is
 * the resume path's job (brief 2.3b).
 */
export const HANDOFF_KIND = "handoff" as const;

export const MEMORY_SOURCES = ["hook", "agent", "extractor", "claude-mem"] as const;
export type MemorySource = (typeof MEMORY_SOURCES)[number];

// Open enum: an unrecognized ref_kind is stored as "other", never dropped.
export const REF_KINDS = [
  "pr",
  "mr",
  "commit",
  "branch",
  "tag",
  "release",
  "deploy",
  "issue",
  "comment",
  "thread",
  "message",
  "doc",
  "sheet",
  "image",
  "file",
  "other",
] as const;
export type RefKind = (typeof REF_KINDS)[number];

// step2e finding 6 (docs/goals/2026-09-13_memory-v1-build_goal.md; issue
// #151): a fixed, CLOSED list of third-person narration openers (<= 12
// entries) — deliberately not a general word-list or regex-rewrite. The
// point is not to catch every possible narrated phrasing; it's that a
// preference is emitted under its OWN field name (`statement`, below) in
// imperative/standing-rule form, and this is schema-level VALIDATION of
// that structured field — reject and drop, never rewrite — not an attempt
// at exhaustive narration detection via extraction-time cleverness.
const NARRATION_OPENERS = [
  "the owner",
  "the user",
  "user ",
  "owner ",
  "the assistant",
  "the maintainer",
  "maintainer ",
  "he ",
  "she ",
  "they ",
  "desire",
  "a preference",
] as const;

/** True when `s` opens with one of `NARRATION_OPENERS`, case-insensitively. */
export function startsWithNarrationOpener(s: string): boolean {
  const lower = s.trimStart().toLowerCase();
  return NARRATION_OPENERS.some((opener) => lower.startsWith(opener));
}

/**
 * D3 decision C3(b) (2026-09-24): a decision or learning is a FACT, never
 * narration of what happened in the session ("We ran the migration…", "The
 * agent fixed…", "This session added…"). Same closed-list validation as a
 * preference's `statement` — reject and drop, never rewrite — extended by
 * the first-person and session-as-subject openers the D3 v5 grade found on
 * those two kinds. Deliberately closed and short; the prompt carries the
 * rest.
 */
const SESSION_NARRATION_OPENERS = [
  ...NARRATION_OPENERS,
  "we ",
  "i ",
  "the agent",
  "the session",
  "this session",
] as const;

/** True when a decision/learning `text` opens with session narration (`SESSION_NARRATION_OPENERS`), case-insensitively. */
export function startsWithSessionNarration(s: string): boolean {
  const lower = s.trimStart().toLowerCase();
  return SESSION_NARRATION_OPENERS.some((opener) => lower.startsWith(opener));
}

/**
 * Length caps on the string fields the extraction model writes. A value over
 * its cap fails validation and the record (or issue / mention) is dropped,
 * except a record's `text` / `statement`, which over-cap.ts cuts at a sentence or
 * word boundary before this schema runs (never dropped for length). extract.ts states these same constants
 * in its prompts so the model writes within them; never inline the numbers.
 */
/** A record's `text`, and a preference's `statement`: the HARD cap (the prompts ask for MEMORY_TEXT_SOFT). */
export const MEMORY_TEXT_MAX = MEMORY_TEXT_MAX_HARD;
/** A record's `quote`, and a preference's `owner_quote`. */
export const MEMORY_QUOTE_MAX = 400;
/** A record's `ref`. */
export const MEMORY_REF_MAX = 400;
/** A record's `thread`. */
export const MEMORY_THREAD_MAX = 60;
/** An `issues` entry's `ref`. */
export const ISSUE_REF_MAX = 300;
/** An `issues` entry's `evidence_quote`. */
export const ISSUE_EVIDENCE_QUOTE_MAX = 500;
/** An `issues` entry's `mentions[].quote`. */
export const ISSUE_MENTION_QUOTE_MAX = 300;

/** D10: caps mirrored by migration 117's check constraints on session_memories. */
export const REF_TITLE_MAX = 300;
export const REF_ISSUE_MAX = 400;

const RecordCommonShape = {
  turn_idx: z.number().int().nonnegative(),
  turn_role: z.enum(["user", "assistant"]),
  ref: z.string().max(MEMORY_REF_MAX).optional(),
  ref_kind: z.string().max(24).optional(),
  // D10 (W3): the issue/MR's own title, and on an MR ref the issue it
  // addresses. Each drops ALONE when malformed (`.catch`), never the record
  // (CLAUDE.md rule 3); merge.ts's groundRecord keeps either one only when
  // the cited turn proves it (grounding.ts `groundRefTitle`/`groundRefIssue`).
  ref_title: z.string().trim().min(1).max(REF_TITLE_MAX).optional().catch(undefined),
  ref_issue: z.string().trim().min(1).max(REF_ISSUE_MAX).optional().catch(undefined),
  // D10 (2026-10-04): how the session links the MR to `ref_issue` — a quote
  // naming both ("stated") or the session's meaning ("inferred"). Missing or
  // invalid -> undefined, and groundRecord then keeps no ref_issue at all.
  ref_issue_basis: z.enum(["stated", "inferred"]).optional().catch(undefined),
  // step2f fix 1 (issue #151): optional at the wire boundary — gpt-4o-mini
  // omits this field on ~100 records across the step2e one-repo gate's 19
  // sessions (overwhelmingly blockers). A missing `durable` must never drop
  // the record; `parseMemoryRecord` below applies a deterministic default
  // (never the model's own unstated guess) instead of failing validation.
  durable: z.boolean().optional(),
  // Finding G (step2b): a mid-arc check-in/window can't judge whether a
  // blocker is still open, so for kind "blocker" the model reports
  // whether the transcript shows it resolved BY THE END of this excerpt
  // instead of guessing `durable` directly; merge.ts's
  // `applyBlockerDurableOverride` sets `durable = !resolved_in_session`
  // deterministically. Optional and ignored for every other kind.
  resolved_in_session: z.boolean().optional(),
  // C-6 (prompt v11): the model's reading that the OWNER's own words put this
  // item first or on a clock — any language. Kept only on a user-turn
  // preference/decision (`parseMemoryRecord`); lib/threads reads it for the
  // "You said" block instead of a word list over the quote.
  priority: z.boolean().optional(),
  thread: z.string().max(MEMORY_THREAD_MAX).optional(),
  paths: z.array(z.string()).max(20).default([]),
  scope: z.enum(["project", "global"]).default("project"),
  confidence: z.number().min(0).max(1).default(0.5),
};

// Exported (not just internal to the union below) so extract.ts can dispatch
// straight to the right branch by `kind` instead of parsing against a
// `z.union` — a union's failure mode nests each branch's own ZodError inside
// one top-level "invalid_union" issue, which would make finding the
// narration refine's failure message needlessly indirect for no benefit
// (the two branches are already fully disjoint on `kind`).
export const NonPreferenceRecord = z.object({
  kind: z.enum(["outcome", "decision", "learning", "blocker"]),
  text: z.string().min(8).max(MEMORY_TEXT_MAX),
  quote: z.string().min(8).max(MEMORY_QUOTE_MAX).optional(),
  ...RecordCommonShape,
});

/**
 * step2e finding 6: a preference is emitted under its OWN field names —
 * `statement` (imperative/standing-rule form) and `owner_quote` (the
 * owner's verbatim words) — never the generic `text`/`quote` every other
 * kind uses. This is what lets the `.refine` below reject a narrated
 * preference as a validation failure on a STRUCTURED field, rather than a
 * text-mangling regex rewrite applied after the fact. `MemoryRecord`'s
 * `.transform` maps this back onto the common `text`/`quote` shape so every
 * downstream consumer (merge.ts, write.ts, tail-capture.ts) sees one
 * uniform record shape regardless of kind.
 */
export const PreferenceRecord = z
  .object({
    kind: z.literal("preference"),
    statement: z.string().min(8).max(MEMORY_TEXT_MAX),
    owner_quote: z.string().min(8).max(MEMORY_QUOTE_MAX).optional(),
    ...RecordCommonShape,
  })
  .refine((r) => !startsWithNarrationOpener(r.statement), {
    message: "a preference's statement reads as narration, not a standing rule",
    path: ["statement"],
  });

/**
 * The one shape every downstream consumer (merge.ts, write.ts,
 * tail-capture.ts) sees, regardless of which wire-level branch produced
 * it — a preference's `statement`/`owner_quote` are mapped onto `text`/
 * `quote` by `parseMemoryRecord` below before anything else ever sees a
 * record. A plain interface, not a zod `z.output`: two disjoint branch
 * schemas (never a `z.union`, see `NonPreferenceRecord`'s doc comment)
 * validate the wire shape; this is the shape validation NORMALIZES to.
 */
export interface MemoryRecordParsed {
  kind: MemoryKind;
  text: string;
  quote?: string;
  turn_idx: number;
  turn_role: "user" | "assistant";
  ref?: string;
  ref_kind?: string;
  /** D10: the issue/MR title, verbatim in the cited turn (else dropped in merge.ts). */
  ref_title?: string;
  /** D10: on an MR/PR ref, the issue it addresses — kept only when one quote names both. */
  ref_issue?: string;
  /** D10: "stated" (one quote names both) or "inferred" (session meaning; the issue must appear in the session). */
  ref_issue_basis?: "stated" | "inferred";
  durable: boolean;
  resolved_in_session?: boolean;
  /** C-6: set only on a user-turn preference/decision the model read as the owner's priority. */
  priority?: boolean;
  thread?: string;
  paths: string[];
  scope: "project" | "global";
  confidence: number;
}

export type MemoryRecordSafeParse =
  | { success: true; data: MemoryRecordParsed; durableDefaulted: boolean; repairs?: string[] }
  | { success: false; error: z.ZodError };

function customIssueError(path: (string | number)[], message: string): z.ZodError {
  return new z.ZodError([{ code: z.ZodIssueCode.custom, path, message }]);
}

/**
 * step2f fix 1 (issue #151): `durable`'s deterministic default when the
 * model omitted it — never a guess made up on the spot. A blocker with an
 * answered `resolved_in_session` defaults to `!resolved_in_session` (the
 * same rule merge.ts's `applyBlockerDurableOverride` applies when the model
 * DOES answer `durable` itself, so a blocker's stored durability is
 * consistent regardless of which field the model happened to omit). Every
 * other case (a blocker with no `resolved_in_session` either, or any other
 * kind) defaults to `false` — conservative: an un-asserted durability never
 * pushes a record into a future session.
 */
function resolveDurable(
  durable: boolean | undefined,
  kind: MemoryKind,
  resolvedInSession: boolean | undefined,
): { durable: boolean; durableDefaulted: boolean } {
  if (durable !== undefined) return { durable, durableDefaulted: false };
  if (kind === "blocker" && resolvedInSession !== undefined) {
    return { durable: !resolvedInSession, durableDefaulted: true };
  }
  return { durable: false, durableDefaulted: true };
}

/**
 * Validates one wire-level record (a preference's `statement`/`owner_quote`
 * included) and normalizes it to `MemoryRecordParsed`'s common `text`/
 * `quote` shape. Dispatches on `kind` to the right branch schema rather
 * than a `z.union` (see `NonPreferenceRecord`'s doc comment) — a narrated
 * preference's `.refine` failure message ("...reads as narration...") is
 * always a direct, single top-level issue this way, never nested inside a
 * union's own aggregate error. This is the ONLY place either branch schema
 * should be parsed directly; every caller (extract.ts) uses this function.
 */
export function parseMemoryRecord(raw: unknown): MemoryRecordSafeParse {
  const { record: repairedRaw, repairs } = repairWireRecord(raw);
  const out = parseRepairedMemoryRecord(repairedRaw);
  return out.success && repairs.length > 0 ? { ...out, repairs } : out;
}

/** A single path token: no spaces, and a `/` or an extension. */
const PATH_LIKE = /^(?=.*[/.])[\w@~./+-]+$/;

/** Issue #162: wire fields that are recoverable by a deterministic, content-preserving fix. */
const STRING_FIELDS = ["text", "quote", "statement", "owner_quote", "ref", "ref_kind", "thread"] as const;

/**
 * Issue #162: repairs recoverable wire fields BEFORE the strict schema runs, so a record that is
 * right in substance is not dropped for its form. Each repair is content-preserving and returns a
 * reason code (never record text) for the caller to log:
 * - `kind_case`: kind / turn_role / scope with stray case or whitespace ("Decision ", "USER");
 * - `string_trim`: leading/trailing whitespace on a text-like field (a quote with stray whitespace
 *   otherwise fails the min-length or exact-match checks);
 * - `confidence_range`: a number outside 0..1 falls back to the neutral 0.5, never clamped or read as a
 *   percentage), or a numeric string;
 * - `paths_shape`: a string holding one path, or comma/newline separated paths each path-like (otherwise left as sent);
 * - `bool_string`: "true"/"false" for durable / resolved_in_session / priority.
 * Never invents content: a field it cannot read stays as sent and the schema decides.
 */
export function repairWireRecord(raw: unknown): { record: unknown; repairs: string[] } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { record: raw, repairs: [] };
  const rec: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  const repairs: string[] = [];
  for (const key of ["kind", "turn_role", "scope"] as const) {
    const v = rec[key];
    if (typeof v === "string" && v !== v.trim().toLowerCase()) {
      rec[key] = v.trim().toLowerCase();
      if (!repairs.includes("kind_case")) repairs.push("kind_case");
    }
  }
  for (const key of STRING_FIELDS) {
    const v = rec[key];
    if (typeof v === "string" && v !== v.trim()) {
      rec[key] = v.trim();
      if (!repairs.includes("string_trim")) repairs.push("string_trim");
    }
  }
  const c = rec.confidence;
  const n = typeof c === "string" && c.trim() !== "" ? Number(c) : c;
  if (typeof n === "number" && Number.isFinite(n)) {
    // A value outside 0..1 is not read as a percentage or clamped (a 2 on a 1-5 scale is not 0.02, and a clamped
    // 1.0 would be served as full confidence): it falls back to the schema's neutral default.
    if (n < 0 || n > 1) {
      rec.confidence = 0.5;
      repairs.push("confidence_range");
    } else if (n !== c) {
      rec.confidence = n;
      repairs.push("confidence_range");
    }
  }
  if (typeof rec.paths === "string" && rec.paths.trim() !== "") {
    const parts = rec.paths
      .split(/[,\n]/)
      .map((x) => x.trim())
      .filter(Boolean);
    if (parts.length > 0 && parts.length <= 20 && parts.every((x) => PATH_LIKE.test(x))) {
      rec.paths = parts;
      repairs.push("paths_shape");
    }
  }
  for (const key of ["durable", "resolved_in_session", "priority"] as const) {
    const v = rec[key];
    if (v === "true" || v === "false") {
      rec[key] = v === "true";
      if (!repairs.includes("bool_string")) repairs.push("bool_string");
    }
  }
  return { record: rec, repairs };
}

/**
 * Issue #162: a short, content-free reason code for a failed parse, from the failing field paths
 * and issue codes only (never a message that could echo record text).
 */
export function dropReasonCode(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "invalid";
  if (issue.message.includes("reads as narration")) return "narration";
  const field = issue.path.length > 0 ? issue.path.join(".") : "record";
  return `${field}:${issue.code}`;
}

function parseRepairedMemoryRecord(raw: unknown): MemoryRecordSafeParse {
  const kind = raw && typeof raw === "object" ? (raw as { kind?: unknown }).kind : undefined;

  if (kind === "preference") {
    const parsed = PreferenceRecord.safeParse(raw);
    if (!parsed.success) return parsed;
    const { statement, owner_quote, ...rest } = parsed.data;
    if (rest.turn_role !== "user") {
      return { success: false, error: customIssueError(["turn_role"], "a preference is the owner's") };
    }
    const { durable, durableDefaulted } = resolveDurable(rest.durable, "preference", rest.resolved_in_session);
    const { priority, ...base } = rest;
    return {
      success: true,
      data: {
        ...base,
        ...(priority === true ? { priority: true } : {}),
        durable,
        kind: "preference",
        text: statement,
        quote: owner_quote,
      },
      durableDefaulted,
    };
  }

  const parsed = NonPreferenceRecord.safeParse(raw);
  if (!parsed.success) return parsed;
  if (
    (parsed.data.kind === "decision" || parsed.data.kind === "learning") &&
    startsWithSessionNarration(parsed.data.text)
  ) {
    return {
      success: false,
      error: customIssueError(["text"], `a ${parsed.data.kind}'s text reads as narration of the session, not the fact`),
    };
  }
  if (parsed.data.kind === "outcome" && !parsed.data.ref) {
    return { success: false, error: customIssueError(["ref"], "an outcome needs a ref") };
  }
  const { durable, durableDefaulted } = resolveDurable(
    parsed.data.durable,
    parsed.data.kind,
    parsed.data.resolved_in_session,
  );
  const { priority, ...base } = parsed.data;
  const ownerPriority = priority === true && base.kind === "decision" && base.turn_role === "user";
  return {
    success: true,
    data: { ...base, ...(ownerPriority ? { priority: true } : {}), durable },
    durableDefaulted,
  };
}

/**
 * step2e finding 6: the callJson-boundary shape — deliberately loose (any
 * array of plain objects, up to 20). A single malformed or narrated record
 * must never fail Zod validation for the WHOLE window (that would silently
 * drop every OTHER good record in it too); extract.ts re-validates each
 * element individually via `parseMemoryRecord` after this parses, counting
 * a narration rejection as `dropped_narration` rather than losing the batch.
 */
export const ExtractionWire = z.object({
  records: z.array(z.record(z.string(), z.unknown())).max(20),
  // Loose on purpose: a malformed `issues` value must never fail the window's
  // records — parseSessionIssues below validates it on its own.
  issues: z.unknown().optional(),
  // Prompt v24 (feedback.ts): what was said about Membral itself. Loose for the
  // same reason; parseFeedbackItems validates it element by element.
  feedback: z.unknown().optional(),
});
export type ExtractionWireParsed = z.output<typeof ExtractionWire>;

/**
 * step2e finding 5 (docs/goals/2026-09-13_memory-v1-build_goal.md; issue
 * #151): the end-of-session blocker tail re-ask's response shape — one
 * `resolved_in_session` answer per blocker `index` given in the prompt.
 */
export const BlockerResolutionCheck = z.object({
  resolutions: z.array(z.object({ index: z.number().int().nonnegative(), resolved_in_session: z.boolean() })).max(20),
});
export type BlockerResolutionCheckParsed = z.output<typeof BlockerResolutionCheck>;

/**
 * Later-session blocker resolution (extract.ts's `checkLaterBlockerResolutions`):
 * one answer per numbered OPEN blocker from an EARLIER session — was it
 * resolved in THIS session, and the verbatim evidence line if so. The quote
 * is optional at the schema level so one answer missing it never fails the
 * whole list; a `resolved: true` answer with no quote is simply not applied.
 */
export const LaterBlockerResolutionCheck = z.object({
  resolutions: z
    .array(
      z.object({
        index: z.number().int().nonnegative(),
        resolved: z.boolean(),
        evidence_quote: z.string().nullish(),
      }),
    )
    .max(20),
});
export type LaterBlockerResolutionCheckParsed = z.output<typeof LaterBlockerResolutionCheck>;

export function normalizeRefKind(kind: string | undefined): RefKind | undefined {
  if (kind === undefined) return undefined;
  return (REF_KINDS as readonly string[]).includes(kind) ? (kind as RefKind) : "other";
}

/**
 * Issues/merge requests the excerpt shows, as the extractor read them.
 * Ungrounded here — extract.ts's groundSessionIssues keeps only entries whose
 * evidence_quote is in the transcript and carries the ref's number.
 *
 * Goal 2026-09-26 W4 (B2, observed beats inferred): `role` is derived from
 * the session's observed actions. Prompt v10 asks for it again as a HINT,
 * used only for a session with no actions at all (a pre-W3 CLI import). An
 * unknown role value drops only the role, never the issue.
 */
/**
 * D-053 (prompt v13): one user turn where the developer named the item, as
 * the extractor read it. Ungrounded here — extract.ts's `groundMentions`
 * keeps only those whose turn is a user prose turn of the session, whose
 * quote is in that turn's text, and whose quote names the ref.
 */
export const SessionIssueMention = z.object({
  turn_idx: z.number().int().nonnegative(),
  quote: z.string().trim().min(1).max(ISSUE_MENTION_QUOTE_MAX),
});
export type SessionIssueMentionParsed = z.output<typeof SessionIssueMention>;

/**
 * D-055 (prompt v14): the turns the developer was working on the item, as the
 * extractor read it. Shape only here — extract.ts's `groundWorkedSpan` checks
 * it against the session (from_turn a validated mention, to_turn within the
 * session's turns); anything invalid is ignored, never the issue.
 */
export const WorkedSpan = z
  .object({
    from_turn: z.number().int().nonnegative(),
    to_turn: z.number().int().nonnegative(),
  })
  .refine((v) => v.to_turn >= v.from_turn, { message: "to_turn before from_turn" });
export type WorkedSpanParsed = z.output<typeof WorkedSpan>;

export const SessionIssueWire = z.object({
  ref: z.string().trim().min(1).max(ISSUE_REF_MAX),
  kind: z.enum(["issue", "merge_request"]),
  role: z.enum(["worked_on", "referenced"]).optional().catch(undefined),
  evidence_quote: z.string().trim().min(1).max(ISSUE_EVIDENCE_QUOTE_MAX),
  /** A malformed element drops alone (parseSessionIssues), never the issue. */
  mentions: z.array(z.unknown()).max(20).optional().catch(undefined),
  /** D-055: a malformed span drops alone, never the issue. */
  worked_span: z.unknown().optional(),
});
export type SessionIssueParsed = Omit<z.output<typeof SessionIssueWire>, "mentions" | "worked_span"> & {
  mentions?: SessionIssueMentionParsed[];
  worked_span?: WorkedSpanParsed;
};

/** Validates the extraction's `issues` value element by element: a
 * non-array (or missing) value yields [], and a malformed element is dropped
 * alone. Never throws (CLAUDE.md rule 3). */
export function parseSessionIssues(raw: unknown): SessionIssueParsed[] {
  if (!Array.isArray(raw)) return [];
  const out: SessionIssueParsed[] = [];
  for (const el of raw.slice(0, 20)) {
    const parsed = SessionIssueWire.safeParse(el);
    if (!parsed.success) continue;
    const { mentions: rawMentions, worked_span: rawSpan, ...rest } = parsed.data;
    const mentions: SessionIssueMentionParsed[] = [];
    for (const m of rawMentions ?? []) {
      const pm = SessionIssueMention.safeParse(m);
      if (pm.success) mentions.push(pm.data);
    }
    const span = rawSpan === undefined || rawSpan === null ? null : WorkedSpan.safeParse(rawSpan);
    const entry: SessionIssueParsed = mentions.length > 0 ? { ...rest, mentions } : { ...rest };
    if (span?.success) entry.worked_span = span.data;
    out.push(entry);
  }
  return out;
}
