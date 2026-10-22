// Mirrors apps/cloud/src/app/api/kg/bootstrap/status/__tests__/route.test.ts's
// auth pattern — the base /api/agent-stats route has no test file of its own
// to mirror directly (goal step 9 slice two's brief: "if the existing route
// has one"), so this follows the nearest equivalent createClient-mock
// convention in the codebase instead.
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetUser = vi.fn();
const tables: Record<string, unknown[]> = {};
const cursors: Record<string, string[]> = {};

/**
 * A PostgREST-shaped fake that serves keyset reads (review S5): it honours `is/not(started_at, null)`,
 * `gt("id", …)`, the `(started_at, id) >` `or()` cursor and `limit`, orders by (started_at, id) or id,
 * and caps every response at 1000 rows like `max_rows`. It records each request's cursor.
 */
function fakeFrom(table: string) {
  type Row = { id: string; started_at?: string | null };
  const filters: ((r: Row) => boolean)[] = [];
  let orderCols: string[] = [];
  let limit = Number.POSITIVE_INFINITY;
  let cursor = "start";
  const builder = {
    select: () => builder,
    eq: () => builder,
    in: () => builder,
    is: (col: string, _v: null) => {
      filters.push((r) => (r as Record<string, unknown>)[col] == null);
      return builder;
    },
    not: (col: string, _op: string, _v: null) => {
      filters.push((r) => (r as Record<string, unknown>)[col] != null);
      return builder;
    },
    gt: (col: string, v: string) => {
      cursor = `id>${v}`;
      filters.push((r) => String((r as Record<string, unknown>)[col]) > v);
      return builder;
    },
    or: (f: string) => {
      const m = /^started_at\.gt\."([^"]+)",and\(started_at\.eq\."([^"]+)",id\.gt\.(.+)\)$/.exec(f);
      if (!m) throw new Error(`unexpected or(): ${f}`);
      cursor = `(started_at,id)>(${m[1]},${m[3]})`;
      filters.push((r) => (r.started_at ?? "") > m[1] || ((r.started_at ?? "") === m[2] && r.id > m[3]));
      return builder;
    },
    order: (col: string) => {
      orderCols = [...orderCols, col];
      return builder;
    },
    limit: (n: number) => {
      limit = n;
      return builder;
    },
    range: () => {
      throw new Error("offset paging (.range) is not allowed here");
    },
    // biome-ignore lint/suspicious/noThenProperty: mimics supabase-js's thenable query builder
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
      if (!cursors[table]) cursors[table] = [];
      cursors[table].push(cursor);
      const rows = ((tables[table] ?? []) as Row[]).filter((r) => filters.every((f) => f(r)));
      const key = (r: Row) => orderCols.map((c) => String((r as Record<string, unknown>)[c] ?? "")).join("\u0000");
      rows.sort((x, y) => (key(x) < key(y) ? -1 : key(x) > key(y) ? 1 : 0));
      return Promise.resolve({ data: rows.slice(0, Math.min(limit, 1000)), error: null }).then(resolve, reject);
    },
  };
  return builder;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(() => Promise.resolve({ auth: { getUser: mockGetUser }, from: fakeFrom })),
}));

import { GET } from "../route";

describe("GET /api/agent-stats/issues", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const k of Object.keys(tables)) delete tables[k];
    for (const k of Object.keys(cursors)) delete cursors[k];
  });

  it("returns 401 when there is no session", async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: null } });
    const res = await GET(new NextRequest("http://localhost/api/agent-stats/issues"));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: "unauthorized" });
  });

  it("counts every session past PostgREST's 1000-row cap, and the rows of the late ones", async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: { id: "u1" } } });
    const n = 1143;
    tables.code_sessions = Array.from({ length: n }, (_, i) => ({
      id: `s${String(i).padStart(5, "0")}`,
      started_at: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(),
      turn_count: 10,
      user_turn_count: 1,
      props: null,
      parent_source_session_id: null,
      source: "claude-code",
      source_session_id: `src-${i}`,
      code_projects: { repo_identity: "codehub.example/acme/billing" },
    }));
    // The one worked-on row belongs to a session after the 1000th.
    tables.code_session_issues = [
      {
        id: "i1",
        session_id: "s01100",
        ref: "codehub.example/acme/billing#7",
        number: 7,
        kind: "issue",
        role: "worked_on",
        review_verb: null,
        build_verb: "committed",
        tier: "observed",
        turn_share: 1,
        related_to: [],
        turn_idx: 3,
      },
    ];
    const res = await GET(new NextRequest("http://localhost/api/agent-stats/issues"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sessions_total).toBe(n);
    // Keyset, never offset: the second page starts after the 1000th session's (started_at, id).
    expect(cursors.code_sessions?.[0]).toBe("start");
    expect(cursors.code_sessions?.[1]).toMatch(/^\(started_at,id\)>/);
    const row = body.issues.find((i: { issue: string }) => i.issue.endsWith("acme/billing#7"));
    expect(row?.sessions).toBe(1);
  });
});
