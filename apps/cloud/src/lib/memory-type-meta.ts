// Design review #119, item 10 — one source of truth for the `memories`
// table's MemoryType -> {bg, text} badge styling (decision/preference/
// pattern/insight). This was copy-pasted identically (same keys, same
// colors) between search/page.tsx (MEMORY_TYPE_STYLES) and the inline
// typeStyles map on /conversations/[id].
//
// NOT the same domain as memories-content.tsx's KIND_META: that one styles
// the richer kg_claims/kg_memories `kind` facet (self/person/place/project/
// event/decision/preference/insight/commitment/blocker, ADR 0041) which
// only partially overlaps this table's four MemoryType values (no
// "pattern" in the claim-kind world, no self/person/place/... here) — left
// as its own map rather than force-merged into this one.
import type { MemoryType } from "@/lib/database.types";

export const MEMORY_TYPE_META: Record<MemoryType, { bg: string; text: string }> = {
  decision: { bg: "bg-blue-500/15", text: "text-blue-400" },
  preference: { bg: "bg-green-500/15", text: "text-green-400" },
  pattern: { bg: "bg-amber-500/15", text: "text-amber-400" },
  insight: { bg: "bg-purple-500/15", text: "text-purple-400" },
};

const FALLBACK = { bg: "bg-gray-500/15", text: "text-gray-400" };

export function getMemoryTypeMeta(type: string): { bg: string; text: string } {
  return MEMORY_TYPE_META[type as MemoryType] ?? FALLBACK;
}
