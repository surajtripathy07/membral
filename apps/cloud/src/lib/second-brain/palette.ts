/**
 * Generic per-area accent assignment.
 *
 * The Design-Lab prototype hardcoded an accent hue per area
 * (Career = indigo, Finance = emerald, …). That can't ship as-is: every user's
 * Map has different area names. To keep the "designed" look for ANY user we
 * assign accents deterministically from the area's canonical name, drawing from
 * the curated ramp in the design brief (§4). Same name → same hue across reloads
 * and across surfaces (Map tile, breadcrumb dot, sparkline, constellation).
 */

/** Curated ramp from the brief §4 — perceptually spaced, dark-bg friendly. */
const RAMP = [
  "#6366F1", // indigo
  "#10B981", // emerald
  "#F59E0B", // amber
  "#F43F5E", // rose
  "#8B5CF6", // violet
  "#06B6D4", // cyan
  "#EAB308", // yellow
  "#64748B", // slate
  "#EC4899", // pink
  "#14B8A6", // teal
  "#F97316", // orange
  "#3B82F6", // blue
] as const;

/**
 * Well-known area names map to the brief's exact hues so the canonical demo
 * graph (and any user whose areas happen to match) reproduces the prototype.
 * Falls back to a stable hash into RAMP for everything else.
 */
const KNOWN: Record<string, string> = {
  career: "#6366F1",
  finance: "#10B981",
  financial: "#10B981",
  family: "#F59E0B",
  parenting: "#F59E0B",
  health: "#F43F5E",
  wellness: "#F43F5E",
  home: "#8B5CF6",
  hobby: "#06B6D4",
  hobbies: "#06B6D4",
  learning: "#EAB308",
  civic: "#64748B",
};

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function accentFor(name: string): string {
  const lower = name.toLowerCase();
  for (const key of Object.keys(KNOWN)) {
    if (lower.includes(key)) return KNOWN[key];
  }
  return RAMP[hashStr(lower) % RAMP.length];
}

/**
 * Area status is a small closed enum, shared by the API (which derives it from
 * activity) and the UI (which colors a status dot). Defining it once here — not
 * as ad-hoc string literals — is what lets it generalize: add/rename a status in
 * exactly one place and every surface follows.
 */
export const AREA_STATUS = {
  active: "Active",
  quiet: "Quiet",
  curious: "Just curious",
  duplicate: "Possible duplicate",
  // A user-seeded area (issue #82 Part B review step) with no conversations
  // attached yet — rendered honestly rather than padded or dropped (design §4).
  awaitingContent: "Awaiting content",
} as const;

export type AreaStatus = (typeof AREA_STATUS)[keyof typeof AREA_STATUS];

/** Status dot colors, keyed by the enum values. */
export const AREA_STATUS_COLOR: Record<AreaStatus, string> = {
  [AREA_STATUS.active]: "#34D399",
  [AREA_STATUS.quiet]: "#71717A",
  [AREA_STATUS.curious]: "#64748B",
  [AREA_STATUS.duplicate]: "#F59E0B",
  [AREA_STATUS.awaitingContent]: "#818CF8",
};

/**
 * Pure status derivation from real signals. Lives next to the enum so the rule
 * is one function, not branching string checks. `isDuplicate` is decided by the
 * caller (label-overlap pass) and takes precedence. `isEmptySeeded` marks a
 * user-seeded area (props.empty) — checked next, but only while it still has
 * zero conversations, so an area that later gathers content naturally falls
 * through to the normal active/quiet/curious derivation below.
 */
export function deriveAreaStatus(input: {
  convs: number;
  lastTouchedIso: string | null;
  isDuplicate?: boolean;
  isEmptySeeded?: boolean;
}): AreaStatus {
  if (input.isDuplicate) return AREA_STATUS.duplicate;
  if (input.isEmptySeeded && input.convs === 0) return AREA_STATUS.awaitingContent;
  const days = input.lastTouchedIso
    ? (Date.now() - new Date(input.lastTouchedIso).getTime()) / 86_400_000
    : Number.POSITIVE_INFINITY;
  if (input.convs <= 8) return AREA_STATUS.curious;
  if (days <= 90) return AREA_STATUS.active;
  return AREA_STATUS.quiet;
}

/** Literal placeholder strings the pipeline can emit in place of real JSON null (issue #79). */
function isJunkText(value: string): boolean {
  const low = value.trim().toLowerCase();
  return low === "" || low === "null" || low === "none" || low === "undefined";
}

/**
 * A `kind` badge should render only for a real kind. Extraction sometimes emits
 * the literal STRING "null"/"none" (not SQL NULL) — a truthy value that would
 * otherwise render as a "Null" badge. Returns the trimmed kind, or null when it
 * is empty/whitespace or one of those placeholder strings.
 */
export function displayKind(kind: string | null | undefined): string | null {
  if (!kind || isJunkText(kind)) return null;
  return kind.trim();
}

/**
 * A node LABEL — the primary title on a tile, header, breadcrumb, or picker
 * row — should never render literal LLM junk either (same bug class as
 * displayKind, but for the thing users see first: the observed founder-1k
 * LifeArea tile titled literally "null", node 3c857cae). The pipeline now
 * guards this at the source (stage-a.ts), so the fallback below should be rare
 * — this is defense in depth for rows written before that guard, or any future
 * gap. Callers should keep the rename affordance visible/discoverable wherever
 * this fallback shows, so the user can fix the name in place.
 */
export function displayLabel(label: string | null | undefined, fallback = "Unnamed"): string {
  if (!label || isJunkText(label)) return fallback;
  return label.trim();
}

/** True when `displayLabel` would substitute its fallback for `label` — lets a caller surface a rename invite. */
export function isUnnamedLabel(label: string | null | undefined): boolean {
  return !label || isJunkText(label);
}

/** Stable monogram for a person/org chip. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Deterministic hue (0-360) for a monogram avatar gradient. */
export function nameHue(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return h;
}

/**
 * Truncate a portrait-style summary (issue #89's Person "who this is", or any
 * other LLM-written props.summary) to a one-line subtitle: whole-word cut at
 * `max` chars with an ellipsis, never mid-word. Pairs with the CSS `truncate`
 * class in list rows — this is the character-level cap so a very long summary
 * can't blow past a single line's worth of text before CSS ever clips it.
 */
export function summarySnippet(summary: string | null | undefined, max = 140): string {
  const text = (summary ?? "").trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}
