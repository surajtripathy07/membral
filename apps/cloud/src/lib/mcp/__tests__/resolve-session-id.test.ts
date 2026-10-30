import { describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/types";
import { resolveSessionId } from "../resolve-session-id";

interface Row {
  id: string;
  user_id: string;
  code_project_id: string;
  source_session_id?: string;
  parent_source_session_id?: string | null;
}

const ME = "user-1";
const OTHER = "user-2";
const ROWS: Row[] = [
  { id: "6b3ce53f-1111-4aaa-8aaa-aaaaaaaaaaaa", user_id: ME, code_project_id: "proj-a" },
  { id: "7c00aa11-1111-4aaa-8aaa-aaaaaaaaaaaa", user_id: ME, code_project_id: "proj-a" },
  { id: "7c00aa11-2222-4aaa-8aaa-aaaaaaaaaaaa", user_id: ME, code_project_id: "proj-b" },
  { id: "9f9f9f9f-1111-4aaa-8aaa-aaaaaaaaaaaa", user_id: OTHER, code_project_id: "proj-z" },
];

/** A code_sessions query double: eq/gte/lte/like/is/order/limit applied with text comparison (= uuid byte order). */
function fakeDb(rows: Row[]) {
  const calls: { filters: [string, string, string][] }[] = [];
  const db = {
    from(table: string) {
      expect(table).toBe("code_sessions");
      const filters: [string, string, string][] = [];
      calls.push({ filters });
      let limit = Number.POSITIVE_INFINITY;
      const q = {
        select: () => q,
        eq: (c: string, v: string) => {
          filters.push(["eq", c, v]);
          return q;
        },
        gte: (c: string, v: string) => {
          filters.push(["gte", c, v]);
          return q;
        },
        lte: (c: string, v: string) => {
          filters.push(["lte", c, v]);
          return q;
        },
        like: (c: string, v: string) => {
          filters.push(["like", c, v]);
          return q;
        },
        is: (c: string, v: null) => {
          filters.push(["is", c, String(v)]);
          return q;
        },
        order: () => q,
        limit: (n: number) => {
          limit = n;
          return q;
        },
        // biome-ignore lint/suspicious/noThenProperty: a PostgREST builder is thenable
        then: (resolve: (v: unknown) => unknown) => {
          const out = rows
            .filter((r) =>
              filters.every(([op, c, v]) => {
                const x = String(r[c as keyof Row] ?? null);
                if (op === "like") return x.startsWith(v.replace(/%$/, ""));
                if (op === "is") return x === v;
                return op === "eq" ? x === v : op === "gte" ? x >= v : x <= v;
              }),
            )
            .sort((a, b) => a.id.localeCompare(b.id))
            .slice(0, limit)
            .map((r) => ({ id: r.id }));
          return Promise.resolve(resolve({ data: out, error: null }));
        },
      };
      return q;
    },
  };
  return { db: db as unknown as Db, calls };
}

describe("resolveSessionId", () => {
  it("passes a full id through without a lookup", async () => {
    const { db, calls } = fakeDb(ROWS);
    expect(await resolveSessionId(db, ME, ROWS[0].id)).toEqual({ ok: true, id: ROWS[0].id });
    expect(calls).toHaveLength(0);
  });

  it("resolves a unique 8-char prefix (and a dashed longer one) to the full id, user-scoped", async () => {
    const { db, calls } = fakeDb(ROWS);
    expect(await resolveSessionId(db, ME, "6b3ce53f")).toEqual({ ok: true, id: ROWS[0].id });
    expect(await resolveSessionId(db, ME, "7C00AA11-22")).toEqual({ ok: true, id: ROWS[2].id });
    expect(calls[0].filters).toContainEqual(["eq", "user_id", ME]);
  });

  it("an ambiguous prefix names two candidates by their first 12 chars", async () => {
    const { db } = fakeDb(ROWS);
    const out = await resolveSessionId(db, ME, "7c00aa11");
    expect(out).toEqual({
      ok: false,
      reason: "ambiguous",
      message: expect.stringContaining("candidates: 7c00aa11-1111, 7c00aa11-2222 (first 13 chars each)"),
    });
  });

  it("two ids sharing 11 hex digits are shown up to their first difference", async () => {
    const rows: Row[] = [
      { id: "abcdef01-2345-4aaa-8aaa-aaaaaaaaaaaa", user_id: ME, code_project_id: "p" },
      { id: "abcdef01-2345-4bbb-8aaa-aaaaaaaaaaaa", user_id: ME, code_project_id: "p" },
    ];
    const { db } = fakeDb(rows);
    const out = await resolveSessionId(db, ME, "abcdef01-234");
    expect(out).toEqual({
      ok: false,
      reason: "ambiguous",
      message: expect.stringContaining("candidates: abcdef01-2345-4a, abcdef01-2345-4b (first 16 chars each)"),
    });
  });

  it("a code-scoped key resolves only within its project", async () => {
    const { db } = fakeDb(ROWS);
    expect(await resolveSessionId(db, ME, "7c00aa11", "proj-b")).toEqual({ ok: true, id: ROWS[2].id });
  });

  it("another user's session prefix is not found", async () => {
    const { db } = fakeDb(ROWS);
    expect(await resolveSessionId(db, ME, "9f9f9f9f")).toEqual({ ok: false, reason: "not_found" });
    expect(await resolveSessionId(db, OTHER, "9f9f9f9f")).toEqual({ ok: true, id: ROWS[3].id });
  });

  it("a prefix under 8 chars or a non-hex id passes through for the caller's own lookup", async () => {
    const { db, calls } = fakeDb(ROWS);
    expect(await resolveSessionId(db, ME, "6b3ce5")).toEqual({ ok: true, id: "6b3ce5" });
    expect(await resolveSessionId(db, ME, "sess-1")).toEqual({ ok: true, id: "sess-1" });
    expect(calls).toHaveLength(0);
  });

  describe("harness source_session_id prefix", () => {
    const SRC: Row[] = [
      {
        id: "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        user_id: ME,
        code_project_id: "p",
        source_session_id: "6210dd4d-72dc-4e0f-9a1b-000000000001",
        parent_source_session_id: null,
      },
      // A sub-agent of the first: its source id extends the main session's, so it must not make the prefix ambiguous.
      {
        id: "22222222-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        user_id: ME,
        code_project_id: "p",
        source_session_id: "6210dd4d-72dc-4e0f-9a1b-000000000001:agent-ab12",
        parent_source_session_id: "6210dd4d-72dc-4e0f-9a1b-000000000001",
      },
      {
        id: "33333333-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        user_id: ME,
        code_project_id: "p",
        source_session_id: "77aa77aa-0000-4e0f-9a1b-000000000001",
        parent_source_session_id: null,
      },
      {
        id: "44444444-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        user_id: ME,
        code_project_id: "p",
        source_session_id: "77aa77aa-1111-4e0f-9a1b-000000000001",
        parent_source_session_id: null,
      },
      {
        id: "55555555-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        user_id: OTHER,
        code_project_id: "z",
        source_session_id: "9e9e9e9e-0000-4e0f-9a1b-000000000001",
        parent_source_session_id: null,
      },
    ];

    it("resolves a unique prefix of the harness id to the Membral id, ignoring its own sub-agents", async () => {
      const { db, calls } = fakeDb(SRC);
      expect(await resolveSessionId(db, ME, "6210dd4d")).toEqual({ ok: true, id: SRC[0].id });
      // the Membral-id range found nothing first, then the source lookup ran user-scoped on main sessions
      expect(calls).toHaveLength(2);
      expect(calls[1].filters).toContainEqual(["eq", "user_id", ME]);
      expect(calls[1].filters).toContainEqual(["is", "parent_source_session_id", "null"]);
    });

    it("falls back to sub-agent sessions when no main session matches", async () => {
      const { db } = fakeDb([SRC[1]]);
      expect(await resolveSessionId(db, ME, "6210dd4d")).toEqual({ ok: true, id: SRC[1].id });
    });

    it("an ambiguous harness prefix is an error naming candidates, not a pick", async () => {
      const { db } = fakeDb(SRC);
      const out = await resolveSessionId(db, ME, "77aa77aa");
      expect(out).toEqual({
        ok: false,
        reason: "ambiguous",
        message: expect.stringContaining("Ambiguous session id prefix"),
      });
    });

    it("the Membral id wins when it matches, with no source lookup", async () => {
      const { db, calls } = fakeDb(SRC);
      expect(await resolveSessionId(db, ME, "11111111")).toEqual({ ok: true, id: SRC[0].id });
      expect(calls).toHaveLength(1);
    });

    it("another user's harness id, and a code-scoped key outside its project, are not found", async () => {
      const { db } = fakeDb(SRC);
      expect(await resolveSessionId(db, ME, "9e9e9e9e")).toEqual({ ok: false, reason: "not_found" });
      expect(await resolveSessionId(db, ME, "6210dd4d", "other-project")).toEqual({ ok: false, reason: "not_found" });
    });

    it("a prefix under 8 chars does no lookup at all", async () => {
      const { db, calls } = fakeDb(SRC);
      expect(await resolveSessionId(db, ME, "6210dd4")).toEqual({ ok: true, id: "6210dd4" });
      expect(calls).toHaveLength(0);
    });
  });
});
