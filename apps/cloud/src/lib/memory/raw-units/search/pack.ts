// Packing of the served lines (lab src/search.mjs:55-65 `packToBudget`, token count src/store.mjs:12 `charsOver4`).
// docs/design/i33-port.md D7: whole lines in order, stop at the FIRST line that does not fit, tokens = ceil(chars / 4)
// over the lines joined by "\n". Replaces `fitToTokenBudget`'s skip-and-continue for this tool.

export const charsOver4 = (s: string): number => Math.ceil(String(s ?? "").length / 4);

export function packLines<T extends string>(lines: readonly T[], maxTokens: number): { lines: T[]; tokens: number } {
  const kept: T[] = [];
  let tokens = 0;
  for (const line of lines) {
    const t = charsOver4([...kept, line].join("\n"));
    if (t > maxTokens) break;
    kept.push(line);
    tokens = t;
  }
  return { lines: kept, tokens };
}
