/**
 * W3 D9: the observed forge links of one coding session — one row per
 * (turn, action, item) a structured forge action showed — for
 * `code_session_forge_refs` (migration 115). Design:
 * docs/design/observed-forge-refs.md §1–§3, §5.
 *
 * Input is the stored turn `props.action` / `props.actions` (the parser's
 * output, packages/core forge-actions). Pure, deterministic, no LLM: the
 * importer writes the rows in the same transaction as the turns
 * (`import_code_session_turns`, 5-argument overload) and the backfill
 * (scripts/backfill-forge-refs.ts) through `replace_code_session_forge_refs`.
 *
 * Identity is the one resolver (`itemKeyResolver`, lib/domain/ref-identity.ts)
 * over the session's own rows plus the user's project identities; `item_key`
 * is a write-time cache, re-resolved on read.
 */
import { createHash } from "node:crypto";
import { isForgeRepoIdentity } from "@/lib/attribution/grounding";
import type { Db } from "@/lib/db/types";
import { githubItemKey, itemKeyResolver } from "@/lib/domain/ref-identity";
import { log } from "@/lib/log";
import { commitSubjectRefs } from "./profile";
import { canonicalItemRef, HOSTLIKE, hostlessRefQualifier, type ItemKind, normalizeHost } from "./ref-canon";

/**
 * The stored form of a resolver key (`itemKeyResolver`): Postgres text cannot hold U+0000, so the
 * `kind \0 item` separator is stored as a space (kinds and refs carry no whitespace, so it stays
 * one-to-one). The D5 reader applies the same transform to the keys it re-resolves.
 */
export function storedItemKey(key: string): string {
  return key.replaceAll("\u0000", " ").slice(0, 600);
}

/** Stored as `code_sessions.props.forge_refs_version`; the backfill refills sessions below it. */
export const FORGE_REFS_VERSION = 1;

export type ForgeRefKind = "issue" | "merge_request" | "commit" | "branch" | "comment";

export interface ForgeRefRow {
  turn_idx: number;
  action_ix: number;
  kind: ForgeRefKind;
  target_kind: ItemKind | null;
  verb: string;
  source: string;
  prose_ref: boolean;
  host: string | null;
  project: string | null;
  number: number | null;
  sha: string | null;
  branch: string | null;
  observed_state: string | null;
  title: string | null;
  url: string | null;
  observed_at: string;
  item_key: string;
}

export interface ForgeRefTurn {
  idx: number;
  ts?: string | null;
  tool_name?: string | null;
  props?: unknown;
}

export interface ForgeRefsContext {
  /** The session's `code_projects.repo_identity`. */
  projectIdentity: string | null;
  /** Every `repo_identity` of the user's projects (host binding, §3). */
  projectIdentities: Iterable<string | null | undefined>;
  /** `code_sessions.started_at`: `observed_at` for a turn with no `ts`. */
  startedAt: string;
}

const SOURCES = new Set(["cli", "mcp", "command", "paste"]);
const SHA = /^[0-9a-f]{7,40}$/;
const MARKED = /^(.*?)([#!])(\d+)$/;
const MAX_INT = 2_147_483_647;
// §2 single-item rule, re-applied to stored MCP actions: a listing tool's state/title is never one item's.
const MCP_LISTING = /(?:^|_)(?:list|search)_|_(?:notes|comments|discussions|diffs|changes|commits|pipelines)$/i;
const MCP_STATE_VERBS = new Set(["viewed", "merged", "closed"]);

interface RawAction {
  verb: string;
  source: string;
  ref?: string;
  refKind?: string;
  sha?: string;
  url?: string;
  state?: string;
  branch?: string;
  subject?: string;
  title?: string;
  repoUnknown?: boolean;
  branchConfirmed?: boolean;
}

function str(v: unknown, max: number): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined;
}

function asRaw(v: unknown): RawAction | null {
  if (!v || typeof v !== "object") return null;
  const a = v as Record<string, unknown>;
  if (typeof a.verb !== "string" || typeof a.source !== "string" || !SOURCES.has(a.source)) return null;
  return {
    verb: a.verb.slice(0, 40),
    source: a.source,
    ref: str(a.ref, 300),
    refKind: str(a.refKind, 20),
    sha: str(a.sha, 40)?.toLowerCase(),
    url: str(a.url, 500),
    state: str(a.state, 20),
    branch: str(a.branch, 200),
    subject: str(a.subject, 400),
    title: str(a.title, 200),
    repoUnknown: a.repoUnknown === true,
    branchConfirmed: a.branchConfirmed === true,
  };
}

/** A turn's actions with their position: `props.actions` when present, else `props.action` at 0 (as `turnActions`). */
function rawActions(props: unknown): Array<{ ix: number; a: RawAction }> {
  if (!props || typeof props !== "object") return [];
  const p = props as Record<string, unknown>;
  if (Array.isArray(p.actions) && p.actions.length > 0) {
    const out: Array<{ ix: number; a: RawAction }> = [];
    p.actions.forEach((v, ix) => {
      const a = asRaw(v);
      if (a) out.push({ ix, a });
    });
    return out;
  }
  const one = asRaw(p.action);
  return one ? [{ ix: 0, a: one }] : [];
}

/** `host/owner/repo` → its parts, host normalised and path lower-cased; null for any other shape. */
function hostedPath(path: string): { host: string; project: string } | null {
  const segs = path.trim().replace(/\/+$/, "").split("/").filter(Boolean);
  if (segs.length < 3 || !HOSTLIKE.test(segs[0])) return null;
  return { host: normalizeHost(segs[0]), project: segs.slice(1).join("/").toLowerCase() };
}

/** Host and owner/repo of a URL (`https://codehub.example/acme/api/-/issues/5` with project `acme/api`). */
function urlHost(url: string | undefined, project: string): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    const path = u.pathname.toLowerCase().replace(/^\/+/, "");
    return path.startsWith(`${project.toLowerCase()}/`) ? normalizeHost(u.host) : null;
  } catch {
    return null;
  }
}

interface Pending {
  row: Omit<ForgeRefRow, "item_key">;
  /** The spelling the resolver keys, and the kind it keys under (a comment's target kind). */
  spelling: string;
  keyKind: string;
  /** A commit subject's item ref with no kind of its own (§2 GitHub kind fold). */
  subject?: boolean;
}

/**
 * Every observed forge ref of one session, ready for `code_session_forge_refs`.
 * Unique per (turn_idx, action_ix, kind, item_key). Pure; never throws on a
 * malformed action (it is skipped).
 */
export function computeForgeRefs(turns: readonly ForgeRefTurn[], ctx: ForgeRefsContext): ForgeRefRow[] {
  const identities = [...ctx.projectIdentities].filter((x): x is string => typeof x === "string" && !!x.trim());
  const projectIdentity = ctx.projectIdentity?.trim() || null;
  const forgeProject = projectIdentity && isForgeRepoIdentity(projectIdentity) ? projectIdentity : null;
  const project = forgeProject ? hostedPath(forgeProject) : null;
  const qualifyHostless = hostlessRefQualifier(identities);
  const pending: Pending[] = [];

  for (const turn of turns) {
    if (!Number.isInteger(turn.idx)) continue;
    const ts = typeof turn.ts === "string" && !Number.isNaN(Date.parse(turn.ts)) ? turn.ts : ctx.startedAt;
    const props = (turn.props ?? {}) as Record<string, unknown>;
    const toolName = String(props.mcpTool ?? turn.tool_name ?? "");
    const evidence = typeof props.inputDigest === "string" ? props.inputDigest : null;
    for (const { ix, a } of rawActions(turn.props)) {
      const base = {
        turn_idx: turn.idx,
        action_ix: ix,
        verb: a.verb,
        source: a.source,
        prose_ref: a.verb === "referenced",
        observed_at: ts,
      };
      // §2: an MCP listing's state/title are never this item's; a state is never implied by a verb.
      const mcpListing = a.source === "mcp" && MCP_LISTING.test(toolName);
      const state = a.source === "mcp" && (mcpListing || !MCP_STATE_VERBS.has(a.verb)) ? null : (a.state ?? null);
      const title = a.source === "mcp" && (mcpListing || a.verb !== "viewed") ? null : (a.title ?? null);

      if ((a.refKind === "issue" || a.refKind === "merge_request") && a.ref) {
        const item = itemRow(a.ref, a.refKind, a, { forgeProject, qualifyHostless, evidence });
        if (!item) continue;
        const comment = a.verb === "commented";
        pending.push({
          row: {
            ...base,
            kind: comment ? "comment" : a.refKind,
            target_kind: comment ? a.refKind : null,
            host: item.host,
            project: item.project,
            number: item.number,
            sha: a.sha && SHA.test(a.sha) ? a.sha : null,
            branch: a.branch ?? null,
            observed_state: comment ? null : state,
            title: comment ? null : title,
            url: a.url ?? null,
          },
          spelling: item.spelling,
          keyKind: a.refKind,
        });
        continue;
      }

      if (a.refKind === "commit") {
        // A pasted commit URL names its own repo; a git commit is the session's project's.
        let host: string | null = null;
        let proj: string | null = null;
        if (a.source === "paste" && a.url) {
          try {
            const u = new URL(a.url);
            const segs = u.pathname.split("/").filter((s) => s && s !== "-");
            const at = segs.findIndex((s) => /^commits?$/i.test(s));
            if (at >= 2) {
              host = normalizeHost(u.host);
              proj = segs.slice(0, at).join("/").toLowerCase();
            }
          } catch {
            // not a URL: no repo
          }
        } else if (!a.repoUnknown && project) {
          host = project.host;
          proj = project.project;
        }
        if (a.repoUnknown && a.source !== "paste") continue;
        const sha = a.sha && SHA.test(a.sha) ? a.sha : null;
        if (sha) {
          pending.push({
            row: {
              ...base,
              kind: "commit",
              target_kind: null,
              host,
              project: proj,
              number: null,
              sha,
              branch: a.branch ?? null,
              observed_state: null,
              title: null,
              url: a.url ?? null,
            },
            spelling: `${host ? `${host}/` : ""}${proj ?? ""}@${sha}`,
            keyKind: "commit",
          });
        }
        // §2: one item row per ref the commit's own subject names, carrying its sha (commit→item edge).
        if (a.verb === "committed" && !a.repoUnknown) {
          for (const ref of commitSubjectRefs(a.subject, forgeProject !== null)) {
            const item = itemRow(ref, "issue", {}, { forgeProject, qualifyHostless, evidence: null });
            if (!item) continue;
            pending.push({
              row: {
                ...base,
                kind: "issue",
                target_kind: null,
                host: item.host,
                project: item.project,
                number: item.number,
                sha,
                branch: null,
                observed_state: null,
                title: null,
                url: null,
              },
              spelling: item.spelling,
              keyKind: "issue",
              subject: true,
            });
          }
        }
        continue;
      }

      // A checkout/switch/worktree name is a branch only when the parser confirmed it (a create flag, or
      // git's `Switched to` line); a plain `git checkout <path|sha>` and actions stored before the flag
      // existed write no row. Push and delete rows are branches by construction.
      if (a.verb === "navigated" && !a.branchConfirmed) continue;
      if (a.refKind === "branch" && a.ref && !a.repoUnknown) {
        const name = a.branch ?? a.ref;
        pending.push({
          row: {
            ...base,
            kind: "branch",
            target_kind: null,
            host: project?.host ?? null,
            project: project?.project ?? null,
            number: null,
            sha: null,
            branch: name,
            observed_state: null,
            title: null,
            url: null,
          },
          spelling: `${project ? `${project.host}/${project.project}` : ""}@${name}`,
          keyKind: "branch",
        });
      }
    }
  }

  // §2 GitHub kind fold: a subject ref takes the one kind another (non-prose) action observed for
  // that GitHub item; with none (or both) it stays a kind-less `issue` row keyed by githubItemKey.
  const observedKinds = new Map<string, Set<string>>();
  for (const p of pending) {
    if (p.subject || p.row.prose_ref || (p.keyKind !== "issue" && p.keyKind !== "merge_request")) continue;
    const gh = githubItemKey(p.spelling);
    if (!gh) continue;
    const set = observedKinds.get(gh) ?? new Set<string>();
    set.add(p.keyKind);
    observedKinds.set(gh, set);
  }
  const githubKeyed = new Map<Pending, string>();
  for (const p of pending) {
    if (!p.subject) continue;
    const gh = githubItemKey(p.spelling);
    if (!gh) continue;
    const kinds = observedKinds.get(gh);
    if (kinds && kinds.size === 1) {
      const kind = [...kinds][0] as ItemKind;
      p.row.kind = kind;
      p.keyKind = kind;
    } else githubKeyed.set(p, gh);
  }

  // Deferred (not this build): Today/Issues still call itemKeyResolver without projectIdentities.
  const keyOf = itemKeyResolver(
    pending.map((p) => ({ ref: p.spelling, kind: p.keyKind })),
    { projectIdentities: identities },
  );
  const seen = new Set<string>();
  const rows: ForgeRefRow[] = [];
  for (const p of pending) {
    const item_key = storedItemKey(githubKeyed.get(p) ?? keyOf(p.spelling, p.keyKind));
    const unique = `${p.row.turn_idx}\u0000${p.row.action_ix}\u0000${p.row.kind}\u0000${item_key}`;
    if (seen.has(unique)) continue;
    seen.add(unique);
    rows.push({ ...p.row, item_key });
  }
  return rows;
}

/**
 * An item ref qualified as §3's write path says: a bare `#N` to the session's forge project (never
 * for a `repoUnknown` action — dropped), a host-less `owner/repo#N` to the host of its own URL, else
 * by `hostlessRefQualifier` over the user's projects. Null when it is not ref syntax.
 */
function itemRow(
  rawRef: string,
  kind: string,
  a: Partial<RawAction>,
  ctx: {
    forgeProject: string | null;
    qualifyHostless: (ref: string, evidence?: string | null) => string;
    evidence: string | null;
  },
): { spelling: string; host: string | null; project: string | null; number: number } | null {
  const m = MARKED.exec(rawRef.trim());
  if (!m) return null;
  const prefix = m[1].replace(/\/+$/, "");
  const ownRepo = prefix.includes("/");
  if (a.repoUnknown && !ownRepo) return null;
  let ref = rawRef.trim();
  if (ownRepo && !HOSTLIKE.test(prefix.split("/")[0])) {
    const host = urlHost(a.url, prefix);
    ref = host ? `${host}/${ref}` : ctx.qualifyHostless(ref, ctx.evidence);
  }
  const itemKind: ItemKind = kind === "merge_request" ? "merge_request" : "issue";
  // Only a bare `#N` takes the session's project; an `owner/repo` spelling got its host above or
  // stays host-less (canonicalItemRef would also qualify it when it names this project's repo — a
  // guess when the repo is mirrored on two forges, §3 "must not bind").
  const c = canonicalItemRef(ref, a.repoUnknown || ownRepo ? null : ctx.forgeProject, itemKind);
  if (!c) {
    // A bare `#N` with no forge project: observed, but no repo to qualify it to.
    const n = Number(m[3]);
    if (prefix || !Number.isSafeInteger(n) || n <= 0 || n > MAX_INT) return null;
    return { spelling: `${m[2]}${m[3]}`, host: null, project: null, number: n };
  }
  if (c.number > MAX_INT) return null;
  const path = c.ref.slice(0, c.ref.lastIndexOf("#"));
  const hosted = hostedPath(path);
  return {
    spelling: c.ref,
    host: hosted?.host ?? null,
    project: (hosted?.project ?? path.toLowerCase()) || null,
    number: c.number,
  };
}

/**
 * §5: the importer's fill, computed before the turns RPC so its rows land in that transaction.
 * Reads the user's project identities (explicit `user_id` filter). Any failure gives null: the RPC
 * then writes the turns, removes the session's ref rows and clears `forge_refs_version`, so the
 * turns never fail on this and the backfill sees the gap.
 */
export async function forgeRefsForImport(
  supabase: Db,
  userId: string,
  input: { projectIdentity: string; startedAt: string; turns: readonly ForgeRefTurn[] },
): Promise<ForgeRefRow[] | null> {
  try {
    const identities = await userProjectIdentities(supabase, userId);
    return computeForgeRefs(input.turns, {
      projectIdentity: input.projectIdentity,
      projectIdentities: [input.projectIdentity, ...identities],
      startedAt: input.startedAt,
    });
  } catch (err) {
    log.warn("forge refs fill failed", { user_id: userId, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/** Every `repo_identity` of the user's projects. */
export async function userProjectIdentities(supabase: Db, userId: string): Promise<string[]> {
  const res = await supabase.from("code_projects").select("repo_identity").eq("user_id", userId);
  if (res.error) throw new Error(`userProjectIdentities failed: ${res.error.message}`);
  return ((res.data ?? []) as Array<{ repo_identity: string | null }>)
    .map((p) => p.repo_identity)
    .filter((x): x is string => typeof x === "string" && x.length > 0);
}

/** PostgREST caps a response at 1000 rows; turns are read in pages of this size. */
export const TURN_PAGE_SIZE = 500;

/**
 * §5 backfill: every turn of one session (explicit `user_id` filter), paged in idx order until a
 * short page, plus the md5 of their ids in that order — what `replace_code_session_forge_refs`
 * compares under the session lock to refuse a write computed from turns since replaced.
 */
export async function loadRefTurns(
  supabase: Db,
  userId: string,
  sessionId: string,
  pageSize = TURN_PAGE_SIZE,
): Promise<{ turns: ForgeRefTurn[]; turnIdsMd5: string }> {
  const turns: Array<ForgeRefTurn & { id: string }> = [];
  for (let from = 0; ; from += pageSize) {
    const res = await supabase
      .from("code_session_turns")
      .select("id, idx, ts, tool_name, props")
      .eq("user_id", userId)
      .eq("session_id", sessionId)
      .order("idx", { ascending: true })
      .range(from, from + pageSize - 1);
    if (res.error) throw new Error(`loadRefTurns(${sessionId}) failed: ${res.error.message}`);
    const page = (res.data ?? []) as Array<ForgeRefTurn & { id: string }>;
    turns.push(...page);
    if (page.length < pageSize) break;
  }
  const turnIdsMd5 = createHash("md5")
    .update(turns.map((t) => t.id).join(","))
    .digest("hex");
  return { turns, turnIdsMd5 };
}

export interface RefillSession {
  id: string;
  user_id: string;
  started_at: string;
  content_hash: string;
  projectIdentity: string | null;
}

/**
 * §5 backfill, one session: load its turns, compute its rows, and (unless `dryRun`) write them
 * through the refs-only RPC with the hash guard. `skipped`: an import is in flight or replaced the
 * turns since they were read — the next run picks the session up again if it still needs it.
 */
export async function refillSessionForgeRefs(
  supabase: Db,
  s: RefillSession,
  identities: readonly string[],
  opts: { dryRun?: boolean; pageSize?: number } = {},
): Promise<{ status: "written" | "skipped" | "dry_run"; rows: number }> {
  if (s.content_hash === "") return { status: "skipped", rows: 0 };
  const { turns, turnIdsMd5 } = await loadRefTurns(supabase, s.user_id, s.id, opts.pageSize);
  const rows = computeForgeRefs(turns, {
    projectIdentity: s.projectIdentity,
    projectIdentities: s.projectIdentity ? [s.projectIdentity, ...identities] : identities,
    startedAt: s.started_at,
  });
  if (opts.dryRun) return { status: "dry_run", rows: rows.length };
  const res = await supabase.rpc("replace_code_session_forge_refs", {
    p_user_id: s.user_id,
    p_session_id: s.id,
    p_forge_refs: rows,
    p_forge_refs_version: FORGE_REFS_VERSION,
    p_expected_content_hash: s.content_hash,
    p_expected_turn_ids_md5: turnIdsMd5,
  });
  if (res.error) throw new Error(`replace_code_session_forge_refs(${s.id}) failed: ${res.error.message}`);
  return res.data === -1 ? { status: "skipped", rows: 0 } : { status: "written", rows: rows.length };
}
