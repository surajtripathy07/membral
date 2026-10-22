// Goal 2026-09-26 P9 / W10 — repeated tool sequences → a drafted skill.

export { type DerivePatternsSummary, derivePatternsForUser, derivePatternsNightly } from "./derive";
export {
  draftSkill,
  heuristicSkill,
  type PatternQuote,
  quotesForPattern,
  renderSkillBody,
  type SkillDraft,
  SkillDraftSchema,
} from "./draft-skill";
export { MAX_PATTERNS_PER_PROJECT, minePatterns, type Pattern, type PatternTurn, stepLabel } from "./mine";
export { parseStoredPatterns, type StoredPattern, withStoredPatterns } from "./storage";
