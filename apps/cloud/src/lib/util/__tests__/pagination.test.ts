import { describe, expect, it } from "vitest";
import { PAGE_SIZE, selectAllByIdKeyset, selectAllRows, selectAllSessionsByKeyset } from "../pagination";

/** A table of `n` rows served the way PostgREST does: at most PAGE_SIZE per response. */
function pagedTable(n: number) {
  const rows = Array.from({ length: n }, (_, i) => ({ id: i }));
  const calls: [number, number][] = [];
  const page = (from: number, to: number) => {
    calls.push([from, to]);
    const end = Math.min(to + 1, from + PAGE_SIZE);
    return Promise.resolve({ data: rows.slice(from, end), error: null });
  };
  return { rows, calls, page };
}

describe("selectAllRows past the 1000-row cap", () => {
  it("returns every row of a 2,345-row table, in order, in three pages", async () => {
    const t = pagedTable(2345);
    const out = await selectAllRows(t.page);
    expect(out).toHaveLength(2345);
    expect(out.map((r) => r.id)).toEqual(t.rows.map((r) => r.id));
    expect(t.calls).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
    ]);
  });

  it("asks once more after an exactly full page and stops on the empty one", async () => {
    const t = pagedTable(2000);
    expect(await selectAllRows(t.page)).toHaveLength(2000);
    expect(t.calls).toHaveLength(3);
  });

  it("throws on a page error instead of returning a silent partial list", async () => {
    let n = 0;
    await expect(
      selectAllRows((from, to) =>
        Promise.resolve(
          n++ === 0
            ? { data: Array.from({ length: to - from + 1 }, (_, i) => ({ id: i })), error: null }
            : { data: null, error: { message: "boom" } },
        ),
      ),
    ).rejects.toThrow("boom");
  });
});

/** A keyset-capable fake over a live array (mutations between pages are visible, as in Postgres). */
function keysetTable<Row extends { id: string; started_at?: string | null }>(
  rows: Row[],
  onPage?: (n: number) => void,
) {
  let pages = 0;
  return () => {
    const filters: ((r: Row) => boolean)[] = [];
    let order: string[] = [];
    let limit = Number.POSITIVE_INFINITY;
    const q = {
      is: (c: string) => {
        filters.push((r) => (r as Record<string, unknown>)[c] == null);
        return q;
      },
      not: (c: string) => {
        filters.push((r) => (r as Record<string, unknown>)[c] != null);
        return q;
      },
      gt: (c: string, v: string) => {
        filters.push((r) => String((r as Record<string, unknown>)[c]) > v);
        return q;
      },
      or: (f: string) => {
        const m = /^started_at\.gt\."([^"]+)",and\(started_at\.eq\."([^"]+)",id\.gt\.(.+)\)$/.exec(f);
        if (!m) throw new Error(f);
        filters.push((r) => (r.started_at ?? "") > m[1] || ((r.started_at ?? "") === m[2] && r.id > m[3]));
        return q;
      },
      order: (c: string) => {
        order = [...order, c];
        return q;
      },
      limit: (n: number) => {
        limit = n;
        return q;
      },
      // biome-ignore lint/suspicious/noThenProperty: thenable like supabase-js
      then: (res: (v: unknown) => unknown) => {
        onPage?.(pages++);
        const key = (r: Row) => order.map((c) => String((r as Record<string, unknown>)[c] ?? "")).join("\u0000");
        const out = rows.filter((r) => filters.every((f) => f(r))).sort((a, b) => (key(a) < key(b) ? -1 : 1));
        return Promise.resolve({ data: out.slice(0, Math.min(limit, PAGE_SIZE)), error: null }).then(res);
      },
    };
    return q;
  };
}

describe("review S5: keyset paging never repeats or skips a row when the set changes mid-read", () => {
  const pad = (i: number) => String(i).padStart(5, "0");

  it("sessions: an OLDER session inserted between pages is never read twice (offset paging would repeat one)", async () => {
    const rows = Array.from({ length: 1500 }, (_, i) => ({ id: `s${pad(i)}`, started_at: `2026-01-01T00:${pad(i)}` }));
    rows.push({ id: "snull", started_at: null } as unknown as (typeof rows)[number]);
    const read = await selectAllSessionsByKeyset<{ id: string; started_at: string | null }>(
      keysetTable(rows, (n) => {
        if (n === 1) rows.push({ id: "s-older", started_at: "2025-12-31T00:00" });
      }),
    );
    const ids = read.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(1501); // every pre-existing session once, the NULL-started one included
    expect(ids).toContain("snull");
  });

  it("issue rows: a delete + insert at new ids between pages shifts no page — no row skipped or repeated", async () => {
    const rows = Array.from({ length: 1200 }, (_, i) => ({ id: `r${pad(i)}`, session_id: i < 3 ? "S" : `x${i}` }));
    const read = await selectAllByIdKeyset<{ id: string; session_id: string }>(
      keysetTable(rows, (n) => {
        if (n !== 1) return;
        // re-derive session S: its old rows (low ids, already read) go, new ones land at high ids.
        for (let i = rows.length - 1; i >= 0; i--) if (rows[i].session_id === "S") rows.splice(i, 1);
        rows.push({ id: "r99990", session_id: "S" }, { id: "r99991", session_id: "S" });
      }),
    );
    const ids = read.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    // No row skipped: every row present at the start that still exists was read.
    for (let i = 3; i < 1200; i++) expect(ids).toContain(`r${pad(i)}`);
  });
});
