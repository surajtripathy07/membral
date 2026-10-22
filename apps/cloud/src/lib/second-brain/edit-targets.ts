// Pure filtering for the move / merge target pickers (issue #60, phase 1).
//
// The /api/spike?op=edit-targets read returns every LifeArea + Item with its
// single canonical live `contains` parent. These helpers derive the pickable
// lists client-side: MOVE excludes the node itself and its whole descendant
// subtree (you cannot move a node under its own child — the SQL move rejects
// this too, this is the UX belt); MERGE excludes the node itself and keeps only
// same-class nodes (Item↔Item, LifeArea↔LifeArea, matching kg_edit_merge).

export interface PickerNode {
  id: string;
  label: string;
  type: "LifeArea" | "Item";
  kind: string | null;
  parent_id: string | null;
}

/** ids of nodeId and every node reachable from it via parent_id (its subtree). */
export function descendantsAndSelf(nodes: PickerNode[], nodeId: string): Set<string> {
  const childrenOf = new Map<string, string[]>();
  for (const n of nodes) {
    if (n.parent_id) {
      const arr = childrenOf.get(n.parent_id) ?? [];
      arr.push(n.id);
      childrenOf.set(n.parent_id, arr);
    }
  }
  const out = new Set<string>();
  const stack = [nodeId];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    if (out.has(cur)) continue; // guards cyclic dirty data
    out.add(cur);
    for (const c of childrenOf.get(cur) ?? []) stack.push(c);
  }
  return out;
}

// Sentinel id for the synthetic "Top level" picker row (handoff 0024
// directive B item 1 / issue #60: promote a sub-bucket to a top-level life
// area). Never a real kg_nodes id, so it can't collide with one — the caller
// checks for this id and sends newParentId: null to /api/graph/edit instead
// of a real destination uuid. kg_edit_move (migration 032) treats a null
// parent as "clear the parent", flipping the node to type LifeArea if it
// isn't one already so it surfaces as a /map root — same undo contract as
// any other move.
export const TOP_LEVEL_TARGET_ID = "__top_level__";

/**
 * Valid "Move to" destinations: any LifeArea/Item that is not self or a
 * descendant, PLUS a synthetic "Top level" row — unless the node is already
 * top-level (no live parent), in which case there is nothing to promote it
 * to and the row is omitted. `self` not being found in `nodes` (e.g. an
 * entity node not covered by the edit-targets read) also omits it, same as
 * "already top level" — safest default.
 */
export function moveTargets(nodes: PickerNode[], nodeId: string): PickerNode[] {
  const excluded = descendantsAndSelf(nodes, nodeId);
  const real = nodes.filter((n) => !excluded.has(n.id));
  const self = nodes.find((n) => n.id === nodeId);
  if (!self || self.parent_id === null) return real;
  const topLevel: PickerNode = {
    id: TOP_LEVEL_TARGET_ID,
    label: "Top level",
    type: "LifeArea",
    kind: null,
    parent_id: null,
  };
  return [topLevel, ...real];
}

/** Valid "Merge into" targets: same class, not self. (Descendants ARE allowed to merge.) */
export function mergeTargets(nodes: PickerNode[], nodeId: string, nodeType: PickerNode["type"]): PickerNode[] {
  return nodes.filter((n) => n.id !== nodeId && n.type === nodeType);
}

/** Case-insensitive label substring filter for the picker search box. */
export function filterByQuery(nodes: PickerNode[], query: string): PickerNode[] {
  const q = query.trim().toLowerCase();
  if (!q) return nodes;
  return nodes.filter((n) => n.label.toLowerCase().includes(q));
}
