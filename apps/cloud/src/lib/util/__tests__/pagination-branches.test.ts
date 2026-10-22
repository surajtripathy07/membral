import { describe, expect, it } from "vitest";
import {
  PAGE_SIZE,
  selectAllByIdKeyset,
  selectAllRows,
  selectAllRowsParallel,
  selectAllSessionsByKeyset,
} from "../pagination";

// Issue #188 / R5 5.11: null-data and error branches of every pager, plus the
// parallel reader's page-count and fallback paging.

const full = (from: number) => Array.from({ length: PAGE_SIZE }, (_, i) => ({ id: from + i }));

/** A chainable query double: build() n resolves to `results[n]`; every builder method records itself and returns the same thenable. */
function scriptedQuery(results: Array<{ data: unknown; error: { message: string } | null }>) {
  const chains: string[][] = [];
  const build = () => {
    const chain: string[] = [];
    chains.push(chain);
    const q: Promise<unknown> & Record<string, unknown> = Object.assign(
      Promise.resolve(results[chains.length - 1] ?? { data: [], error: null }),
      {} as Record<string, unknown>,
    );
    for (const m of ["gt", "or", "is", "not", "order", "limit"]) {
      q[m] = (...args: unknown[]) => {
        chain.push(`${m}(${args.map((a) => JSON.stringify(a)).join(",")})`);
        return q;
      };
    }
    return q;
  };
  return { build, chains };
}

describe("selectAllRows", () => {
  it("treats a null data payload as an empty page", async () => {
    expect(await selectAllRows(() => Promise.resolve({ data: null, error: null }))).toEqual([]);
  });
});

describe("selectAllRowsParallel", () => {
  it("requests floor(expected/PAGE_SIZE)+1 pages at once and stops at the first short page", async () => {
    const calls: [number, number][] = [];
    const out = await selectAllRowsParallel((from, to) => {
      calls.push([from, to]);
      return Promise.resolve({ data: from === 0 ? full(0) : [{ id: -1 }], error: null });
    }, 1500);
    expect(calls).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
    expect(out).toHaveLength(PAGE_SIZE + 1);
  });

  it("a negative estimate still reads one page", async () => {
    const calls: [number, number][] = [];
    await selectAllRowsParallel((from, to) => {
      calls.push([from, to]);
      return Promise.resolve({ data: [], error: null });
    }, -5);
    expect(calls).toEqual([[0, 999]]);
  });

  it("a null page is empty and ends the read", async () => {
    expect(await selectAllRowsParallel(() => Promise.resolve({ data: null, error: null }), 0)).toEqual([]);
  });

  it("an error in a parallel page throws its message", async () => {
    await expect(
      selectAllRowsParallel(() => Promise.resolve({ data: null, error: { message: "page boom" } }), 0),
    ).rejects.toThrow("page boom");
  });

  it("keeps paging one at a time when the estimate was too low (every page full)", async () => {
    const calls: number[] = [];
    const out = await selectAllRowsParallel((from) => {
      calls.push(from);
      return Promise.resolve({ data: from < 2000 ? full(from) : [{ id: from }], error: null });
    }, 0);
    expect(calls).toEqual([0, 1000, 2000]);
    expect(out).toHaveLength(2 * PAGE_SIZE + 1);
  });

  it("an error in a fallback page throws; a null fallback page ends the read", async () => {
    await expect(
      selectAllRowsParallel((from) => {
        return Promise.resolve(
          from === 0 ? { data: full(0), error: null } : { data: null, error: { message: "late" } },
        );
      }, 0),
    ).rejects.toThrow("late");
    const out = await selectAllRowsParallel(
      (from) => Promise.resolve({ data: from === 0 ? full(0) : null, error: null }),
      0,
    );
    expect(out).toHaveLength(PAGE_SIZE);
  });
});

describe("selectAllByIdKeyset", () => {
  it("throws the page error's message", async () => {
    const q = scriptedQuery([{ data: null, error: { message: "keyset boom" } }]);
    await expect(selectAllByIdKeyset(q.build)).rejects.toThrow("keyset boom");
  });

  it("a null payload is an empty page; the first query has no gt() and orders by id with the page limit", async () => {
    const q = scriptedQuery([{ data: null, error: null }]);
    expect(await selectAllByIdKeyset(q.build)).toEqual([]);
    expect(q.chains[0]).toEqual(['order("id",{"ascending":true})', `limit(${PAGE_SIZE})`]);
  });

  it("a full page is followed by a gt(last id) query", async () => {
    const rows = Array.from({ length: PAGE_SIZE }, (_, i) => ({ id: `r${i}` }));
    const q = scriptedQuery([
      { data: rows, error: null },
      { data: [], error: null },
    ]);
    expect(await selectAllByIdKeyset(q.build)).toHaveLength(PAGE_SIZE);
    expect(q.chains[1][0]).toBe(`gt("id","r${PAGE_SIZE - 1}")`);
  });
});

describe("selectAllSessionsByKeyset", () => {
  it("throws the page error's message before reading the NULL-started rows", async () => {
    const q = scriptedQuery([{ data: null, error: { message: "session boom" } }]);
    await expect(selectAllSessionsByKeyset(q.build)).rejects.toThrow("session boom");
    expect(q.chains).toHaveLength(1);
  });

  it("a null payload is an empty page; then the NULL started_at rows are read by id", async () => {
    const q = scriptedQuery([
      { data: null, error: null },
      { data: [{ id: "n1", started_at: null }], error: null },
    ]);
    const out = await selectAllSessionsByKeyset<{ id: string; started_at: string | null }>(q.build);
    expect(out).toEqual([{ id: "n1", started_at: null }]);
    expect(q.chains[0]).toContain('not("started_at","is",null)');
    expect(q.chains[1]).toContain('is("started_at",null)');
  });
});
