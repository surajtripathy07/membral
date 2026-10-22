// UX W5: session titles for dashboard rows — composition (parent + sub-agent
// label, no absolute paths) and the batched lookup (one call for many rows,
// a fixed number of queries for many ids).
import { describe, expect, it, vi } from "vitest";
import {
  collectSessionIds,
  composeSessionTitle,
  getSessionTitles,
  lookupTitlesOnce,
  type SessionTitleInfo,
  threadSessionTitles,
  toSessionRefs,
} from "../session-titles";

function row(id: string, over: Record<string, unknown> = {}) {
  return { id, title: null, summary: null, started_at: null, ...over };
}

describe("composeSessionTitle", () => {
  it("uses the session page's title source: title, else summary, else first prompt", () => {
    expect(composeSessionTitle(row("a", { title: "Fix login" }), null, new Map())).toBe("Fix login");
    expect(composeSessionTitle(row("a", { summary: "Refactored the ledger" }), null, new Map())).toBe(
      "Refactored the ledger",
    );
    expect(composeSessionTitle(row("a"), null, new Map([["a", "why is the build red\nmore"]]))).toBe(
      "why is the build red",
    );
  });

  it("never shows an absolute path", () => {
    const t = composeSessionTitle(
      row("a", { title: "Edit /Users/someone/dev/acme/src/ledger.ts now" }),
      null,
      new Map(),
    );
    expect(t).toBe("Edit ledger.ts now");
    expect(t).not.toContain("/Users/");
  });

  it("a sub-agent child reads as its parent's title plus the sub-agent label", () => {
    const parent = row("p", { title: "Ship the export" });
    const child = row("c", {
      parent_source_session_id: "src-p",
      source: "claude-code",
      title: "the brief",
      sub_agent: { description: "Find call sites", agentType: "Explore" },
    });
    expect(composeSessionTitle(child, parent, new Map())).toBe("Ship the export · Find call sites");
    const typeOnly = { ...child, sub_agent: { agentType: "Explore" } };
    expect(composeSessionTitle(typeOnly, parent, new Map())).toBe("Ship the export · Explore");
    const noLabel = { ...child, sub_agent: null };
    expect(composeSessionTitle(noLabel, parent, new Map())).toBe("Ship the export");
  });
});

describe("batched lookup (no N+1)", () => {
  it("lookupTitlesOnce calls the lookup ONCE with every distinct id, however many rows", async () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({ ids: [`s-${i % 7}`, `s-${(i + 1) % 7}`, null] }));
    const lookup = vi.fn(
      async (ids: string[]) => new Map(ids.map((id) => [id, { id, title: id, started_at: null }] as const)),
    );
    const titles = await lookupTitlesOnce(rows, (r) => r.ids, lookup);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup.mock.calls[0][0].sort()).toEqual(["s-0", "s-1", "s-2", "s-3", "s-4", "s-5", "s-6"]);
    expect(titles.size).toBe(7);
  });

  it("lookupTitlesOnce skips the lookup when no row references a session", async () => {
    const lookup = vi.fn();
    expect((await lookupTitlesOnce([{ ids: [] }], (r) => r.ids, lookup)).size).toBe(0);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("threadSessionTitles asks for both the folded and the proving session, once, and never throws", async () => {
    const threads = Array.from({ length: 20 }, (_, i) => ({
      sessions: [{ id: `p-${i}`, proof_session_id: `c-${i}` }],
    }));
    const lookup = vi.fn(
      async (ids: string[]) => new Map(ids.map((id) => [id, { id, title: `T ${id}`, started_at: null }] as const)),
    );
    const titles = await threadSessionTitles(threads, lookup);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(titles["c-3"]).toBe("T c-3");
    expect(titles["p-3"]).toBe("T p-3");
    expect(await threadSessionTitles(threads, async () => Promise.reject(new Error("db down")))).toEqual({});
  });

  it("getSessionTitles issues a fixed number of queries for 40 ids (sessions, parents, first prompts)", async () => {
    const ids = Array.from({ length: 40 }, (_, i) => `s-${i}`);
    const sessionRows = ids.map((id, i) =>
      i % 2 === 0
        ? row(id, { title: `Session ${i}`, started_at: `2026-09-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z` })
        : row(id, {
            parent_source_session_id: "src-parent",
            source: "claude-code",
            sub_agent: { agentType: "Explore" },
          }),
    );
    const calls: string[] = [];
    const client = {
      from(table: string) {
        const filters: Record<string, unknown> = {};
        const q = {
          select: () => q,
          eq: (col: string, v: unknown) => {
            filters[col] = v;
            return q;
          },
          in: (col: string, v: unknown) => {
            filters[col] = v;
            return q;
          },
          // biome-ignore lint/suspicious/noThenProperty: a thenable stands in for the awaited supabase-js builder
          then: (resolve: (r: { data: unknown[]; error: null }) => void) => {
            calls.push(`${table}:${filters.source_session_id ? "parents" : "rows"}`);
            if (table === "code_session_turns") return resolve({ data: [], error: null });
            if (filters.source_session_id)
              return resolve({
                data: [row("parent", { title: "Parent task", source_session_id: "src-parent" })],
                error: null,
              });
            return resolve({ data: sessionRows, error: null });
          },
        };
        return q;
      },
    };
    // biome-ignore lint/suspicious/noExplicitAny: minimal test double for the supabase-js query builder
    const titles = await getSessionTitles(client as any, "user-1", ids);
    expect(calls).toEqual(["code_sessions:rows", "code_sessions:parents"]);
    expect(titles.get("s-0")?.title).toBe("Session 0");
    expect(titles.get("s-1")?.title).toBe("Parent task · Explore");
  });
});

describe("helpers", () => {
  it("collectSessionIds dedupes in first-seen order", () => {
    expect(
      collectSessionIds([
        ["a", "b"],
        ["b", null, "c"],
      ]),
    ).toEqual(["a", "b", "c"]);
  });

  it("toSessionRefs sorts newest first and drops ids the lookup never returned", () => {
    const titles = new Map<string, SessionTitleInfo>([
      ["a", { id: "a", title: "A", started_at: "2026-09-01T00:00:00Z" }],
      ["b", { id: "b", title: "B", started_at: "2026-09-03T00:00:00Z" }],
    ]);
    expect(toSessionRefs(["a", "b", "gone", "a"], titles).map((r) => r.id)).toEqual(["b", "a"]);
  });
});
