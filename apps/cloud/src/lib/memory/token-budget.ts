// memory_search's max_tokens (W3): keep the served records inside a token
// budget so one search cannot flood the calling agent's context.
//
// Tokens are ESTIMATED, deterministically: the record's JSON length / 4,
// rounded up (~4 characters per token for English and JSON on the GPT/Claude
// tokenizers). No tokenizer dependency; the estimate errs a little high on
// prose, which keeps the budget a ceiling rather than a target.

/**
 * Default budget. A served (compact) record is ~450-570 chars on the local
 * corpus (text + quote average ~210 chars, p90 ~320, plus ids/repo/branch/when),
 * i.e. ~115-145 estimated tokens -- so 1500 serves the default 10 records
 * whole and trims only when quotes run long.
 */
export const DEFAULT_MAX_TOKENS = 1500;
export const MIN_MAX_TOKENS = 200;
export const MAX_MAX_TOKENS = 20_000;

export function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 4);
}

/**
 * Pack records in rank order into the budget: a record that does not fit the room left is skipped and
 * smaller, lower-ranked ones keep filling it. The first record is always kept whole, even alone over
 * budget: one long answer beats an empty result with nothing to say why. `skipped` holds what was left
 * out, in rank order, so the caller can say which.
 */
export function fitToTokenBudget<T>(
  records: readonly T[],
  maxTokens: number,
): { records: T[]; dropped: number; tokens: number; skipped: T[] } {
  const kept: T[] = [];
  const skipped: T[] = [];
  let tokens = 0;
  for (const r of records) {
    const cost = estimateTokens(r);
    if (kept.length > 0 && tokens + cost > maxTokens) {
      skipped.push(r);
      continue;
    }
    kept.push(r);
    tokens += cost;
  }
  return { records: kept, dropped: skipped.length, tokens, skipped };
}
