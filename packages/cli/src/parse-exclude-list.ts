// Extracted from the deleted context-proposal.ts (bridge/start/continue
// command support, removed with the bridge — 2026-09-12 refocus goal's kill
// list) because `membral setup`'s own sync-exclusion prompt (unrelated to
// the bridge) also needs it.

/** Parses "--exclude 3,7" (or a prompt-entered "3, 7") into a set of item numbers. Non-numeric/garbage entries are silently dropped rather than failing the command. */
export function parseExcludeList(raw: string | undefined): Set<number> {
  if (!raw) return new Set();
  const nums = raw
    .split(",")
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);
  return new Set(nums);
}
