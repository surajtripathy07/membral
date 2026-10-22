/**
 * Issue/MR identity: the ONE key function the write path (grounding,
 * session association) and every read path (Today, Issues) use to decide
 * whether two ref spellings name the same item (D-064, R3 #242 + #168;
 * design note docs/design/ref-identity-canonical-key.md).
 *
 * Key: `kind \0 [host/]owner/repo#N`, lower-cased. The host is kept, so
 * `github.com/acme/api#5` and `codehub.example/acme/api#5` are two items —
 * never merged, at write time or at read time. A host-less spelling
 * (`acme/api#5`, `acme/api!5`) takes a host only when exactly ONE host in the
 * scope set holds that owner/repo + number + kind; with two hosts (or none)
 * it keys on itself.
 *
 * The scope is whatever set the caller is deciding over: at write time the
 * session's model refs plus its observed refs (the project identity has
 * already qualified the project's own refs through `canonicalItemRef`); at
 * read time the rows being rendered. Stored rows are never rewritten
 * (no backfill, D-064).
 *
 * Imports flow one way: this module uses the ref PARSER in
 * `lib/code-sessions/ref-canon.ts`; ref-canon imports nothing from here.
 */
import { canonicalItemRef, HOSTLIKE, type ItemKind, normalizeHost } from "@/lib/code-sessions/ref-canon";

interface RefKeyParts {
  kind: string;
  /** Lower-cased host, or null when the spelling carries none. */
  host: string | null;
  /** Lower-cased `owner/repo#N`. */
  item: string;
}

function refKeyParts(ref: string, kind: string): RefKeyParts | null {
  if (kind === "branch" || kind === "commit") return pointKeyParts(ref, kind);
  const k: ItemKind = kind === "merge_request" ? "merge_request" : "issue";
  const c = canonicalItemRef(ref, null, k);
  if (!c) return null;
  const at = c.ref.lastIndexOf("#");
  const segs = c.ref.slice(0, at).toLowerCase().split("/").filter(Boolean);
  const host = segs.length >= 3 && HOSTLIKE.test(segs[0]) ? (segs.shift() as string) : null;
  return { kind, host, item: `${segs.join("/")}#${c.number}` };
}

const SHA = /^[0-9a-f]{7,40}$/;

/**
 * W3 D9: a branch or a commit spelled `[host/]owner/repo@name` (`@name` alone when the repo is not
 * known). The repo path is lower-cased and its host normalised; a branch name keeps its case, a
 * sha is lower-cased and must be 7–40 hex.
 */
function pointKeyParts(ref: string, kind: "branch" | "commit"): RefKeyParts | null {
  const at = ref.indexOf("@");
  if (at === -1) return null;
  const name =
    kind === "commit"
      ? ref
          .slice(at + 1)
          .trim()
          .toLowerCase()
      : ref.slice(at + 1).trim();
  if (!name || (kind === "commit" && !SHA.test(name))) return null;
  const segs = ref.slice(0, at).trim().toLowerCase().split("/").filter(Boolean);
  const host = segs.length >= 3 && HOSTLIKE.test(segs[0]) ? normalizeHost(segs.shift() as string) : null;
  return { kind, host, item: `${segs.join("/")}@${name}` };
}

function partsKey(p: RefKeyParts): string {
  return `${p.kind}\u0000${p.host ? `${p.host}/` : ""}${p.item}`;
}

/** The `owner/repo` an item, branch or commit part names (`""` when none). */
function repoOf(item: string): string {
  const cut = item.search(/[#@]/);
  return cut === -1 ? item : item.slice(0, cut);
}

export interface ItemKeyResolverOptions {
  /**
   * W3 D9: the user's project identities (`code_projects.repo_identity`). Each hosted one
   * (`codehub.example/acme/api`) adds its host to the host set of every item of that owner/repo,
   * so a host-less spelling binds to it only when no other host holds the item or the repo.
   */
  projectIdentities?: Iterable<string | null | undefined>;
}

/**
 * THE key function (D-064). Built over a scope set of `{ref, kind}`; returns
 * the identity of one spelling within that scope. Every spelling keys as
 * lower-cased `kind \0 [host/]owner/repo#N`, except a host-less one whose
 * owner/repo + number + kind matches exactly ONE host in the scope: it takes
 * that hosted key (`acme/billing!17049` joins `codehub.example/acme/billing#17049`).
 * Two hosts for the same item (github.com and codehub.example) — the
 * host-less spelling stays its own item; different hosts never collapse
 * (e2e S5). A ref that is not ref syntax keys on itself. The kind passed in
 * is the stored kind and is never overridden by the syntax. Pure.
 *
 * W3 D9 (docs/design/observed-forge-refs.md §3): kinds `branch` and `commit`
 * key as `kind \0 [host/]owner/repo@name|sha` under the same host rule, and a
 * short sha binds to the one longer in-scope sha of that repo it prefixes
 * (none or several: it keys on itself). `opts.projectIdentities` adds the
 * projects' hosts to the host sets (see ItemKeyResolverOptions).
 */
export function itemKeyResolver(
  scope: Iterable<{ ref: string; kind: string }>,
  opts: ItemKeyResolverOptions = {},
): (ref: string, kind: string) => string {
  const hosts = new Map<string, Set<string>>();
  const add = (map: Map<string, Set<string>>, key: string, value: string) => {
    const set = map.get(key) ?? new Set<string>();
    set.add(value);
    map.set(key, set);
  };
  const repoHosts = new Map<string, Set<string>>();
  for (const id of opts.projectIdentities ?? []) {
    if (!id) continue;
    const segs = id.trim().toLowerCase().split("/").filter(Boolean);
    if (segs.length < 3 || !HOSTLIKE.test(segs[0])) continue;
    add(repoHosts, segs.slice(1).join("/"), normalizeHost(segs[0]));
  }
  // Commit shas in scope per host-less `owner/repo`, for short-sha binding.
  const shas = new Map<string, Set<string>>();
  for (const r of scope) {
    const p = refKeyParts(r.ref, r.kind);
    if (!p) continue;
    if (p.kind === "commit") add(shas, repoOf(p.item), p.item.slice(p.item.indexOf("@") + 1));
    if (p.host) add(hosts, `${p.kind}\u0000${p.item}`, p.host);
  }
  return (ref, kind) => {
    let p = refKeyParts(ref, kind);
    if (!p) return `${kind}\u0000${ref.trim()}`;
    if (p.kind === "commit") {
      const repo = repoOf(p.item);
      const sha = p.item.slice(p.item.indexOf("@") + 1);
      const longer = [...(shas.get(repo) ?? [])].filter((s) => s.startsWith(sha));
      if (sha.length < 40 && longer.length === 1) p = { ...p, item: `${repo}@${longer[0]}` };
    }
    if (!p.host) {
      const set = new Set([...(hosts.get(`${p.kind}\u0000${p.item}`) ?? []), ...(repoHosts.get(repoOf(p.item)) ?? [])]);
      if (set.size === 1) return partsKey({ ...p, host: [...set][0] });
    }
    return partsKey(p);
  };
}

const EMPTY_SCOPE = itemKeyResolver([]);

/**
 * One spelling's key with an empty scope (`itemKeyResolver([])`): a hosted
 * spelling keys on its host, a host-less one on itself. For incremental
 * dedup maps where the full scope is not known up front.
 */
export function itemReadKey(ref: string, kind: string): string {
  return EMPTY_SCOPE(ref, kind);
}

const GITHUB_HOST = /^(?:[\w-]+\.)*github\.[a-z]+$/i;
/** Tiers written from an action (the profile); every other tier is the extractor's reading. */
const ACTION_TIERS = new Set(["observed", "inferred_ref"]);

/**
 * The GitHub item two spellings name, kind aside: on GitHub an issue and a
 * pull request share one number space, so `github.com/o/r#5` as an issue and
 * as a PR is one item (foldDiscussedKinds). Null off GitHub, where `#N` and
 * `!N` are different items. Pure.
 */
export function githubItemKey(ref: string): string | null {
  const p = refKeyParts(ref, "issue");
  return p?.host && GITHUB_HOST.test(p.host) ? `${p.host}/${p.item}` : null;
}

/**
 * One row per item at read time. On GitHub an issue and a pull request share
 * one number space, so a MODEL-only row (tier discussed / inferred / none —
 * the extractor guessed the kind) for `owner/repo#N` is the same item as an
 * action-backed row of the other kind on that ref: it takes that kind, so the
 * Issues page and Today's threads show one row whose verbs merge, never a
 * "discussed" twin beside the "viewed" one. glab-family forges keep `#N`
 * (issue) and `!N` (merge request) apart — different items. Pure.
 */
export function foldDiscussedKinds<R extends { ref: string; kind: string; tier?: string | null }>(
  rows: readonly R[],
): R[] {
  const observedKinds = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!ACTION_TIERS.has(r.tier ?? "")) continue;
    const item = githubItemKey(r.ref);
    if (!item) continue;
    const set = observedKinds.get(item) ?? new Set<string>();
    set.add(r.kind);
    observedKinds.set(item, set);
  }
  if (observedKinds.size === 0) return [...rows];
  return rows.map((r) => {
    if (ACTION_TIERS.has(r.tier ?? "")) return r;
    const item = githubItemKey(r.ref);
    const kinds = item ? observedKinds.get(item) : undefined;
    if (!kinds || kinds.has(r.kind) || kinds.size !== 1) return r;
    return { ...r, kind: [...kinds][0] };
  });
}
