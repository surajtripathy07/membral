/**
 * D-066 (clarifies D-056): the ONE rule for pricing a sub-agent child that has no
 * attribution rows of its own (it took no forge action: scouts, verifiers, builders
 * that edit but never commit).
 *
 * Such a child is part of its parent session for cost. Its cost is split over the
 * parent's items in the parent's proportions, and only over items the parent holds
 * PR/branch evidence for (the parent's shares already exclude unpriced rows, D-056).
 * A child never creates a priced item. A child whose ancestors hold no priced rows
 * leaves its cost unattributed. A child WITH rows of its own is priced by its own
 * rows only (this rule does not apply to it).
 *
 * Both views call this: Issues (`aggregateIssueAttribution`) and Today
 * (`buildThreads` in lib/threads/open-threads.ts).
 */

/**
 * The session whose items price `childId`: the nearest ancestor (following `parentOf`,
 * child id -> parent id) that has rows of its own. Null when `childId` has rows of its
 * own, is not a child, or no ancestor has rows (its cost stays unattributed).
 * Cycle-safe.
 */
export function costParentOf(
  childId: string,
  parentOf: ReadonlyMap<string, string>,
  hasOwnRows: (sessionId: string) => boolean,
): string | null {
  if (hasOwnRows(childId)) return null;
  const seen = new Set<string>([childId]);
  let cur = parentOf.get(childId);
  while (cur !== undefined && !seen.has(cur)) {
    if (hasOwnRows(cur)) return cur;
    seen.add(cur);
    cur = parentOf.get(cur);
  }
  return null;
}

/** Every row-less child grouped under the session whose items price it. */
export function rowlessChildrenByCostParent(
  sessionIds: Iterable<string>,
  parentOf: ReadonlyMap<string, string>,
  hasOwnRows: (sessionId: string) => boolean,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const id of sessionIds) {
    if (!parentOf.has(id)) continue;
    const p = costParentOf(id, parentOf, hasOwnRows);
    if (!p) continue;
    const list = out.get(p) ?? [];
    list.push(id);
    out.set(p, list);
  }
  return out;
}

/** The share of a row-less child's cost one item takes: the parent's share on that item (0 when unpriced). */
export function childCostOnItem(childCostUsd: number, parentShareOnItem: number): number {
  return parentShareOnItem > 0 ? childCostUsd * parentShareOnItem : 0;
}
