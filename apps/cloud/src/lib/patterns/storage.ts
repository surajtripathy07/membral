// Goal 2026-09-26 P9 / W10 — the `code_projects.props.patterns` shape.
//
// code_projects already has a jsonb `props` column (migration 029; the
// rollup pass keeps `rollup`, `rollup_status`, … in it), so patterns live
// beside those keys under `patterns` — no migration. Bounded: at most
// MAX_PATTERNS_PER_PROJECT entries are ever written or read.
import type { PatternQuote, SkillDraft, SkillDraftSource } from "./draft-skill";
import { MAX_PATTERNS_PER_PROJECT, type Pattern } from "./mine";

export interface StoredSkillDraft extends SkillDraft {
  /** ISO time the draft was produced — re-drafted by the LLM at most once a week. */
  draftedAt: string;
}

export interface StoredPattern extends Pattern {
  /** ISO time the pattern was (last) mined. */
  minedAt: string;
  draft: StoredSkillDraft | null;
}

export const PATTERNS_PROP_KEY = "patterns";

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function parseSources(v: unknown): PatternQuote[] {
  if (!Array.isArray(v)) return [];
  const out: PatternQuote[] = [];
  for (const item of v) {
    if (!item || typeof item !== "object") continue;
    const q = item as Record<string, unknown>;
    if (typeof q.session_id !== "string" || typeof q.quote !== "string") continue;
    const idx = typeof q.turn_idx === "number" && Number.isFinite(q.turn_idx) ? q.turn_idx : 0;
    out.push({ session_id: q.session_id, turn_idx: idx, quote: q.quote });
  }
  return out;
}

function parseDraft(v: unknown): StoredSkillDraft | null {
  if (!v || typeof v !== "object") return null;
  const d = v as Record<string, unknown>;
  if (typeof d.name !== "string" || typeof d.description !== "string" || !isStringArray(d.steps)) return null;
  if (d.steps.length === 0) return null;
  const source: SkillDraftSource = d.source === "llm" ? "llm" : "heuristic";
  return {
    name: d.name,
    description: d.description,
    steps: d.steps,
    source,
    sources: parseSources(d.sources),
    draftedAt: typeof d.draftedAt === "string" ? d.draftedAt : "",
  };
}

/** Tolerant read of props.patterns: anything malformed is dropped, never thrown; at most 3 returned. */
export function parseStoredPatterns(props: unknown): StoredPattern[] {
  if (!props || typeof props !== "object") return [];
  const raw = (props as Record<string, unknown>)[PATTERNS_PROP_KEY];
  if (!Array.isArray(raw)) return [];
  const out: StoredPattern[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const p = item as Record<string, unknown>;
    if (!isStringArray(p.steps) || p.steps.length === 0) continue;
    const sessionCount = typeof p.sessionCount === "number" && Number.isFinite(p.sessionCount) ? p.sessionCount : 0;
    out.push({
      key: typeof p.key === "string" && p.key ? p.key : p.steps.join(" → "),
      steps: p.steps,
      sessionCount,
      sessionIds: isStringArray(p.sessionIds) ? p.sessionIds : [],
      lastSeenAt: typeof p.lastSeenAt === "string" ? p.lastSeenAt : null,
      minedAt: typeof p.minedAt === "string" ? p.minedAt : "",
      draft: parseDraft(p.draft),
    });
    if (out.length >= MAX_PATTERNS_PER_PROJECT) break;
  }
  return out;
}

/** Merge `patterns` into an existing props object without touching its other keys. */
export function withStoredPatterns(props: unknown, patterns: StoredPattern[]): Record<string, unknown> {
  const base =
    props && typeof props === "object" && !Array.isArray(props) ? { ...(props as Record<string, unknown>) } : {};
  base[PATTERNS_PROP_KEY] = patterns.slice(0, MAX_PATTERNS_PER_PROJECT);
  return base;
}
