// Paginated PostgREST select.
//
// Supabase/PostgREST caps a single response at ~1000 rows (db-max-rows). Any
// select that returns one row per conversation silently truncates once a user
// crosses that many conversations. selectAllRows pages with .range() until a
// short page arrives, mirroring the manifest route's approach.

export const PAGE_SIZE = 1000;

type PageResult<Row> = { data: Row[] | null; error: { message: string } | null };

/**
 * Drain a PostgREST select past the 1000-row cap. `makePage` must return a
 * fresh query for each page (builders are single-use) with a STABLE .order()
 * and the given .range(from, to) applied — otherwise pages overlap or repeat.
 */
export async function selectAllRows<Row>(
  makePage: (from: number, to: number) => PromiseLike<PageResult<Row>>,
): Promise<Row[]> {
  const out: Row[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await makePage(offset, offset + PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < PAGE_SIZE) break;
  }
  return out;
}

/**
 * `selectAllRows` for a caller that knows roughly how many rows to expect
 * (e.g. the sum of `code_sessions.turn_count`): it requests the first
 * floor(expected / PAGE_SIZE) + 1 pages at once, so a 37k-row read costs one
 * network round trip instead of 38 sequential ones. Pages are consumed in
 * order and stop at the first short page, and if every page came back full
 * it keeps paging one at a time — so a wrong estimate costs only time, and
 * the result is the same rows `selectAllRows` returns for the same data.
 */
export async function selectAllRowsParallel<Row>(
  makePage: (from: number, to: number) => PromiseLike<PageResult<Row>>,
  expectedRows: number,
): Promise<Row[]> {
  const pages = Math.floor(Math.max(0, expectedRows) / PAGE_SIZE) + 1;
  const results = await Promise.all(
    Array.from({ length: pages }, (_, i) => makePage(i * PAGE_SIZE, (i + 1) * PAGE_SIZE - 1)),
  );
  const out: Row[] = [];
  for (const { data, error } of results) {
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < PAGE_SIZE) return out;
  }
  for (let offset = pages * PAGE_SIZE; ; offset += PAGE_SIZE) {
    const { data, error } = await makePage(offset, offset + PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < PAGE_SIZE) return out;
  }
}

// --- keyset paging (attribution v3, review S5) --------------------------------
//
// Offset paging (`.range()`) over a set that changes mid-read skips or repeats
// rows: an import that inserts an older session shifts every later page, and a
// re-derive (delete + insert) moves a session's rows to new ids. A repeated
// session double-counts its cost. Keyset paging asks for "rows after the last
// one seen" instead, so a concurrent insert or delete never shifts a page.

/** The query-builder surface the keyset readers use (supabase-js builders satisfy it). */
interface KeysetQuery<Row> extends PromiseLike<PageResult<Row>> {
  gt(column: string, value: string): KeysetQuery<Row>;
  or(filters: string): KeysetQuery<Row>;
  is(column: string, value: null): KeysetQuery<Row>;
  not(column: string, operator: string, value: null): KeysetQuery<Row>;
  order(column: string, options: { ascending: boolean }): KeysetQuery<Row>;
  limit(count: number): KeysetQuery<Row>;
}

/**
 * Every row of a filtered select, paged by `id > last id` (ordered by id).
 * `build` returns a FRESH filtered query each call (builders are single-use),
 * without order/range/limit.
 */
export async function selectAllByIdKeyset<Row extends { id: string }>(build: () => unknown): Promise<Row[]> {
  const out: Row[] = [];
  let last: string | null = null;
  for (;;) {
    let q = build() as KeysetQuery<Row>;
    if (last !== null) q = q.gt("id", last);
    const { data, error } = await q.order("id", { ascending: true }).limit(PAGE_SIZE);
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < PAGE_SIZE) return out;
    last = rows[rows.length - 1].id;
  }
}

/**
 * Every session of a filtered select, paged by `(started_at, id) > last seen`
 * (ordered by started_at, then id), then — since a keyset on a nullable column
 * never reaches NULL — the rows with no `started_at`, by id. The `id` column
 * must be selected; `started_at` too.
 */
export async function selectAllSessionsByKeyset<Row extends { id: string; started_at: string | null }>(
  build: () => unknown,
): Promise<Row[]> {
  const out: Row[] = [];
  let last: Row | null = null;
  for (;;) {
    let q = (build() as KeysetQuery<Row>).not("started_at", "is", null);
    if (last?.started_at) {
      const t = `"${last.started_at}"`;
      q = q.or(`started_at.gt.${t},and(started_at.eq.${t},id.gt.${last.id})`);
    }
    const { data, error } = await q
      .order("started_at", { ascending: true })
      .order("id", { ascending: true })
      .limit(PAGE_SIZE);
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < PAGE_SIZE) break;
    last = rows[rows.length - 1];
  }
  out.push(...(await selectAllByIdKeyset<Row>(() => (build() as KeysetQuery<Row>).is("started_at", null))));
  return out;
}
