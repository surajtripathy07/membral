// ADR 0032 §7 — validated categorical palette for the dark chart surface
// (--color-surface #16161b). Pinned in one exported constant per the ADR's
// "Verification hook" so a drive-by color edit fails the test in
// __tests__/palette.test.ts instead of silently breaking CVD safety.
//
// Validator invocation + result recorded in ADR 0032 §7, re-run for this
// implementation, and re-run again for the membral-k89 Fable-tier addition
// (5 slots, Fable ordered above Opus per MODEL_TIER_ORDER):
//   node scripts/validate_palette.js \
//     "#c94f9e,#3987e5,#d95926,#199e70,#c98500" \
//     --mode dark --surface "#16161b" --pairs adjacent
//   -> ALL CHECKS PASS (worst adjacent CVD ΔE 8.4, normal-vision ΔE 19.8 —
//      the Fable/Opus pair itself is well clear of both floors)
//
// Order is fixed by MODEL_TIER_ORDER (lib/agent-stats/aggregate.ts), never
// by rank/rendered value — a range change that drops a tier must not repaint
// the survivors (dataviz skill: "color follows the entity, never its rank").
export const MODEL_TIER_COLORS = {
  Fable: "#c94f9e",
  Opus: "#3987e5",
  Sonnet: "#d95926",
  Haiku: "#199e70",
  Other: "#c98500",
} as const;

export type ModelTierColorKey = keyof typeof MODEL_TIER_COLORS;

// Single-series marks (B3's daily columns / cumulative line) always use slot
// 1 — "one series, one color, categorical slot 1" (ADR 0032 §3 B3). Pinned
// to Opus's hex specifically (not "MODEL_TIER_ORDER[0]") so adding Fable
// above Opus in display order does not repaint B3's chart color.
export const SERIES_1 = MODEL_TIER_COLORS.Opus;

// Status tokens (ADR 0032 §7) — reserved, never reused as a categorical
// series; always ship with an icon + label, never color alone.
export const STATUS_GOOD = "#0ca30c";
export const STATUS_WARNING = "#fab219";
export const STATUS_CRITICAL = "#d03b3b";

// Chart chrome/ink — theme tokens (globals.css), so axes and gridlines follow
// light/dark with the page. SVG fill/stroke resolve var() like any CSS color.
export const VIZ_INK_2 = "var(--color-muted)"; // axis/tick text — ≥4.8:1 on surface in both modes
export const VIZ_INK_MUTED = "var(--color-faint)"; // chrome only, never text
export const VIZ_GRIDLINE_SOFT = "var(--color-line-soft)"; // recessive hairline
export const VIZ_BORDER_STRONG = "var(--color-line)"; // baseline / axis rule
