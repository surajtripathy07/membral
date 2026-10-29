// Code session importer (ADR 0021 Q1/Q2/Q4, P1a).
//
// ISOLATION (Q2, the make-or-break invariant): this module writes ONLY to
// code_projects / code_sessions / code_session_turns. It never imports
// GraphWriter and never touches kg_nodes/kg_edges — see code-isolation.test.ts
// for the static gate + the byte-identical isolation proof. Cross-links into
// the chat graph (code_cross_links) are P1c's job, not this module's.
//
// No LLM calls happen here (P1a scope) — summary/rollup columns are left
// NULL; per-session and per-CodeProject synthesis is P1c (ADR Q5).
import { needsParserRefresh, sessionTurnCount } from "@membral/core";
import type { Db } from "@/lib/db/types";
import { log } from "@/lib/log";
import { verifyAgentResolutions } from "@/lib/memory/agent-resolve";
import { reconcileRecallInfluence } from "@/lib/memory/influence";
import { ensureSessionRawUnits, type RawUnitsOptions, rawUnitsEnabled } from "@/lib/memory/raw-units";
import { FORGE_REFS_VERSION, type ForgeRefRow, forgeRefsForImport } from "./forge-refs";
import type { RawCodeSessionPayload } from "./payload";
import { sanitizePgDeep } from "./pg-text";
import { buildProfile } from "./profile";
import { patchCodeSessionProps } from "./props-patch";
import { normalizeRepoIdentity, sanitizeRemoteUrl, UNASSIGNED_REPO_IDENTITY } from "./repo-identity";
import { firstLineTitle, titleSourceText } from "./view";

export type ImportStatus = "imported" | "skipped" | "error";

export interface ImportResult {
  status: ImportStatus;
  sessionId?: string;
  codeProjectId?: string;
  error?: string;
}

interface ExistingSessionRow {
  id: string;
  content_hash: string;
  code_project_id: string;
  turn_count: number | null;
  props: Record<string, unknown> | null;
}

interface ExistingProjectRow {
  id: string;
  last_active_at: string | null;
  props: Record<string, unknown> | null;
}

/**
 * Sentinel written to content_hash while a session row's turns are being
 * replaced (issue #91 adversarial review M4). `content_hash` is `not null`
 * (migration 029) so a true NULL isn't possible — this is the "nulled"
 * equivalent the fix calls for: never a value a real payload could produce
 * (the parser always emits a non-empty SHA-256 hex digest), so it can never
 * spuriously equal `session.contentHash` and trip the short-circuit above.
 */
const PENDING_CONTENT_HASH = "";

/**
 * Import (or idempotently skip) one RawCodeSession payload for `userId`.
 *
 * Idempotency (ADR Q1): upserts on (user_id, source, source_session_id); when
 * an existing row's content_hash matches the payload's contentHash exactly,
 * this is a cheap no-op — `{status: "skipped"}` — WITHOUT touching turns or
 * the owning code_projects row. Otherwise the session row is
 * inserted/updated and its turns are replaced wholesale (delete + re-insert
 * for that session_id only — every other session's turns are untouched).
 *
 * WRITE ORDER (issue #91 adversarial review M4): the session row is written
 * with content_hash held at PENDING_CONTENT_HASH — NOT `session.contentHash`
 * — until AFTER replaceTurns succeeds; only then does finalizeContentHash
 * set the real hash. The pre-fix order wrote the real content_hash BEFORE
 * replaceTurns, so a crash between those two steps stranded a session row
 * with the NEW hash but stale/missing turns — the short-circuit above would
 * then see "content_hash already matches" on every future run and skip
 * re-importing it forever, silently losing that session's turns for good.
 * With the hash held pending, an interrupted import always looks
 * "unfinished" to the next run (the short-circuit's equality check fails)
 * and retries the whole thing from scratch — self-healing. (replaceTurns
 * itself is atomic since migration 112, so the retry window shows the
 * previous complete turn set, never an empty or partial one.)
 *
 * `force` (issue #91 backfill): when true, skips the content_hash
 * short-circuit entirely and always re-imports — used to backfill
 * code_sessions.props.usage on rows imported before ADR 0026 D3/D4 landed
 * (their content_hash is unchanged, so a plain re-sweep would keep
 * short-circuiting on them forever). Still idempotent either way: the
 * insert/update + wholesale replaceTurns below are safe to run repeatedly.
 */
export async function importCodeSession(
  supabase: Db,
  userId: string,
  rawSession: RawCodeSessionPayload,
  force = false,
  importOpts: ImportOptions = {},
): Promise<ImportResult> {
  try {
    // Every string bound for code_sessions / code_session_turns (text,
    // tool_name, file_path, props, repo, ids) loses U+0000 and lone
    // surrogates, which Postgres rejects ("unsupported Unicode escape
    // sequence"). contentHash stays the CLIENT's value, computed on the
    // original transcript, so dedup is unchanged.
    const session: RawCodeSessionPayload = { ...sanitizePgDeep(rawSession), contentHash: rawSession.contentHash };
    const existing = await findExistingSession(supabase, userId, session.source, session.sourceSessionId);

    // Issue #171: a byte-identical transcript keeps its content_hash, so a
    // session re-sent because /known saw an older stored actions_version must
    // not short-circuit here, or the new parser output would never land. The
    // re-import writes props.actions_version (buildSessionProps), so the next
    // /known check answers "known" and it does not loop.
    const staleParser = needsParserRefresh(existing?.props?.actions_version, session.actionsVersion);
    // An open (Stop-hook) upload stamps props.open_upload; a later non-open upload of identical content (SessionEnd,
    // sweep) must NOT short-circuit, or the session would never be queued for extraction (the route queues only
    // "imported" sessions). It re-imports once, which clears the stamp.
    const open = importOpts.open === true;
    const wasOpen = existing?.props?.open_upload === true;
    // Out-of-order guard: a delayed OPEN upload carrying fewer turns than what is stored (a slow Stop child
    // overtaken by a later one, or by the closing upload) must not replace the newer turns or stamp the row open.
    // The same holds for a delayed NON-open upload (a slow SessionEnd or sweep child) when the stored row is open: it
    // must not replace the newer turns of a later open upload, nor clear the stamp over them.
    const incomingTurns = sessionTurnCount(session);
    const behindStored =
      existing?.turn_count != null &&
      (open
        ? wasOpen
          ? incomingTurns < existing.turn_count
          : incomingTurns <= existing.turn_count
        : wasOpen && !force && incomingTurns < existing.turn_count);
    if (existing && behindStored) {
      return { status: "skipped", sessionId: existing.id, codeProjectId: existing.code_project_id };
    }
    if (existing && existing.content_hash === session.contentHash && !force && !staleParser && !(wasOpen && !open)) {
      // A crash after the turns were stored and before the units were written leaves a final content_hash and stale
      // units: heal them here (units are tested by source_hash, not content_hash). Never fails the import.
      await writeRawUnits(supabase, userId, existing.id, session.turns, session.contentHash, importOpts);
      return { status: "skipped", sessionId: existing.id, codeProjectId: existing.code_project_id };
    }

    const repoIdentity = normalizeRepoIdentity(session.repo);
    const codeProjectId = await upsertCodeProject(supabase, userId, repoIdentity, session);

    const sessionId = await upsertCodeSessionRow(supabase, userId, codeProjectId, session, existing, open, wasOpen);

    // W3 D9: the session's observed forge refs, written in the turns RPC's transaction (null on failure).
    const forgeRefs = await forgeRefsForImport(supabase, userId, {
      projectIdentity: repoIdentity,
      startedAt: session.startedAt,
      turns: session.turns.map((t) => ({
        idx: t.idx,
        ts: t.ts,
        tool_name: t.toolName ?? null,
        props: buildTurnProps(t),
      })),
    });
    await replaceTurns(supabase, userId, sessionId, session.turns, forgeRefs);

    await finalizeContentHash(supabase, userId, sessionId, session.contentHash);

    await bumpCodeProject(supabase, userId, codeProjectId, session.endedAt);

    // I33 raw units (docs/design/i33-port.md PR 2): after the turns are stored. Never fails the import.
    await writeRawUnits(supabase, userId, sessionId, session.turns, session.contentHash, importOpts);

    // #361: mark recall events served into this session as influenced (or
    // not), once the import is final (turns in, content hash and project
    // bumped). Metrics only: never fails the import.
    try {
      await reconcileRecallInfluence(
        supabase,
        userId,
        sessionId,
        session.turns.map((t) => ({
          idx: t.idx,
          role: t.role,
          kind: t.kind,
          text: t.text ?? null,
          tool_name: t.toolName ?? null,
          file_path: t.filePath ?? null,
          ts: t.ts,
        })),
      );
    } catch (err) {
      log.warn("recall influence reconciliation failed", {
        user_id: userId,
        session_id: sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // #436: receipts for memory_resolve calls this session made, on every
    // upload (not behind the extraction queue's budget or off-switch). It only
    // adds receipts and never throws; the catch is belt and braces.
    try {
      await verifyAgentResolutions(supabase, userId, sessionId);
    } catch (err) {
      log.warn("memory_resolve verification failed", {
        user_id: userId,
        session_id: sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Memory v1 §8.2/§8.7 tail capture (docs/design/memory-v1.md §3 "C — the
    // server's answer to a check-in that never fired") is triggered by the
    // CALLER, not here — step2d finding 3 (docs/goals/
    // 2026-09-13_memory-v1-build_goal.md; issue #151; driver follow-up
    // 2026-09-13): the HTTP route (app/api/code-sessions/route.ts) batches
    // every session in one POST request through ONE shared cost-guarded
    // LlmClient (memory/tail-capture.ts's `runTailCaptureForUploadBatch`)
    // after its own import loop finishes, so the run-wide cost cap spans
    // the whole batch instead of resetting per session. This function used
    // to fire it per session itself; now it only reports "imported" and
    // lets the caller decide when/how to batch the extraction trigger.
    return { status: "imported", sessionId, codeProjectId };
  } catch (err) {
    return { status: "error", error: err instanceof Error ? err.message : String(err) };
  }
}

/** Options of importCodeSession beyond the payload. */
export interface ImportOptions {
  /** Raw-unit writing: `enabled` overrides rawUnitsEnabled() (local runs only); the rest goes to ensureSessionRawUnits. */
  rawUnits?: RawUnitsOptions & { enabled?: boolean };
  /**
   * Schedules the unit work off the caller's path (the import route queues it behind enqueueRawUnitTask inside next/server's after(), so embedding never
   * runs inside the HTTP response). Omitted = the work is awaited inline (tests, scripts).
   */
  deferRawUnits?: (task: () => Promise<void>, sessionId: string) => void;
  /** The upload is from a still-open session (Stop hook): stamps props.open_upload; see the short-circuit above. */
  open?: boolean;
}

/**
 * Writes the session's raw units (embeddings first, then one transaction) when enabled. ensureSessionRawUnits never
 * throws; the catch is belt and braces so a unit failure can never fail an import whose turns are already stored.
 */
function writeRawUnits(
  supabase: Db,
  userId: string,
  sessionId: string,
  turns: RawCodeSessionPayload["turns"],
  contentHash: string,
  importOpts: ImportOptions,
): Promise<void> | void {
  const { enabled, ...unitOpts } = importOpts.rawUnits ?? {};
  if (!(enabled ?? rawUnitsEnabled())) return;
  const task = async () => {
    try {
      await ensureSessionRawUnits(supabase, userId, sessionId, turns, { contentHash, ...unitOpts });
    } catch (err) {
      log.warn("raw units failed", {
        user_id: userId,
        session_id: sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
  if (importOpts.deferRawUnits) {
    try {
      importOpts.deferRawUnits(task, sessionId);
    } catch (err) {
      log.warn("raw units could not be scheduled", { session_id: sessionId, error: String(err) });
    }
    return;
  }
  return task();
}

async function findExistingSession(
  supabase: Db,
  userId: string,
  source: string,
  sourceSessionId: string,
): Promise<ExistingSessionRow | null> {
  const res = await supabase
    .from("code_sessions")
    .select("id, content_hash, code_project_id, turn_count, props")
    .eq("user_id", userId)
    .eq("source", source)
    .eq("source_session_id", sourceSessionId)
    .maybeSingle();
  if (res.error) throw new Error(`findExistingSession failed: ${res.error.message}`);
  return (res.data as ExistingSessionRow | null) ?? null;
}

async function upsertCodeProject(
  supabase: Db,
  userId: string,
  repoIdentity: string,
  session: RawCodeSessionPayload,
): Promise<string> {
  const found = await supabase
    .from("code_projects")
    .select("id")
    .eq("user_id", userId)
    .eq("repo_identity", repoIdentity)
    .maybeSingle();
  if (found.error) throw new Error(`upsertCodeProject(select) failed: ${found.error.message}`);
  if (found.data) return (found.data as { id: string }).id;

  const insertRes = await supabase
    .from("code_projects")
    .insert({
      user_id: userId,
      repo_identity: repoIdentity,
      repo_path: session.repo.path ?? null,
      remote_url: sanitizeRemoteUrl(session.repo.remoteUrl),
      display_name: deriveDisplayName(repoIdentity, session.repo),
      source: session.source,
      props: {},
      session_count: 0,
    })
    .select("id")
    .single();
  if (insertRes.error) throw new Error(`upsertCodeProject(insert) failed: ${insertRes.error.message}`);
  return (insertRes.data as { id: string }).id;
}

function deriveDisplayName(repoIdentity: string, repo: RawCodeSessionPayload["repo"]): string {
  if (repoIdentity === UNASSIGNED_REPO_IDENTITY) return "Unassigned";
  const segments = repoIdentity.split("/");
  if (segments.length >= 3) {
    // host/owner/repo -> "owner/repo"
    return segments.slice(-2).join("/");
  }
  // path-derived identity: last path segment, else the full path.
  const base = repo?.path?.split(/[\\/]/).filter(Boolean).pop();
  return base || repoIdentity;
}

/**
 * C-9: a session outside any git remote (a scratch dir, notes) has no branch
 * or project name worth titling it by — five of them all read
 * "<dir> · HEAD · <date>". Its title is the first line of its first real
 * user prompt (view.ts's firstLineTitle, the same fallback 320ce52 uses at
 * read time), so the mirror and every list show what the session was about.
 * A git-remote session keeps a null title (synthesis/summary decide). Pure.
 */
export function nonGitSessionTitle(session: Pick<RawCodeSessionPayload, "repo" | "turns">): string | null {
  if (session.repo.remoteUrl) return null;
  // UX W6 (review 3b): the owner's own words only — a prompt that was only a
  // paste is skipped, and a paste span inside one never becomes the title.
  for (const t of session.turns) {
    if (t.role !== "user" || t.kind !== "prose" || !t.text?.trim()) continue;
    const title = firstLineTitle(titleSourceText(t.text, t.ownerText ?? null));
    if (title) return title;
  }
  return null;
}

async function upsertCodeSessionRow(
  supabase: Db,
  userId: string,
  codeProjectId: string,
  session: RawCodeSessionPayload,
  existing: ExistingSessionRow | null,
  open = false,
  wasOpen = false,
): Promise<string> {
  // Only genuine human prose counts as a "user turn" — tool_result rows also
  // arrive on role:"user" lines in CC transcripts, and counting them would
  // report tool-heavy agent sessions as hundreds of "your" turns.
  const userTurnCount = session.turns.filter((t) => t.role === "user" && t.kind === "prose").length;
  const toolCount = Object.values(session.toolCounts).reduce((sum, n) => sum + n, 0);

  const row = {
    user_id: userId,
    code_project_id: codeProjectId,
    source: session.source,
    source_session_id: session.sourceSessionId,
    // PENDING, not session.contentHash — see importCodeSession's WRITE ORDER
    // doc comment (issue #91 adversarial review M4). finalizeContentHash sets
    // the real value once replaceTurns has actually succeeded.
    content_hash: PENDING_CONTENT_HASH,
    cwd: session.repo.path ?? null,
    git_branch: session.repo.branch ?? null,
    model: session.model ?? null,
    started_at: session.startedAt,
    ended_at: session.endedAt,
    duration_seconds: computeDurationSeconds(session.startedAt, session.endedAt),
    // Shared with the CLI's /known probe (@membral/core sessions/known.ts)
    // so "already uploaded" compares the exact value stored here.
    turn_count: sessionTurnCount(session),
    user_turn_count: userTurnCount,
    tool_count: toolCount,
    files_touched: session.filesTouched,
    // Migration 089: a sub-agent's own session points at its parent's
    // SOURCE session id (no FK — the child may land before the parent).
    parent_source_session_id: session.parentSessionId ?? null,
    // No LLM calls in this phase (P1a): summary stays NULL — the CLI does
    // not send a title, and per-session synthesis is P1c (ADR Q5). A non-git
    // session is titled by its first prompt line (C-9, nonGitSessionTitle).
    title: nonGitSessionTitle(session),
    summary: null,
    // ADR 0026 D3/D4 — parser-level run-metadata (usage/models/subAgents),
    // all optional (D13: source-optional).
    //
    // step2d finding 1 (docs/goals/2026-09-13_memory-v1-build_goal.md; issue
    // #151): this USED to be a full replace (`buildSessionProps(session)`
    // alone) on the stale premise that "nothing else writes
    // code_sessions.props" — false since memory v1 source C
    // (memory/write/io.ts's `updateSessionMemoryProps`) started writing
    // `memory_extraction`/`memory_checkpoint_turn_idx`/
    // `memory_extraction_lock` there too. A full replace on re-import wiped
    // those on every re-upload of a live session, making tail capture
    // re-extract the whole session (on Membral's own key) every time.
    // On an existing row the import overlays only what it knows
    // (usage/models/subAgents/…) with a key-level patch (migration 109), never
    // a whole-props write from `existing.props`: memory extraction writes its
    // `memory_*` keys concurrently, and a stale snapshot would revert them.
    props: {
      ...buildSessionProps(session),
      // Stamp while open; clear only when it was set, so ordinary sessions never gain the key.
      ...(open ? { open_upload: true } : wasOpen ? { open_upload: false } : {}),
    },
  };

  if (existing) {
    const { props: importProps, ...columns } = row;
    const updateRes = await supabase.from("code_sessions").update(columns).eq("id", existing.id);
    if (updateRes.error) throw new Error(`upsertCodeSessionRow(update) failed: ${updateRes.error.message}`);
    await patchCodeSessionProps(supabase, userId, existing.id, importProps);
    return existing.id;
  }

  const insertRes = await supabase.from("code_sessions").insert(row).select("id").single();
  if (insertRes.error) throw new Error(`upsertCodeSessionRow(insert) failed: ${insertRes.error.message}`);
  return (insertRes.data as { id: string }).id;
}

/**
 * Sets the REAL content_hash on a session row, called only after replaceTurns
 * has succeeded (issue #91 adversarial review M4 — see importCodeSession's
 * WRITE ORDER doc comment). If this throws, the row is left at
 * PENDING_CONTENT_HASH, which never matches a real payload's contentHash —
 * the next run's short-circuit check correctly treats the session as not yet
 * (successfully) imported and retries the whole import, including turns.
 *
 * Scoped by user_id AND id (issue #91 adversarial review m-scope) — belt and
 * suspenders: `sessionId` here always originates from a user_id-scoped read
 * or insert (findExistingSession's select, or upsertCodeSessionRow's own
 * insert with user_id: userId in the row), so this can never actually cross
 * users in practice, but pinning it explicitly costs nothing on a
 * service-role client and removes any dependence on that invariant holding
 * upstream.
 */
async function finalizeContentHash(
  supabase: Db,
  userId: string,
  sessionId: string,
  contentHash: string,
): Promise<void> {
  const updateRes = await supabase
    .from("code_sessions")
    .update({ content_hash: contentHash })
    .eq("id", sessionId)
    .eq("user_id", userId);
  if (updateRes.error) throw new Error(`finalizeContentHash failed: ${updateRes.error.message}`);
}

/** ADR 0026 D3/D4 — carries usage/models/subAgents through to code_sessions.props when the parser supplied them; omits keys it didn't (D13). */
function buildSessionProps(session: RawCodeSessionPayload): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  if (session.usage) props.usage = session.usage;
  if (session.models && session.models.length > 0) props.models = session.models;
  if (session.subAgents && session.subAgents.length > 0) props.subAgents = session.subAgents;
  if (session.subAgent) props.subAgent = session.subAgent;
  if (session.actionsVersion !== undefined) props.actions_version = session.actionsVersion;
  if (session.hookOutcomes) props.hook_outcomes = session.hookOutcomes;
  // Goal 2026-09-26 W4 (P2, D-051) — the session's observed profile: per-ref
  // ladders, tier and turn share folded from the turns' actions (B3/B14/B15).
  // Built from this session's own turns; a sub-agent child imports as its own
  // session and is folded into the parent at read time (B16), since the
  // children of a parent are not in hand when the parent is imported.
  props.profile = buildProfile(
    session.turns.map((t) => ({
      idx: t.idx,
      role: t.role,
      kind: t.kind,
      tool_name: t.toolName ?? null,
      file_path: t.filePath ?? null,
      props: { toolUseId: t.toolUseId, action: t.action, actions: t.actions },
    })),
  );
  return props;
}

function computeDurationSeconds(startedAt: string, endedAt: string): number | null {
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return null;
  return Math.round((end - start) / 1000);
}

/**
 * Replace ALL turns for `sessionId` with `turns` in one database transaction
 * (migration 112, `import_code_session_turns`; 115's overload also replaces
 * the session's `code_session_forge_refs` rows): the function checks the
 * session is this user's, deletes its turns and inserts the new set, so a
 * failure leaves the previous turns in place instead of none or a partial set.
 * `user_id`/`session_id` come only from the arguments, never from the rows.
 */
async function replaceTurns(
  supabase: Db,
  userId: string,
  sessionId: string,
  turns: RawCodeSessionPayload["turns"],
  forgeRefs: ForgeRefRow[] | null,
): Promise<void> {
  const rows = turns.map((t) => ({
    idx: t.idx,
    role: t.role,
    kind: t.kind,
    text: t.text ?? null,
    tool_name: t.toolName ?? null,
    file_path: t.filePath ?? null,
    ts: t.ts,
    props: buildTurnProps(t),
  }));
  const { data, error } = await supabase.rpc("import_code_session_turns", {
    p_user_id: userId,
    p_session_id: sessionId,
    p_turns: rows,
    // Migration 115's overload: the session's ref rows in the same transaction (null clears them).
    p_forge_refs: forgeRefs,
    p_forge_refs_version: FORGE_REFS_VERSION,
  });
  if (error) throw new Error(`replaceTurns failed: ${error.message}`);
  if (data !== turns.length) {
    throw new Error(`replaceTurns failed: inserted ${String(data)} of ${turns.length} turns`);
  }
}

/** ADR 0026 D1/D2/D10 — per-turn structured extras (tool_use rows only), all optional (D13). */
function buildTurnProps(t: RawCodeSessionPayload["turns"][number]): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  if (t.toolUseId) props.toolUseId = t.toolUseId;
  if (t.resultType) props.resultType = t.resultType; // D1
  if (t.editHunks !== undefined) props.editHunks = t.editHunks; // D1
  if (t.mcpServer) props.mcpServer = t.mcpServer; // D2
  if (t.mcpTool) props.mcpTool = t.mcpTool; // D2
  if (t.inputDigest) props.inputDigest = t.inputDigest; // D10
  // Goal 2026-09-26 W3 — the observed forge action(s) of this turn, verbatim
  // from the parser (already fixed-shape, redacted, capped); the turn text
  // stays the elided sentinel.
  if (t.action) props.action = t.action;
  if (t.actions && t.actions.length > 0) props.actions = t.actions;
  // e2e S2: text the owner did not write (compaction summary, shell output) — never their words.
  if (t.nonOwner) props.nonOwner = t.nonOwner;
  // Pasted spans removed: the only text of this turn that is the owner's own words.
  if (t.ownerText !== undefined) props.ownerText = t.ownerText;
  return props;
}

/**
 * Bump code_projects.session_count (recomputed by live count — never a
 * blind increment, so repeated imports of the same session never drift it),
 * last_active_at (max of existing vs. this session's endedAt), and flip
 * props.portrait_dirty=true so P1c's rollup regenerates.
 */
async function bumpCodeProject(
  supabase: Db,
  userId: string,
  codeProjectId: string,
  sessionEndedAt: string,
): Promise<void> {
  const countRes = await supabase
    .from("code_sessions")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("code_project_id", codeProjectId)
    // Sub-agent sessions (migration 089) are not counted as the project's sessions.
    .is("parent_source_session_id", null);
  if (countRes.error) throw new Error(`bumpCodeProject(count) failed: ${countRes.error.message}`);
  const sessionCount = countRes.count ?? 0;

  const projectRes = await supabase
    .from("code_projects")
    .select("last_active_at, props")
    .eq("id", codeProjectId)
    .maybeSingle();
  if (projectRes.error) throw new Error(`bumpCodeProject(select) failed: ${projectRes.error.message}`);
  const project = projectRes.data as ExistingProjectRow | null;

  const prevActive = project?.last_active_at ? Date.parse(project.last_active_at) : Number.NEGATIVE_INFINITY;
  const nextActive = Date.parse(sessionEndedAt);
  const lastActiveAt =
    !Number.isNaN(nextActive) && nextActive > prevActive ? sessionEndedAt : (project?.last_active_at ?? sessionEndedAt);

  const updateRes = await supabase
    .from("code_projects")
    .update({
      session_count: sessionCount,
      last_active_at: lastActiveAt,
      props: { ...(project?.props ?? {}), portrait_dirty: true },
      updated_at: new Date().toISOString(),
    })
    .eq("id", codeProjectId);
  if (updateRes.error) throw new Error(`bumpCodeProject(update) failed: ${updateRes.error.message}`);
}
