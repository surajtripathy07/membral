// Project label clubbing (migration 060, goal 2026-08-26 W7/D8; fixed by
// migration 063 — see that migration's header for the fresh-adversarial-
// review findings it addresses) — reusable helpers for the /code list and,
// later, the bridge context proposal's grouping by canonical (wired up by
// the driver separately; NOT this file's concern). project_aliases (one row
// per (user, alias)) is seeded server-side by project_alias_seed() and read
// back here as a flat alias -> canonical map; canonicalize() does the
// recursive alias -> canonical -> canonical... walk, depth-capped at 5,
// mirroring project_alias_resolve() (063: identical seen-set cycle-guard
// semantics on both sides — see that function's own comment) — the same
// shape claims_browse_entity_labels now consults before its prefix-collapse
// groups labels for the Memory browser's Projects facet.
import type { Db } from "@/lib/db/types";

/** A TLD-shaped trailing suffix stripped BEFORE punctuation removal — see project_alias_normalize (migration 060). */
const TLD_SUFFIX_RE = /\.(com|ai|io|net|org|co|app|dev|xyz|so)$/;

/**
 * Mirrors project_alias_normalize(text) (migration 060) byte-for-byte:
 * casefold + trim, strip everything up to the LAST '/' (covers both a
 * leading `dev/` and an `owner/` prefix — there's only ever one distinction
 * to make), strip a trailing TLD-shaped suffix, then strip every remaining
 * non-alphanumeric character. See this file's test for the shared fixture
 * list both implementations are checked against.
 *
 * NOTE (migration 063, finding #4): this function is deliberately UNCHANGED
 * — it's still the pure "bare name" transform. The owner-prefix-strip it
 * does is fine for COMPARING bare names; the bug the review found was using
 * bare-name equality ALONE to decide a merge is safe (`acme/web` and
 * `beta/web` both normalize to "web"). The fix is projectOwnerSegment below,
 * consulted ALONGSIDE this function by project_alias_seed's SQL side — this
 * file has no seed/edge-generation logic of its own, so
 * projectOwnerSegment's only job here is to stay in lockstep with the SQL
 * mirror for testability (see this file's test).
 */
export function normalizeProjectSlug(label: string): string {
  const trimmed = (label ?? "").trim().toLowerCase();
  if (!trimmed) return "";
  const afterSlash = trimmed.replace(/^.*\//, "");
  const noTld = afterSlash.replace(TLD_SUFFIX_RE, "");
  return noTld.replace(/[^a-z0-9]/g, "");
}

/**
 * Mirrors project_alias_owner(text) (migration 063, finding #4) byte-for-
 * byte: the segment before the LAST '/', normalized (casefold + strip
 * non-alphanumeric), or null when the label has no slash at all, or the
 * prefix itself contains another slash (an absolute path or a
 * host/owner/repo identity string — not a confident two-part "owner/repo"
 * shape, treated as ownerless, the safe/backward-compatible default).
 * Deliberately no special-case for a literal "dev" prefix — see migration
 * 063's header for why `dev/membral` vs `surajtripathy07/membral` getting
 * DIFFERENT owners (and so no slug edge) is correct: that pair still merges
 * via the unchanged remote-lineage heuristic, which is what actually did
 * the work for the real founder corpus.
 */
export function projectOwnerSegment(label: string): string | null {
  const trimmed = (label ?? "").trim();
  const lastSlash = trimmed.lastIndexOf("/");
  if (lastSlash <= 0) return null; // no slash, or a leading slash with nothing before it
  const prefix = trimmed.slice(0, lastSlash);
  if (prefix.includes("/")) return null; // 2+ slashes -- ambiguous, treat as ownerless
  const cleaned = prefix.toLowerCase().replace(/[^a-z0-9]/g, "");
  return cleaned || null;
}

/**
 * Recursive alias -> canonical resolution, depth-capped at 5, mirroring
 * project_alias_resolve() (migration 060, cycle-guard fixed by 063 finding
 * #7): walks `map` (alias -> canonical, one hop per row — the flat shape
 * resolveProjectCanonical returns) until a miss, a hop that revisits any
 * label already seen on THIS walk (not just an immediate self-hop — a
 * malformed/manually-edited chain, including a genuine cycle, must never
 * spin, and must land on the exact same label the SQL side lands on — see
 * this file's test for 2-/3-/4-member cycle parity verified against a live
 * project_alias_resolve call), or the depth cap. A label with no entry in
 * `map` (already canonical, or unknown) returns itself unchanged.
 */
export function canonicalize(label: string, map: Map<string, string>): string {
  const trimmed = (label ?? "").trim();
  if (!trimmed) return label;

  let current = trimmed;
  const seen = new Set<string>([current]);
  for (let depth = 0; depth < 5; depth++) {
    const next = map.get(current);
    if (!next || next === current || seen.has(next)) break;
    current = next;
    seen.add(current);
  }
  return current;
}

export interface ProjectAliasRow {
  alias: string;
  canonical: string;
  /** 'unmerged' (migration 063, finding #3): a self-referencing tombstone (alias === canonical) — see POST /api/memory/projects/merge's unmerge action. */
  source: "slug" | "remote-lineage" | "manual" | "unmerged";
}

/**
 * Loads this user's project_aliases rows (RLS-scoped — pass the cookie-
 * bound server client, never a service-role client, same convention as
 * lib/memory/claims-browse.ts) as a flat alias -> canonical map. One hop per
 * entry; callers walk chains via canonicalize() above, not here — this
 * function does no resolution of its own, just the read.
 */
export async function resolveProjectCanonical(supabase: Db, userId: string): Promise<Map<string, string>> {
  const { data, error } = await supabase.from("project_aliases").select("alias, canonical").eq("user_id", userId);
  if (error) throw new Error(`project_aliases fetch failed: ${error.message}`);
  const map = new Map<string, string>();
  for (const row of (data ?? []) as Pick<ProjectAliasRow, "alias" | "canonical">[]) {
    if (row.alias && row.canonical) map.set(row.alias, row.canonical);
  }
  return map;
}
