import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { getCodeContextFor, getCodeProject, getCodeSession, listCodeProjects } from "../code-tools";

// Fixture "corpus" for one user: two code projects — membral (proj-membral,
// with session sess-m1) and a sibling (proj-other, with session sess-o1). The
// fake rpc() mimics the migration-030 SQL functions closely enough to prove the
// TS layer's scope wiring: p_scope_code_project_id is the ONLY thing that
// narrows a result, and a stale scope id fails CLOSED (empty / null), never
// open. This is a real-SQL-behaviour double, not a general PostgREST emulator.
const USER = "user-1";
const SCOPE = "proj-membral";
const OTHER = "proj-other";
const STALE = "proj-deleted";

const PROJECTS: Record<string, { id: string; repo_identity: string; display_name: string; session_count: number }> = {
  [SCOPE]: { id: SCOPE, repo_identity: "github.com/acme/membral", display_name: "acme/membral", session_count: 1 },
  [OTHER]: { id: OTHER, repo_identity: "github.com/acme/other", display_name: "acme/other", session_count: 1 },
};
const SESSIONS: Record<string, { id: string; code_project_id: string; title: string }> = {
  "sess-m1": { id: "sess-m1", code_project_id: SCOPE, title: "membral session" },
  "sess-o1": { id: "sess-o1", code_project_id: OTHER, title: "other session" },
};

/** The set of project ids a call may see: exactly the scope when scoped+live, empty when stale, ALL when unscoped. */
function allowedProjects(scope: string | null): string[] {
  if (scope == null) return Object.keys(PROJECTS);
  return PROJECTS[scope] ? [scope] : []; // stale id -> empty -> fail closed
}

function makeSupabase() {
  const rpc = vi.fn((name: string, args: Record<string, unknown>) => {
    const scope = (args.p_scope_code_project_id as string | null) ?? null;
    const allowed = allowedProjects(scope);

    if (name === "code_projects_list") {
      return Promise.resolve({
        data: Object.values(PROJECTS)
          .filter((p) => allowed.includes(p.id))
          .map((p) => ({ ...p, summary: null, source: "claude-code", last_active_at: null })),
        error: null,
      });
    }
    if (name === "code_project_detail") {
      const id = args.p_project_id as string;
      const p = PROJECTS[id];
      const visible = p && allowed.includes(id);
      return Promise.resolve({ data: visible ? { ...p, sessions: [], rollup: null } : null, error: null });
    }
    if (name === "code_session_detail") {
      const id = args.p_session_id as string;
      const s = SESSIONS[id];
      // Load-bearing cross-project guard: the session's project must be allowed.
      const visible = s && allowed.includes(s.code_project_id);
      return Promise.resolve({ data: visible ? { ...s, turns: [] } : null, error: null });
    }
    if (name === "code_context_for") {
      const projects = Object.values(PROJECTS).filter((p) => allowed.includes(p.id));
      return Promise.resolve({
        data: {
          query: args.p_query,
          project_count: projects.length,
          projects,
          sessions: Object.values(SESSIONS).filter((s) => allowed.includes(s.code_project_id)),
          turns: [],
        },
        error: null,
      });
    }
    return Promise.resolve({ data: null, error: { message: `unexpected rpc ${name}` } });
  });
  return { supabase: { rpc } as unknown as SupabaseClient, rpc };
}

describe("code-tools scope wiring (ADR 0021 Q7)", () => {
  describe("listCodeProjects", () => {
    it("scoped -> only the bound project, and passes the bound as p_scope_code_project_id", async () => {
      const { supabase, rpc } = makeSupabase();
      const res = await listCodeProjects(supabase, USER, SCOPE);
      expect(rpc).toHaveBeenCalledWith("code_projects_list", { p_user_id: USER, p_scope_code_project_id: SCOPE });
      expect(res.map((p) => p.id)).toEqual([SCOPE]);
    });

    it("unscoped (null bound) -> all projects", async () => {
      const { supabase } = makeSupabase();
      const res = await listCodeProjects(supabase, USER, null);
      expect(res.map((p) => p.id).sort()).toEqual([OTHER, SCOPE].sort());
    });

    it("stale/deleted scope id -> EMPTY (fail closed), never the whole corpus", async () => {
      const { supabase } = makeSupabase();
      const res = await listCodeProjects(supabase, USER, STALE);
      expect(res).toEqual([]);
    });
  });

  describe("getCodeProject", () => {
    it("scoped: the bound project resolves", async () => {
      const { supabase } = makeSupabase();
      expect(await getCodeProject(supabase, USER, SCOPE, SCOPE)).not.toBeNull();
    });

    it("ATTACK scoped: requesting a SIBLING project id -> null (invisible, no existence leak)", async () => {
      const { supabase } = makeSupabase();
      expect(await getCodeProject(supabase, USER, OTHER, SCOPE)).toBeNull();
    });

    it("unscoped: any own project resolves", async () => {
      const { supabase } = makeSupabase();
      expect(await getCodeProject(supabase, USER, OTHER, null)).not.toBeNull();
    });
  });

  describe("getCodeSession (cross-project guard)", () => {
    it("scoped: a session in the bound project resolves", async () => {
      const { supabase } = makeSupabase();
      expect(await getCodeSession(supabase, USER, "sess-m1", SCOPE)).not.toBeNull();
    });

    it("ATTACK scoped: a session id from a SIBLING project -> null (cannot pull it by guessing the id)", async () => {
      const { supabase } = makeSupabase();
      expect(await getCodeSession(supabase, USER, "sess-o1", SCOPE)).toBeNull();
    });

    it("unscoped: any own session resolves", async () => {
      const { supabase } = makeSupabase();
      expect(await getCodeSession(supabase, USER, "sess-o1", null)).not.toBeNull();
    });
  });

  describe("getCodeContextFor", () => {
    it("scoped -> only the bound project's context; sibling sessions never appear", async () => {
      const { supabase } = makeSupabase();
      const res = await getCodeContextFor(supabase, USER, "anything", SCOPE);
      expect(res.project_count).toBe(1);
      expect(res.projects.map((p) => p.id)).toEqual([SCOPE]);
      expect(res.sessions.every((s) => s.code_project_id === SCOPE)).toBe(true);
    });

    it("stale scope -> empty context (fail closed)", async () => {
      const { supabase } = makeSupabase();
      const res = await getCodeContextFor(supabase, USER, "anything", STALE);
      expect(res.project_count).toBe(0);
      expect(res.projects).toEqual([]);
      expect(res.sessions).toEqual([]);
    });

    it("unscoped -> spans all projects", async () => {
      const { supabase } = makeSupabase();
      const res = await getCodeContextFor(supabase, USER, "anything", null);
      expect(res.project_count).toBe(2);
    });
  });

  it("an rpc error surfaces as a thrown Error (never a silent empty result)", async () => {
    const rpc = vi.fn(() => Promise.resolve({ data: null, error: { message: "boom" } }));
    const supabase = { rpc } as unknown as SupabaseClient;
    await expect(listCodeProjects(supabase, USER, SCOPE)).rejects.toThrow(/code_projects_list failed: boom/);
  });
});
