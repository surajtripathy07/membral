// Fake handlers for the SQL functions (RPCs) behind the remaining MCP tools
// (G0 step 0.4b). Each one re-implements its function's live migration body
// over the fake's seed rows, returning what PostgREST would hand back:
//   - `returns jsonb` values have their object keys in jsonb storage order
//     (shorter key first, then bytewise) at every depth, since Postgres
//     re-sorts keys of jsonb_build_object / to_jsonb / jsonb columns alike;
//   - timestamptz columns rendered by to_jsonb / jsonb_build_object use
//     Postgres' JSON form ("2025-12-22T10:05:00+00:00", UTC session zone).
// Graph-backed functions (kg_* tables) are modelled only for a user with no
// kg_* rows, where every graph CTE is empty; if a seed ever adds kg_* rows the
// handler returns an error instead of guessing a graph walk.
import type { Row, RpcHandler } from "@membral/test-kit";
import { db } from "../boundary";

type Res = ReturnType<RpcHandler>;
const ok = (data: unknown): Res => ({ data: jsonb(data), error: null });

function rows(table: string, userId: unknown): Row[] {
  return (db().tables[table] ?? []).filter((r) => r.user_id === userId);
}

/** Guard for graph-backed functions: faithful only while the user has no kg_* rows. */
function graphEmpty(userId: unknown, fn: string): Res | null {
  const hit = Object.keys(db().tables).find((t) => t.startsWith("kg_") && rows(t, userId).length > 0);
  return hit ? { data: null, error: { message: `golden fake ${fn}: ${hit} rows are not modelled` } } : null;
}

/** jsonb object key order: shorter keys first, then bytewise. */
function jsonbKeyCmp(a: string, b: string): number {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length - bb.length || Buffer.compare(ab, bb);
}

function jsonb(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(jsonb);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort(jsonbKeyCmp)) out[k] = jsonb((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}

/** timestamptz -> Postgres JSON text: seconds precision unless fractional, "+00:00" offset. */
function pgTs(v: unknown): string | null {
  if (v == null) return null;
  const iso = new Date(v as string).toISOString();
  const frac = iso.slice(20, 23).replace(/0+$/, "");
  return `${iso.slice(0, 19)}${frac ? `.${frac}` : ""}+00:00`;
}

const time = (v: unknown): number | null => (v == null ? null : Date.parse(v as string));

/** `order by <ts> desc nulls last, <tie> asc`. */
function descNullsLast<T>(ts: (r: T) => unknown, tie: (r: T) => string) {
  return (a: T, b: T): number => {
    const at = time(ts(a));
    const bt = time(ts(b));
    if (at !== bt) {
      if (at === null) return 1;
      if (bt === null) return -1;
      return bt - at;
    }
    return tie(a) < tie(b) ? -1 : tie(a) > tie(b) ? 1 : 0;
  };
}

const clampLimit = (n: unknown): number => Math.min(Math.max(typeof n === "number" ? n : 30, 1), 100);

/** Rows of `code_projects` visible under an optional project scope (the `scoped` CTE). */
function scopedProjects(userId: unknown, scopeId: unknown): Row[] {
  return rows("code_projects", userId).filter((p) => scopeId == null || p.id === scopeId);
}

const nul = (v: unknown): unknown => v ?? null;

// ILIKE '%q%' with the function's own escaping: a plain case-insensitive substring match.
const ilikeContains = (text: unknown, q: string): boolean =>
  typeof text === "string" && text.toLowerCase().includes(q.toLowerCase());

export const MCP_RPC_HANDLERS: Record<string, RpcHandler> = {
  // 024_api_key_scope.sql: one conversation; a set p_scope_id needs a kg subtree, so with no graph it is null.
  mcp_scoped_conversation: (a) => {
    const guard = graphEmpty(a.p_user_id, "mcp_scoped_conversation");
    if (guard) return guard;
    if (a.p_scope_id != null) return ok(null);
    const c = rows("conversations", a.p_user_id).find((r) => r.id === a.p_conversation_id);
    if (!c) return ok(null);
    return ok({
      id: c.id,
      source: c.source,
      title: nul(c.title),
      created_at: pgTs(c.created_at),
      updated_at: pgTs(c.updated_at),
      model: nul(c.model),
      messages: nul(c.messages),
      metadata: nul(c.metadata),
    });
  },

  // 094_recent_conversations.sql
  mcp_recent_conversations: (a) => {
    const guard = graphEmpty(a.p_user_id, "mcp_recent_conversations");
    if (guard) return guard;
    const limit = clampLimit(a.p_limit);
    const since = time(a.p_since);
    type M = { activity: unknown; id: string; row: Record<string, unknown> };
    const order = descNullsLast<M>(
      (m) => m.activity,
      (m) => m.id,
    );
    // p_scope_id set: allowed_convs comes from the (empty) graph, so no chats and (by predicate) no code rows.
    const chats: M[] =
      a.p_include_chat !== false && a.p_scope_code_project_id == null && a.p_scope_id == null
        ? rows("conversations", a.p_user_id)
            .filter((c) => c.source !== "claude-code")
            .filter((c) => a.p_source == null || c.source === a.p_source)
            .map((c) => ({
              activity: c.updated_at ?? c.created_at,
              id: c.id as string,
              row: {
                type: "chat",
                id: c.id,
                title: nul(c.title),
                source: c.source,
                created_at: pgTs(c.created_at),
                updated_at: pgTs(c.updated_at),
                message_count: Array.isArray(c.messages) ? c.messages.length : 0,
              },
            }))
            .filter((m) => since === null || (time(m.activity) ?? -Infinity) >= since)
            .sort(order)
            .slice(0, limit)
        : [];
    const projects = rows("code_projects", a.p_user_id);
    const scoped = scopedProjects(a.p_user_id, a.p_scope_code_project_id).map((p) => p.id);
    const code: M[] =
      a.p_include_code !== false && a.p_scope_id == null
        ? rows("code_sessions", a.p_user_id)
            .filter((s) => s.parent_source_session_id == null)
            .filter((s) => a.p_scope_code_project_id == null || scoped.includes(s.code_project_id))
            .filter((s) => a.p_source == null || s.source === a.p_source)
            .flatMap((s) => {
              const cp = projects.find((p) => p.id === s.code_project_id);
              if (!cp) return [];
              const summary =
                typeof s.summary === "string" && s.summary.length > 200
                  ? `${s.summary.slice(0, 199)}…`
                  : nul(s.summary);
              return [
                {
                  activity: s.ended_at ?? s.started_at ?? s.created_at,
                  id: s.id as string,
                  row: {
                    type: "code",
                    id: s.id,
                    project_name: cp.display_name ?? cp.repo_identity,
                    git_branch: nul(s.git_branch),
                    source: s.source,
                    started_at: pgTs(s.started_at),
                    ended_at: pgTs(s.ended_at),
                    turn_count: nul(s.turn_count),
                    summary,
                  },
                },
              ];
            })
            .filter((m) => since === null || (time(m.activity) ?? -Infinity) >= since)
            .sort(order)
            .slice(0, limit)
        : [];
    return ok(
      [...chats, ...code]
        .sort(order)
        .slice(0, limit)
        .map((m) => m.row),
    );
  },

  // 030_code_scope_read_rpcs.sql
  code_projects_list: (a) =>
    ok(
      scopedProjects(a.p_user_id, a.p_scope_code_project_id)
        .sort(
          descNullsLast(
            (p) => p.last_active_at,
            (p) => String(p.repo_identity),
          ),
        )
        .map((cp) => ({
          id: cp.id,
          repo_identity: cp.repo_identity,
          display_name: nul(cp.display_name),
          source: cp.source,
          summary: nul(cp.summary),
          session_count: nul(cp.session_count),
          last_active_at: pgTs(cp.last_active_at),
        })),
    ),

  // 089_code_session_parent.sql
  code_project_detail: (a) => {
    const p = scopedProjects(a.p_user_id, a.p_scope_code_project_id).find((r) => r.id === a.p_project_id);
    if (!p) return ok(null);
    const sessions = rows("code_sessions", a.p_user_id)
      .filter((s) => s.code_project_id === p.id && s.parent_source_session_id == null)
      .sort(
        descNullsLast(
          (s) => s.started_at,
          (s) => String(s.id),
        ),
      )
      .slice(0, 50)
      .map((s) => ({
        id: s.id,
        title: nul(s.title),
        summary: nul(s.summary),
        git_branch: nul(s.git_branch),
        model: nul(s.model),
        started_at: pgTs(s.started_at),
        ended_at: pgTs(s.ended_at),
        duration_seconds: nul(s.duration_seconds),
        turn_count: nul(s.turn_count),
        user_turn_count: nul(s.user_turn_count),
        tool_count: nul(s.tool_count),
        files_touched: nul(s.files_touched),
      }));
    return ok({
      id: p.id,
      repo_identity: p.repo_identity,
      display_name: nul(p.display_name),
      repo_path: nul(p.repo_path),
      remote_url: nul(p.remote_url),
      source: p.source,
      summary: nul(p.summary),
      rollup: nul((p.props as Row | null)?.rollup),
      session_count: nul(p.session_count),
      last_active_at: pgTs(p.last_active_at),
      sessions,
    });
  },

  // 096_code_session_sub_agents.sql
  code_session_detail: (a) => {
    const scoped = scopedProjects(a.p_user_id, a.p_scope_code_project_id).map((p) => p.id);
    const inScope = (s: Row) => a.p_scope_code_project_id == null || scoped.includes(s.code_project_id);
    const all = rows("code_sessions", a.p_user_id);
    const s = all.find((r) => r.id === a.p_session_id && inScope(r));
    if (!s) return ok(null);
    const turnsOf = (id: unknown) =>
      rows("code_session_turns", a.p_user_id)
        .filter((t) => t.session_id === id)
        .sort((x, y) => (x.idx as number) - (y.idx as number));
    const children = all
      .filter((c) => c.source === s.source && c.parent_source_session_id === s.source_session_id && inScope(c))
      .sort((x, y) => {
        const xt = time(x.started_at);
        const yt = time(y.started_at);
        if (xt !== yt) return xt === null ? 1 : yt === null ? -1 : xt - yt;
        return String(x.id) < String(y.id) ? -1 : 1;
      });
    const parent = all.find(
      (p) => p.source === s.source && p.source_session_id === s.parent_source_session_id && inScope(p),
    );
    return ok({
      id: s.id,
      code_project_id: s.code_project_id,
      source: s.source,
      cwd: nul(s.cwd),
      git_branch: nul(s.git_branch),
      model: nul(s.model),
      started_at: pgTs(s.started_at),
      ended_at: pgTs(s.ended_at),
      duration_seconds: nul(s.duration_seconds),
      turn_count: nul(s.turn_count),
      user_turn_count: nul(s.user_turn_count),
      tool_count: nul(s.tool_count),
      files_touched: nul(s.files_touched),
      title: nul(s.title),
      summary: nul(s.summary),
      turns: turnsOf(s.id).map((t) => ({
        idx: t.idx,
        role: t.role,
        kind: t.kind,
        text: nul(t.text),
        tool_name: nul(t.tool_name),
        file_path: nul(t.file_path),
        ts: pgTs(t.ts),
      })),
      parent_session_id: parent ? parent.id : null,
      sub_agents_total: children.length,
      sub_agents: children.slice(0, 200).map((c) => {
        const sub = ((c.props as Row | null)?.subAgent ?? null) as Row | null;
        const first = turnsOf(c.id).find((t) => t.role === "user" && t.kind === "prose");
        const text = first ? (first.text as string | null) : null;
        return {
          id: c.id,
          agent_type: sub?.agentType == null ? null : String(sub.agentType),
          description: sub?.description == null ? null : String(sub.description),
          started_at: pgTs(c.started_at),
          ended_at: pgTs(c.ended_at),
          turn_count: nul(c.turn_count),
          brief: text != null && [...text].length > 160 ? `${[...text].slice(0, 159).join("")}…` : text,
        };
      }),
    });
  },

  // 030_code_scope_read_rpcs.sql
  code_context_for: (a) => {
    const q = typeof a.p_query === "string" ? a.p_query : "";
    const proj = scopedProjects(a.p_user_id, a.p_scope_code_project_id);
    const scoped = proj.map((p) => p.id);
    const inScope = (s: Row) => a.p_scope_code_project_id == null || scoped.includes(s.code_project_id);
    const sessions = rows("code_sessions", a.p_user_id);
    const matchedSessions = sessions
      .filter((s) => inScope(s) && (ilikeContains(s.title, q) || ilikeContains(s.summary, q)))
      .sort(
        descNullsLast(
          (s) => s.started_at,
          () => "",
        ),
      )
      .slice(0, 15)
      .map((s) => ({
        id: s.id,
        code_project_id: s.code_project_id,
        title: nul(s.title),
        summary: nul(s.summary),
        git_branch: nul(s.git_branch),
        started_at: pgTs(s.started_at),
        ended_at: pgTs(s.ended_at),
        files_touched: nul(s.files_touched),
      }));
    const matchedTurns = rows("code_session_turns", a.p_user_id)
      .flatMap((t) => {
        const s = sessions.find((r) => r.id === t.session_id);
        return s && inScope(s) && t.text != null && ilikeContains(t.text, q) ? [{ t, s }] : [];
      })
      .sort(
        descNullsLast(
          ({ t }) => t.ts,
          () => "",
        ),
      )
      .slice(0, 30)
      .map(({ t, s }) => ({
        session_id: t.session_id,
        code_project_id: s.code_project_id,
        idx: t.idx,
        role: t.role,
        kind: t.kind,
        text: t.text,
        tool_name: nul(t.tool_name),
        file_path: nul(t.file_path),
        ts: pgTs(t.ts),
      }));
    return ok({
      query: a.p_query ?? null,
      project_count: proj.length,
      projects: proj
        .sort(
          descNullsLast(
            (p) => p.last_active_at,
            () => "",
          ),
        )
        .map((p) => ({
          id: p.id,
          repo_identity: p.repo_identity,
          display_name: nul(p.display_name),
          summary: nul(p.summary),
          rollup: nul((p.props as Row | null)?.rollup),
          session_count: nul(p.session_count),
          last_active_at: pgTs(p.last_active_at),
        })),
      sessions: matchedSessions,
      turns: matchedTurns,
    });
  },

  // 071_search_conversations_rev2.sql (as later revised): backs /api/search
  // directly (lib/search.ts's only RPC caller), not an MCP tool. Not graph-
  // backed (plain `conversations` table), so no graphEmpty guard. This fake
  // never scores real FTS/vector rank (`search_similarity` is always null) —
  // it filters by user + lane and, when `query_text` is non-empty, an
  // ILIKE-style substring match on title, which is enough to lock a
  // deterministic contract for a corpus with no real ranking signal to
  // model against.
  search_conversations: (a) => {
    const laneOk = (source: string): boolean => {
      if (a.p_lane === "chat") return source !== "claude-code";
      if (a.p_lane === "code") return source === "claude-code";
      return true;
    };
    const q = typeof a.query_text === "string" ? a.query_text : "";
    const matched = rows("conversations", a.search_user_id)
      .filter((c) => laneOk(c.source as string))
      .filter((c) => q === "" || ilikeContains(c.title, q))
      .sort(
        descNullsLast(
          (c: Row) => c.updated_at ?? c.created_at,
          (c: Row) => c.id as string,
        ),
      )
      .slice(0, clampLimit(a.match_count));
    return ok(
      matched.map((c) => ({
        id: c.id,
        source: c.source,
        title: nul(c.title),
        created_at: pgTs(c.created_at as string),
        summary: null,
        similarity: null,
      })),
    );
  },

  // W7 D3 (no embedding key): the KEYWORD leg only. These two are approximations,
  // not ports — they model exactly the call the no-key path makes
  // (p_query_embedding null): plain-word matching stands in for to_tsvector
  // ('english'), and a call with a query vector returns an error so a keyed path
  // can never be pinned against this fake by accident.

  // 116/118 memory_search_scored, p_query_embedding null: IDF-weighted lexical leg, RRF over it alone.
  memory_search_scored: (a) => {
    if (a.p_query_embedding != null)
      return { data: null, error: { message: "golden fake: semantic leg not modelled" } };
    const terms = [
      ...new Set(
        String(a.p_query ?? "")
          .toLowerCase()
          .match(/[a-z0-9]+/g) ?? [],
      ),
    ];
    const words = (t: unknown): Set<string> =>
      new Set(
        String(t ?? "")
          .toLowerCase()
          .match(/[a-z0-9]+/g) ?? [],
      );
    const base = rows("session_memories", a.p_user_id).filter(
      (m) =>
        (a.p_include_retired === true || m.retired_at == null) &&
        (a.p_code_project_id == null || m.code_project_id === a.p_code_project_id) &&
        (!Array.isArray(a.p_kinds) || a.p_kinds.includes(m.kind)),
    );
    const idf = new Map(
      terms.map((t) => {
        const df = base.filter((m) => words(m.text).has(t) || words(m.quote).has(t)).length;
        return [t, df > 0 ? Math.log(1 + base.length / df) : 0];
      }),
    );
    const scored = base
      .map((m) => {
        const hit = terms.filter((t) => words(m.text).has(t) || words(m.quote).has(t));
        const lex = hit.reduce((s, t) => s + (words(m.text).has(t) ? 1 : 0.5) * (idf.get(t) ?? 0), 0);
        return { m, hits: hit.length, lex };
      })
      .filter((x) => x.hits > 0)
      .sort((x, y) => y.lex - x.lex || String(x.m.id).localeCompare(String(y.m.id)));
    const out = scored.slice(0, Math.max(Number(a.p_limit ?? 20), 1)).map((x, i) => ({
      ...x.m,
      embedding: undefined,
      leg_score: 1 / (60 + i + 1),
      similarity: null,
      lex_score: x.lex,
      lex_hits: x.hits,
      query_lexemes: terms.length,
      observed_at: x.m.created_at,
    }));
    return { data: out, error: null };
  },

  // 097 mcp_search_unified, p_query_embedding null, empty graph: chat hits on title/messages, code hits per turn.
  mcp_search_unified: (a) => {
    if (a.p_query_embedding != null)
      return { data: null, error: { message: "golden fake: semantic leg not modelled" } };
    const guard = graphEmpty(a.p_user_id, "mcp_search_unified");
    if (guard) return guard;
    const q = String(a.p_query ?? "");
    const chat = rows("conversations", a.p_user_id)
      .filter(
        (c) =>
          ilikeContains(c.title, q) ||
          (Array.isArray(c.messages) && c.messages.some((m) => ilikeContains((m as { content?: unknown }).content, q))),
      )
      .map((c) => ({
        source_type: "chat",
        conversation_id: c.id,
        session_id: null,
        turn_idx: null,
        code_project_id: null,
        project_name: null,
        title: nul(c.title),
        summary: null,
        similarity: null,
        score: 0,
        recency: pgTs(c.updated_at ?? c.created_at),
        resolved: true,
        chunk_idx: null,
        message_start_idx: null,
        message_end_idx: null,
        snippet: nul(c.title),
      }));
    const projects = rows("code_projects", a.p_user_id);
    const sessions = rows("code_sessions", a.p_user_id);
    const code =
      a.p_include_code === true
        ? rows("code_session_turns", a.p_user_id)
            .filter((t) => ilikeContains(t.text, q))
            .flatMap((t) => {
              const s = sessions.find((x) => x.id === t.session_id);
              const cp = s && projects.find((p) => p.id === s.code_project_id);
              if (!s || !cp) return [];
              return [
                {
                  source_type: "code",
                  conversation_id: null,
                  session_id: s.id,
                  turn_idx: t.idx,
                  code_project_id: cp.id,
                  project_name: cp.display_name ?? cp.repo_identity,
                  title: nul(s.title),
                  summary: nul(s.summary),
                  similarity: null,
                  score: 0,
                  recency: pgTs(s.started_at),
                  resolved: true,
                  chunk_idx: null,
                  message_start_idx: null,
                  message_end_idx: null,
                  snippet: t.text,
                },
              ];
            })
        : [];
    const all = [...chat, ...code]
      .sort(
        descNullsLast(
          (r) => r.recency,
          (r) => String(r.conversation_id ?? r.session_id),
        ),
      )
      .slice(0, Math.max(Number(a.p_limit ?? 20), 1))
      .map((r, i) => ({ ...r, score: 1 / (60 + i + 1) }));
    return ok(all);
  },
};
