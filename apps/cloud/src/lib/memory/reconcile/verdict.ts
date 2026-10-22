// L1 (docs/design/current-truth-recall.md, gates/fable-l1-design.md): the verdict contract and the rules that decide
// which verdicts become links. Pure; no I/O.
//   - The model never sets direction: `from` is always the newer record (orientPair).
//   - A malformed, missing or unknown verdict abstains (`unrelated`); nothing here throws.
//   - supersedes/resolves are kept only when the evidence quote is verbatim in the session's turns and names the older
//     record's subject; duplicates only when nothing is lost and the pair is already close.
import { z } from "zod";
import { containment, sharedCount, tokenSet } from "../dedupe";

export const LINK_RELATIONS = ["supersedes", "resolves", "duplicates", "refines", "unrelated"] as const;
export type LinkRelation = (typeof LINK_RELATIONS)[number];
/** The relations that hide the older record (a projection); refines/unrelated live in memory_links only. */
export const HIDING_RELATIONS = ["supersedes", "resolves", "duplicates"] as const;
export type HidingRelation = (typeof HIDING_RELATIONS)[number];

export const RECONCILE_PROMPT_VERSION = "l1-v2";
/** Across different sessions, records whose order is less than this apart cannot be told apart: no link. */
export const AMBIGUOUS_ORDER_MS = 5 * 60_000;
/** A newer record that holds at least this share of the older's tokens plus MIN_EXTRA_TOKENS more is a superset. */
export const SUPERSET_SHARE = 0.9;
export const SUPERSET_MIN_EXTRA_TOKENS = 3;
/** At most this many candidates per new record, and this many pairs per model call. */
export const MAX_CANDIDATES = 12;
export const MAX_PAIRS_PER_CALL = 40;
/** `duplicates` needs cosine or containment at/above these (design section 2). */
export const DUPLICATE_MIN_COSINE = 0.7;
export const DUPLICATE_MIN_CONTAINMENT = 0.4;

/** Wire shape. Lenient on purpose: anything that does not parse abstains. */
export const VerdictWire = z.object({
  verdicts: z.array(
    z.object({
      pair: z.number().int(),
      relation: z.string(),
      evidence_quote: z.string().nullish(),
      lost_information: z.string().nullish(),
      /** supersedes: the shared artifact/object both records are about. */
      subject: z.string().nullish(),
      /** supersedes: copied verbatim from the NEWER record's own text; the state that replaces the older. */
      replacing_state_quote: z.string().nullish(),
      /** resolves: a token (PR/issue number, file, package, migration) present in BOTH records' text. */
      shared_artifact: z.string().nullish(),
    }),
  ),
});
export type VerdictWireT = z.output<typeof VerdictWire>;

/** The record fields reconciliation reads. `sessionStart` is the real session time in ms (undefined = unknown). */
export interface ReconRecord {
  id: string;
  kind: string;
  text: string;
  ref: string | null;
  code_project_id: string;
  code_session_id: string;
  user_id: string;
  turn_idx: number | null;
  created_at: string;
  sessionStart?: number;
  /** Time (ms) of the record's own turn, when the turn row has a timestamp. Orders records across sessions. */
  turnTs?: number;
}

export interface ReconTurn {
  idx: number;
  text: string | null;
  /** Turn kind from code_session_turns. Only `prose` (the user's and the agent's own words) may hold evidence. */
  kind?: string | null;
}

export interface OrientedPair {
  from: ReconRecord;
  to: ReconRecord;
}

/**
 * Newer is `from`. Within one session: the higher turn_idx. Across sessions: the later TURN time when both records
 * have one, else the later session start (only when turn times are missing). Order less than AMBIGUOUS_ORDER_MS apart
 * across sessions, equal or missing order, the same record, a different project or user, or two records of one turn
 * => null (no link). Pure.
 */
export function orientPair(a: ReconRecord, b: ReconRecord): OrientedPair | null {
  if (a.id === b.id || a.user_id !== b.user_id || a.code_project_id !== b.code_project_id) return null;
  if (a.code_session_id === b.code_session_id) {
    if (a.turn_idx === null || b.turn_idx === null || a.turn_idx === b.turn_idx) return null;
    return a.turn_idx > b.turn_idx ? { from: a, to: b } : { from: b, to: a };
  }
  const useTurn = a.turnTs !== undefined && b.turnTs !== undefined;
  const ta = useTurn ? a.turnTs : a.sessionStart;
  const tb = useTurn ? b.turnTs : b.sessionStart;
  if (ta === undefined || tb === undefined || Math.abs(ta - tb) < AMBIGUOUS_ORDER_MS) return null;
  return ta > tb ? { from: a, to: b } : { from: b, to: a };
}

/** Outcomes are never a target; resolves needs a blocker target; supersedes/duplicates need one kind. */
export function relationAllowed(relation: LinkRelation, pair: OrientedPair): boolean {
  if (pair.to.kind === "outcome") return false;
  if (relation === "resolves")
    return pair.to.kind === "blocker" && (pair.from.kind === "outcome" || pair.from.kind === "decision");
  if (relation === "supersedes" || relation === "duplicates")
    return pair.from.kind === pair.to.kind && pair.from.kind !== "outcome";
  return true;
}

export interface AcceptedLink {
  relation: LinkRelation;
  quote: string | null;
  verified: boolean;
  /** supersedes: the shared subject the judge named. */
  subject?: string | null;
  /** supersedes: the state, copied from the newer record's own text, that replaces the older. */
  replacing_state_quote?: string | null;
  /** resolves: the artifact token found in both records. */
  shared_artifact?: string | null;
  /** Turn of the evidence in the NEWER record's session, when known. */
  turn_idx: number | null;
}

const ABSTAIN: AcceptedLink = { relation: "unrelated", quote: null, verified: false, turn_idx: null };

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’“”]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** Finds the latest turn holding `quote` verbatim (whitespace/case/quote-class tolerant); null when none. */
export function findQuoteTurn(quote: string, turns: readonly ReconTurn[]): number | null {
  const q = normalize(quote);
  if (q.length < 12) return null;
  let found: number | null = null;
  for (const t of turns) {
    // Tool results carry recall and hook output that reprints the older record: never evidence of a change.
    if (t.kind !== undefined && t.kind !== null && t.kind !== "prose") continue;
    if (t.text && normalize(t.text).includes(q) && (found === null || t.idx > found)) found = t.idx;
  }
  return found;
}

/** The quote must share at least this many distinct content tokens with the older record. */
export const MIN_SHARED_SUBJECT_TOKENS = 2;

/** The quote names the older record's subject: it shares at least two distinct content tokens with it. */
export function quoteNamesSubject(quote: string, oldText: string): boolean {
  return sharedCount(tokenSet(quote), tokenSet(oldText)) >= MIN_SHARED_SUBJECT_TOKENS;
}

/** A token that names one artifact (number, file, package, migration, identifier), not a topic word. */
export function isArtifactToken(tok: string): boolean {
  const t = tok.trim();
  if (t.length < 3) return false;
  return /\d/.test(t) || /[/._-]/.test(t) || /[a-z][A-Z]/.test(t);
}

function hasToken(text: string, tok: string): boolean {
  const esc = tok.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${esc}($|[^a-z0-9])`).test(text.toLowerCase());
}

/** True when `tok` is artifact-like and appears (word-bounded, case-insensitive) in BOTH texts. Checked in code. */
export function artifactInBoth(tok: string | null | undefined, a: string, b: string): boolean {
  const t = tok?.trim();
  return !!t && isArtifactToken(t) && hasToken(a, t) && hasToken(b, t);
}

/** The quote is copied from `text` (whitespace/case/quote-class tolerant) and long enough to mean something. */
export function quoteInText(quote: string | null | undefined, text: string): boolean {
  const q = normalize(quote ?? "");
  return q.length >= 12 && normalize(text).includes(q);
}

/** The subject names something both records talk about: at least one of its content tokens is in each text. */
export function subjectInBoth(subject: string | null | undefined, a: string, b: string): boolean {
  const toks = tokenSet(subject ?? "");
  if (toks.size === 0) return false;
  const ta = tokenSet(a);
  const tb = tokenSet(b);
  for (const t of toks) if (ta.has(t) && tb.has(t)) return true;
  return false;
}

/** Newer holds (nearly) all of the older's tokens and says more: retiring the older would lose nothing, but it is not a duplicate. */
export function isStrictSuperset(olderText: string, newerText: string): boolean {
  const o = tokenSet(olderText);
  const n = tokenSet(newerText);
  if (o.size === 0) return false;
  return sharedCount(o, n) / o.size >= SUPERSET_SHARE && n.size - o.size >= SUPERSET_MIN_EXTRA_TOKENS;
}

export interface JudgeInputs {
  pair: OrientedPair;
  /** Turns of the NEWER record's session (the evidence must be in them). */
  turns: readonly ReconTurn[];
  /** Cosine of the two stored embeddings when both exist. */
  cosine?: number | null;
}

/**
 * Turns one raw model verdict into the link it earns (or an abstention). Never throws.
 * Gates: relation known and allowed for the kinds.
 *  - supersedes: a verbatim session quote naming the older record's subject, a `subject` present in both records, and
 *    a `replacing_state_quote` that is a substring of the NEWER record's own text.
 *  - resolves: a verbatim session quote naming the older record's subject, and a `shared_artifact` token (number, file,
 *    package, migration) that is found in BOTH records' text.
 *  - duplicates: an empty `lost_information`, cosine >= 0.70 or containment >= 0.4, and the newer is not a strict
 *    superset of the older (that case is `refines`, unverified).
 */
export function acceptVerdict(
  raw:
    | {
        relation?: string;
        evidence_quote?: string | null;
        lost_information?: string | null;
        subject?: string | null;
        replacing_state_quote?: string | null;
        shared_artifact?: string | null;
      }
    | undefined,
  inp: JudgeInputs,
): AcceptedLink {
  if (!raw || !raw.relation) return ABSTAIN;
  if (!(LINK_RELATIONS as readonly string[]).includes(raw.relation)) return ABSTAIN;
  const relation = raw.relation as LinkRelation;
  if (relation === "unrelated") return ABSTAIN;
  if (!relationAllowed(relation, inp.pair)) return ABSTAIN;
  const quote = raw.evidence_quote?.trim() || null;
  if (relation === "refines") return { relation, quote, verified: false, turn_idx: null };
  const { from, to } = inp.pair;
  if (relation === "duplicates") {
    // Nothing lost is stated, not implied: only an explicit empty string passes (null, missing or text abstains).
    if (typeof raw.lost_information !== "string" || raw.lost_information.trim().length > 0) return ABSTAIN;
    const cos = inp.cosine ?? 0;
    const cont = containment(tokenSet(from.text), tokenSet(to.text));
    if (!(cos >= DUPLICATE_MIN_COSINE || cont >= DUPLICATE_MIN_CONTAINMENT)) return ABSTAIN;
    if (isStrictSuperset(to.text, from.text)) return { relation: "refines", quote, verified: false, turn_idx: null };
    return { relation, quote, verified: true, turn_idx: null };
  }
  // supersedes / resolves
  if (!quote) return ABSTAIN;
  const turn = findQuoteTurn(quote, inp.turns);
  if (turn === null || !quoteNamesSubject(quote, to.text)) return ABSTAIN;
  if (relation === "supersedes") {
    const subject = raw.subject?.trim() || "";
    const replacing = raw.replacing_state_quote?.trim() || "";
    if (!subject || !subjectInBoth(subject, from.text, to.text)) return ABSTAIN;
    // The replacing state must be in the newer record's OWN text (the session quote alone is not enough).
    if (!quoteInText(replacing, from.text)) return ABSTAIN;
    return { relation, quote, verified: true, turn_idx: turn, subject, replacing_state_quote: replacing };
  }
  const artifact = raw.shared_artifact?.trim() || "";
  if (!artifactInBoth(artifact, from.text, to.text)) return ABSTAIN;
  return { relation, quote, verified: true, turn_idx: turn, shared_artifact: artifact };
}

/** Parses a model reply into per-pair raw verdicts; anything that does not parse => empty (every pair abstains). */
export function parseVerdicts(data: unknown): Map<number, VerdictWireT["verdicts"][number]> {
  const out = new Map<number, VerdictWireT["verdicts"][number]>();
  const parsed = VerdictWire.safeParse(data);
  if (!parsed.success) return out;
  for (const v of parsed.data.verdicts) if (!out.has(v.pair)) out.set(v.pair, v);
  return out;
}
