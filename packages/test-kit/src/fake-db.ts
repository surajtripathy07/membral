// ONE in-memory PostgREST-ish Supabase double for every package's tests.
//
// It carries the union of the three fakes that used to live in apps/cloud
// (lib/memory, lib/code-sessions and lib/kg `__tests__/fake-supabase.ts`).
// Those three disagreed on semantics (memory drops inserts and records `.or()`
// without applying it; code-sessions clamps to 1000 rows and errors on an
// empty `.single()`; kg ignores `.order()`/`.limit()` and draws ids from a
// module-level counter). Each old path now constructs this fake in its own
// FLAVOUR, which reproduces that fake's observable behaviour exactly, so no
// existing assertion changes. Unifying the flavours is a later, separate PR.
//
// New, flavour-independent capabilities (they never change a result):
//   - `db.oplog`: one entry per write (and, with `recordReads`, per read),
//     appended when a chain RESOLVES (then/single/maybeSingle), not when built.
//   - `db.snapshot()`: stable-sorted deep copy of every table.
//   - `db.auth.getUser(jwt)` over the `auth.users` table; `db.seedUser`.
//   - `db.seedApiKey(userId, key)`: stores sha256(key) the way
//     apps/cloud/src/lib/api-keys.ts `hashKey` (line 14-16) does; that function
//     is not exported and its module imports @supabase/supabase-js, so it is
//     replicated here rather than imported.
//   - `clock` and `nextId` injection. Nothing in this file reads Date.now()
//     or Math.random().

import { createHash } from "node:crypto";

// biome-ignore lint/suspicious/noExplicitAny: a test-fixture row is intentionally loosely typed (it stands in for arbitrary table columns)
export type Row = Record<string, any>;
export type DbError = { message: string; code?: string; details?: string | null; hint?: string | null };
export type RpcHandler = (args: Record<string, unknown>) => { data: unknown; error: DbError | null };
export interface ExecResult {
  data: unknown;
  error: DbError | null;
  count?: number;
}

export type OpKind = "insert" | "upsert" | "update" | "delete" | "rpc" | "select";
export interface Op {
  seq: number;
  table: string;
  op: OpKind;
  filters?: string[];
  payload: unknown;
  onConflict?: string;
}

/**
 * - `memory`: lib/memory's fake. Inserts are dropped (only `onInsert` sees
 *   them); `.or()` is recorded on `orFilters`, not applied; no `.single()`.
 * - `code-sessions`: lib/code-sessions' fake. DB_MAX_ROWS clamp, `.or()`
 *   eq/neq terms applied, empty `.single()` errors, count/head.
 * - `kg`: lib/kg's fake. Ids from a module-level counter (`ids: "global"`),
 *   `.order()`/`.limit()`/`.or()`/`.not()` ignored, selects return copies,
 *   upsert keys on `user_id`, no `.delete()`, client has no `.rpc`.
 * - `db`: the forward default: code-sessions storage (clamp, count/head,
 *   stamped inserts) with PostgREST semantics: `col->k`/`col->>k` paths in
 *   filters, `.order()` and the `.select()` list (aliases projected; `*` or an
 *   embedded resource returns whole rows); `.order()` calls accumulate with
 *   Postgres null placement; `.or()` is a real logic tree (`and(...)`, dotted
 *   values, quoted values); `ignoreDuplicates` is DO NOTHING; `.single()` on
 *   0 or 2+ rows and `.maybeSingle()` on 2+ return PGRST116. Auth on the
 *   client, deterministic clock and ids.
 */
export type Flavour = "memory" | "code-sessions" | "kg" | "db";

export interface FakeDbOptions {
  flavour?: Flavour;
  /** Initial tables. `memory` keeps the object and arrays by reference; the others copy rows. */
  tables?: Record<string, Row[]>;
  /** Named rpc handlers (memory and db flavours). */
  rpc?: Record<string, RpcHandler>;
  /** Called for every row passed to `.insert()` (memory flavour's only observation hook). */
  onInsert?: (table: string, row: Row) => void;
  /** ISO timestamp source for stamped `created_at`. Default: a fixed instant. */
  clock?: () => string;
  /** Id source for rows inserted without an id. Default depends on flavour, always deterministic. */
  nextId?: (table: string) => string;
  /** Also log reads (`op: "select"`). Off by default: read-order changes are allowed when output is unchanged. */
  recordReads?: boolean;
}

// Real PostgREST caps a single response at ~1000 rows (db-max-rows). Kept in
// sync with apps/cloud/src/lib/kg/pagination.ts's PAGE_SIZE by literal value.
export const DB_MAX_ROWS = 1000;
export const FIXED_CLOCK_ISO = "2026-01-01T00:00:00.000Z";
const AUTH_USERS = "auth.users";

// The kg flavour's ids came from a module-level counter, so generated ids
// depended on test order within a file. Kept for that flavour only.
let globalIdSeq = 0;

const ALL_METHODS = [
  "select",
  "insert",
  "update",
  "upsert",
  "delete",
  "eq",
  "neq",
  "is",
  "in",
  "gt",
  "gte",
  "lt",
  "lte",
  "like",
  "ilike",
  "contains",
  "not",
  "or",
  "textSearch",
  "order",
  "limit",
  "range",
  "single",
  "maybeSingle",
] as const;
type Method = (typeof ALL_METHODS)[number];

/** Builder methods each flavour exposes. A method outside the set is `undefined`, as it was on the old fake. */
const SURFACE: Record<Flavour, ReadonlySet<Method>> = {
  memory: new Set<Method>([
    "select",
    "insert",
    "update",
    "upsert",
    "delete",
    "eq",
    "is",
    "in",
    "gte",
    "contains",
    "not",
    "or",
    "order",
    "limit",
    "range",
    "maybeSingle",
  ]),
  "code-sessions": new Set<Method>([
    "select",
    "insert",
    "update",
    "upsert",
    "delete",
    "eq",
    "is",
    "in",
    "gte",
    "lte",
    "or",
    "order",
    "limit",
    "range",
    "single",
    "maybeSingle",
  ]),
  kg: new Set<Method>([
    "select",
    "insert",
    "update",
    "upsert",
    "eq",
    "is",
    "in",
    "or",
    "not",
    "textSearch",
    "order",
    "limit",
    "range",
    "single",
    "maybeSingle",
  ]),
  db: new Set<Method>(ALL_METHODS),
};

type Filter =
  | { op: "eq" | "neq" | "is" | "gt" | "gte" | "lt" | "lte" | "like" | "ilike"; col: string; val: unknown }
  | { op: "in" | "contains"; col: string; val: unknown[] }
  | { op: "not"; col: string; operator: string; val: unknown }
  | { op: "or"; expr: string };

function describeFilter(f: Filter): string {
  if (f.op === "or") return `or(${f.expr})`;
  if (f.op === "not") return `not.${f.col}.${f.operator}=${JSON.stringify(f.val)}`;
  return `${f.op}.${f.col}=${JSON.stringify(f.val)}`;
}

function uuidFromCounter(n: number): string {
  return `fa4e0000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

/** sha256 hex, byte-for-byte the same as apps/cloud/src/lib/api-keys.ts:14-16 `hashKey`. */
export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export class FakeDb {
  readonly flavour: Flavour;
  /** Live table storage. Tests may read and mutate it directly. */
  tables: Record<string, Row[]>;
  readonly oplog: Op[] = [];
  readonly recordReads: boolean;
  readonly clock: () => string;
  readonly rpcHandlers: Record<string, RpcHandler>;
  readonly onInsert?: (table: string, row: Row) => void;
  private readonly idSource?: (table: string) => string;
  private idCounter = 0;
  private opSeq = 0;
  // biome-ignore lint/suspicious/noExplicitAny: test double, cast to SupabaseClient at call sites
  private clientCache: any;

  constructor(opts: FakeDbOptions = {}) {
    this.flavour = opts.flavour ?? "db";
    const initial = opts.tables ?? {};
    if (this.flavour === "memory") {
      this.tables = initial;
    } else {
      this.tables = {};
      for (const [t, rows] of Object.entries(initial)) this.tables[t] = rows.map((r) => ({ ...r }));
    }
    this.rpcHandlers = opts.rpc ?? {};
    this.onInsert = opts.onInsert;
    this.clock = opts.clock ?? (() => FIXED_CLOCK_ISO);
    this.idSource = opts.nextId;
    this.recordReads = opts.recordReads ?? false;
  }

  // --- storage -------------------------------------------------------------

  /** The table's live array, created when missing. */
  getRows(table: string): Row[] {
    this.tables[table] ??= [];
    return this.tables[table];
  }

  setRows(table: string, rows: Row[]): void {
    this.tables[table] = rows;
  }

  /** Appends shallow copies of `rows`. */
  seed(table: string, rows: Row[]): void {
    this.getRows(table).push(...rows.map((r) => ({ ...r })));
  }

  /** Rows a builder reads from. The memory flavour never created a missing table: it read a throwaway `[]`. */
  tableFor(table: string): Row[] {
    if (this.flavour === "memory") return this.tables[table] ?? [];
    return this.getRows(table);
  }

  /** Next generated id for a row inserted without one. */
  nextId(table: string): string {
    if (this.idSource) return this.idSource(table);
    if (this.flavour === "kg") {
      globalIdSeq += 1;
      return `${table}-${globalIdSeq}`;
    }
    this.idCounter += 1;
    if (this.flavour === "memory") return `fake-${this.tableFor(table).length}-${this.idCounter}`;
    return uuidFromCounter(this.idCounter);
  }

  // --- op log --------------------------------------------------------------

  log(entry: Omit<Op, "seq">): void {
    if (entry.op === "select" && !this.recordReads) return;
    this.opSeq += 1;
    const op: Op = { seq: this.opSeq, table: entry.table, op: entry.op, payload: clone(entry.payload) };
    if (entry.filters && entry.filters.length > 0) op.filters = [...entry.filters];
    if (entry.onConflict !== undefined) op.onConflict = entry.onConflict;
    this.oplog.push(op);
  }

  /** Stable-sorted deep copy of every table: tables by name, rows by id then by their JSON. */
  snapshot(): Record<string, Row[]> {
    const out: Record<string, Row[]> = {};
    for (const name of Object.keys(this.tables).sort()) {
      const rows = this.tables[name].map((r) => sortKeys(clone(r)) as Row);
      rows.sort((a, b) => {
        const ai = a.id === undefined ? "" : String(a.id);
        const bi = b.id === undefined ? "" : String(b.id);
        if (ai !== bi) return ai < bi ? -1 : 1;
        const aj = JSON.stringify(a);
        const bj = JSON.stringify(b);
        return aj < bj ? -1 : aj > bj ? 1 : 0;
      });
      out[name] = rows;
    }
    return out;
  }

  // --- query entry points --------------------------------------------------

  from(table: string): FakeQuery {
    return new FakeQuery(this, table);
  }

  rpc(name: string, args: Record<string, unknown>): Promise<ExecResult> {
    this.log({ table: name, op: "rpc", payload: args });
    const handler = this.rpcHandlers[name];
    if (name === "code_session_props_patch" && (this.flavour === "code-sessions" || !handler)) {
      return Promise.resolve(this.propsPatch(args));
    }
    if (name === "import_code_session_turns" && (this.flavour === "code-sessions" || !handler)) {
      return Promise.resolve(this.importTurns(args));
    }
    if (this.flavour === "code-sessions") {
      return Promise.resolve({ data: null, error: { message: `no fake rpc ${name}` } });
    }
    if (!handler) return Promise.resolve({ data: null, error: { message: `no fake rpc handler for ${name}` } });
    return Promise.resolve(handler(args));
  }

  /** Migration 109: props = (props - p_remove) || p_set, on the live row. */
  private propsPatch(args: Record<string, unknown>): ExecResult {
    const rows = this.flavour === "memory" ? (this.tables.code_sessions ?? []) : this.getRows("code_sessions");
    const row = rows.find((r) => r.id === args.p_session_id && r.user_id === args.p_user_id);
    const applies = !!row && propsPatchApplies(row.props, args);
    if (row && applies) {
      const next: Row = { ...((row.props as Row | null) ?? {}) };
      for (const k of (args.p_remove as string[] | undefined) ?? []) delete next[k];
      Object.assign(next, (args.p_set as Row | undefined) ?? {});
      row.props = next;
    }
    return { data: applies, error: null };
  }

  /**
   * Migration 112: replace one session's turns in one transaction. Every check
   * runs before any row changes, so a failed call leaves the old turns intact.
   */
  private importTurns(args: Record<string, unknown>): ExecResult {
    const tableRows = (t: string) => (this.flavour === "memory" ? (this.tables[t] ?? []) : this.getRows(t));
    const userId = args.p_user_id;
    const sessionId = args.p_session_id;
    const owned = tableRows("code_sessions").some((r) => r.id === sessionId && r.user_id === userId);
    if (!owned) {
      return { data: null, error: { message: `code session ${String(sessionId)} not found for user`, code: "P0001" } };
    }
    const turns = args.p_turns;
    if (!Array.isArray(turns)) {
      return { data: null, error: { message: "p_turns must be a jsonb array", code: "P0001" } };
    }
    const seen = new Set<number>();
    for (const t of turns as Row[]) {
      if (!Number.isInteger(t?.idx)) return { data: null, error: { message: "invalid idx", code: "22P02" } };
      if (t.ts != null && Number.isNaN(Date.parse(t.ts))) {
        return { data: null, error: { message: `invalid input syntax for type timestamp: "${t.ts}"`, code: "22007" } };
      }
      if (t.role == null || t.kind == null) {
        return { data: null, error: { message: "null value in column violates not-null constraint", code: "23502" } };
      }
      if (seen.has(t.idx)) {
        return {
          data: null,
          error: {
            message: 'duplicate key value violates unique constraint "code_session_turns_session_id_idx_key"',
            code: "23505",
          },
        };
      }
      seen.add(t.idx);
    }
    const kept = tableRows("code_session_turns").filter((r) => !(r.session_id === sessionId && r.user_id === userId));
    const inserted = (turns as Row[]).map((t) => ({
      id: this.nextId("code_session_turns"),
      created_at: this.clock(),
      user_id: userId,
      session_id: sessionId,
      idx: t.idx,
      role: t.role ?? null,
      kind: t.kind ?? null,
      text: t.text ?? null,
      tool_name: t.tool_name ?? null,
      file_path: t.file_path ?? null,
      ts: t.ts ?? null,
      props: t.props ?? {},
    }));
    this.setRows("code_session_turns", [...kept, ...inserted]);
    return { data: inserted.length, error: null };
  }

  // --- auth ----------------------------------------------------------------

  /** Adds a user to `auth.users`; `jwt` defaults to `jwt-<id>`. Returns the jwt. */
  seedUser(user: { id: string; email?: string; jwt?: string }): string {
    const jwt = user.jwt ?? `jwt-${user.id}`;
    this.getRows(AUTH_USERS).push({ id: user.id, email: user.email ?? null, jwt });
    return jwt;
  }

  readonly auth = {
    getUser: async (jwt?: string) => {
      const row = jwt === undefined ? undefined : this.getRows(AUTH_USERS).find((u) => u.jwt === jwt);
      if (!row) return { data: { user: null }, error: { message: "invalid JWT" } };
      return { data: { user: { id: row.id, email: row.email } }, error: null };
    },
  };

  /** Stores sha256(key) on the user's `profiles` row (`api_key_hash`), as `generateApiKey` persists it. Returns the hash. */
  seedApiKey(userId: string, key: string): string {
    const hash = hashApiKey(key);
    const profiles = this.getRows("profiles");
    const existing = profiles.find((p) => p.id === userId);
    if (existing) existing.api_key_hash = hash;
    else
      profiles.push({
        id: userId,
        api_key_hash: hash,
        api_key_scope_node_id: null,
        api_key_scope_code_project_id: null,
      });
    return hash;
  }

  // --- client shapes -------------------------------------------------------

  /**
   * The object handed to code under test, shaped like the flavour's old client:
   * memory and code-sessions `{from, rpc}`, kg `{from}`, db `{from, rpc, auth}`.
   */
  // biome-ignore lint/suspicious/noExplicitAny: test double, cast to SupabaseClient at call sites
  get client(): any {
    if (!this.clientCache) {
      const c: Record<string, unknown> = { from: (t: string) => this.from(t) };
      if (this.flavour !== "kg") c.rpc = (name: string, args: Record<string, unknown>) => this.rpc(name, args);
      if (this.flavour === "db") c.auth = this.auth;
      this.clientCache = c;
    }
    return this.clientCache;
  }

  /** Alias of `client` under the kg fake's old property name. */
  // biome-ignore lint/suspicious/noExplicitAny: test double, cast to SupabaseClient at call sites
  get supabase(): any {
    return this.client;
  }

  /** The code-sessions fake's client: a fresh `{from, rpc}` object per call, as before. */
  // biome-ignore lint/suspicious/noExplicitAny: test double, cast to SupabaseClient at call sites
  asClient(): any {
    return {
      from: (t: string) => this.from(t),
      rpc: (name: string, args: Record<string, unknown>) => this.rpc(name, args),
    };
  }
}

export function createFakeDb(opts: FakeDbOptions = {}): FakeDb {
  return new FakeDb(opts);
}

type WriteOp = "insert" | "update" | "upsert" | "delete";

export class FakeQuery implements PromiseLike<ExecResult> {
  /** Memory flavour: `.or()` expressions, recorded (not applied) so a test can assert the string. */
  public orFilters: string[] = [];
  private op: WriteOp | "select" | null = null;
  private selectAfterWrite = false;
  private countOpt: string | undefined;
  private headOpt = false;
  private filters: Filter[] = [];
  private payload: Row | Row[] | null = null;
  private updatePatch: Row | null = null;
  private deleteFlag = false;
  private onConflict: string | undefined;
  private orderSpec: { col: string; ascending: boolean } | null = null;
  /** db flavour: every `.order()` call, first one primary. */
  private orderSpecs: OrderSpec[] = [];
  /** db flavour: the `.select()` column list, projected on resolve. */
  private selectCols: string | undefined;
  private ignoreDuplicates = false;
  private rangeSpec: { from: number; to: number } | null = null;
  private limitSpec: number | null = null;
  /** Read-log only: order/limit/range/count/single/maybeSingle modifiers in call order (never affects results). */
  private modifiers: string[] = [];
  private memoryUpsertResult: Row[] | null = null;
  private kgInsertedRows: Row[] = [];
  /** Memory flavour: the table array captured when the chain was built (a throwaway `[]` for a missing table). */
  private memoryRows: Row[] | null = null;

  constructor(
    private db: FakeDb,
    private table: string,
  ) {
    if (db.flavour === "memory") this.memoryRows = db.tableFor(table);
    const surface = SURFACE[db.flavour];
    for (const m of ALL_METHODS) {
      if (!surface.has(m)) Object.defineProperty(this, m, { value: undefined, enumerable: false });
    }
  }

  private get flavour(): Flavour {
    return this.db.flavour;
  }

  // --- chain builders ------------------------------------------------------

  select(cols?: string, opts?: { count?: string; head?: boolean }): this {
    this.selectCols = cols;
    if (this.flavour === "kg") {
      if (this.op !== "insert") this.op = "select";
    } else if (this.op === "insert" || this.op === "update" || this.op === "upsert" || this.op === "delete") {
      this.selectAfterWrite = true;
    } else {
      this.op = "select";
    }
    if (opts?.count) this.countOpt = opts.count;
    if (opts?.head) this.headOpt = true;
    if (opts?.count || opts?.head)
      this.modifiers.push(["count", opts.count ?? "none", ...(opts.head ? ["head"] : [])].join("."));
    return this;
  }

  // Returns `this` except in the memory flavour, whose insert resolved at once and stored nothing.
  insert(row: Row | Row[]): this {
    if (this.flavour === "memory") {
      const list = Array.isArray(row) ? row : [row];
      this.db.log({ table: this.table, op: "insert", payload: row });
      for (const r of list) this.db.onInsert?.(this.table, r);
      return Promise.resolve({ data: null, error: null }) as unknown as this;
    }
    this.op = "insert";
    this.payload = row;
    return this;
  }

  update(patch: Row): this {
    this.op = "update";
    this.payload = patch;
    this.updatePatch = patch;
    return this;
  }

  upsert(row: Row | Row[], opts?: { onConflict?: string; ignoreDuplicates?: boolean }): this {
    this.op = "upsert";
    this.payload = row;
    this.onConflict = opts?.onConflict;
    this.ignoreDuplicates = opts?.ignoreDuplicates === true;
    // The memory flavour applied an upsert when it was built, not when it resolved.
    if (this.flavour === "memory") this.memoryUpsertResult = this.applyMemoryUpsert();
    return this;
  }

  delete(): this {
    this.op = "delete";
    this.deleteFlag = true;
    return this;
  }

  eq(col: string, val: unknown): this {
    this.filters.push({ op: "eq", col, val });
    return this;
  }

  neq(col: string, val: unknown): this {
    this.filters.push({ op: "neq", col, val });
    return this;
  }

  gt(col: string, val: unknown): this {
    this.filters.push({ op: "gt", col, val });
    return this;
  }

  lt(col: string, val: unknown): this {
    this.filters.push({ op: "lt", col, val });
    return this;
  }

  like(col: string, val: unknown): this {
    this.filters.push({ op: "like", col, val });
    return this;
  }

  ilike(col: string, val: unknown): this {
    this.filters.push({ op: "ilike", col, val });
    return this;
  }

  is(col: string, val: unknown): this {
    this.filters.push({ op: "is", col, val });
    return this;
  }

  in(col: string, vals: unknown[]): this {
    this.filters.push({ op: "in", col, val: vals });
    return this;
  }

  gte(col: string, val: unknown): this {
    this.filters.push({ op: "gte", col, val });
    return this;
  }

  lte(col: string, val: unknown): this {
    this.filters.push({ op: "lte", col, val });
    return this;
  }

  contains(col: string, vals: unknown[]): this {
    this.filters.push({ op: "contains", col, val: vals });
    return this;
  }

  not(col: string, operator: string, val: unknown): this {
    this.filters.push({ op: "not", col, operator, val });
    return this;
  }

  or(expr: string): this {
    if (this.flavour === "memory") this.orFilters.push(expr);
    this.filters.push({ op: "or", expr });
    return this;
  }

  textSearch(..._args: unknown[]): this {
    return this;
  }

  order(col: string, opts?: { ascending?: boolean; nullsFirst?: boolean }): this {
    const ascending = opts?.ascending ?? true;
    this.orderSpec = { col, ascending };
    // Postgres default: NULLS LAST ascending, NULLS FIRST descending.
    this.orderSpecs.push({ col, ascending, nullsFirst: opts?.nullsFirst ?? !ascending });
    const nulls = opts?.nullsFirst === true ? ".nullsfirst" : opts?.nullsFirst === false ? ".nullslast" : "";
    this.modifiers.push(`order.${col}.${ascending ? "asc" : "desc"}${nulls}`);
    return this;
  }

  limit(n: number): this {
    this.limitSpec = n;
    this.modifiers.push(`limit.${n}`);
    return this;
  }

  range(from: number, to: number): this {
    this.rangeSpec = { from, to };
    this.modifiers.push(`range.${from}.${to}`);
    return this;
  }

  // --- terminals -----------------------------------------------------------

  single(): Promise<ExecResult> {
    return this.settle("single");
  }

  maybeSingle(): Promise<ExecResult> {
    return this.settle("maybeSingle");
  }

  private settle(terminal: "single" | "maybeSingle"): Promise<ExecResult> {
    this.modifiers.push(terminal);
    try {
      return Promise.resolve(this.resolve(terminal));
    } catch (err) {
      return Promise.reject(err);
    }
  }

  // biome-ignore lint/suspicious/noThenProperty: this class deliberately implements PromiseLike so `await supabase.from(...).eq(...)` (no terminal .select()/.single() call) resolves, exactly like the real supabase-js query builder
  then<TResult1 = ExecResult, TResult2 = never>(
    onfulfilled?: ((value: ExecResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    let result: ExecResult;
    try {
      result = this.resolve("then");
    } catch (err) {
      return Promise.reject(err).then(onfulfilled, onrejected);
    }
    return Promise.resolve(result).then(onfulfilled, onrejected);
  }

  // --- resolution ----------------------------------------------------------

  private resolve(terminal: "then" | "single" | "maybeSingle"): ExecResult {
    if (this.flavour === "memory") return this.resolveMemory(terminal);
    if (this.flavour === "kg") return this.resolveKg(terminal);
    return this.resolveCodeSessions(terminal);
  }

  private logResolved(op: OpKind): void {
    this.db.log({
      table: this.table,
      op,
      filters: this.filters.map(describeFilter),
      payload:
        op === "select"
          ? { columns: this.selectCols ?? "*", modifiers: [...this.modifiers] }
          : op === "delete"
            ? null
            : this.payload,
      onConflict: op === "upsert" ? this.onConflict : undefined,
    });
  }

  private matches(row: Row): boolean {
    const fl = this.flavour;
    if (fl === "db") return this.filters.every((f) => dbFilterMatches(row, f));
    return this.filters.every((f) => {
      switch (f.op) {
        case "eq":
          return row[f.col] === f.val;
        case "is":
          return fl === "kg" ? row[f.col] === f.val : (row[f.col] ?? null) === f.val;
        case "in":
          return f.val.includes(row[f.col]);
        case "gte":
          if (fl === "memory") {
            if (row[f.col] === null || row[f.col] === undefined) return false;
          }
          return row[f.col] >= (f.val as never);
        case "lte":
          return row[f.col] <= (f.val as never);
        case "contains":
          return Array.isArray(row[f.col]) && f.val.every((v) => (row[f.col] as unknown[]).includes(v));
        case "not":
          if (fl === "kg") return true;
          if (f.operator === "is" && f.val === null) return (row[f.col] ?? null) !== null;
          return true;
        case "or":
          // memory recorded it only; kg ignored it; code-sessions applies eq/neq terms (db: dbFilterMatches).
          if (fl === "memory" || fl === "kg") return true;
          return f.expr.split(",").some((term) => {
            const [col, op, v] = term.split(".");
            return op === "neq" ? String(row[col]) !== v : String(row[col]) === v;
          });
      }
    });
  }

  // memory flavour: filter -> update -> delete -> order -> limit -> range, live rows.
  private resolveMemory(terminal: "then" | "single" | "maybeSingle"): ExecResult {
    const rows = this.memoryRows as Row[];
    let out: Row[];
    if (this.memoryUpsertResult) {
      this.logResolved("upsert");
      out = this.memoryUpsertResult;
    } else {
      this.logResolved(this.deleteFlag ? "delete" : this.updatePatch ? "update" : "select");
      out = rows.filter((r) => this.matches(r));
      if (this.updatePatch) for (const r of out) Object.assign(r, this.updatePatch);
      if (this.deleteFlag) for (const r of out) rows.splice(rows.indexOf(r), 1);
      if (this.orderSpec) {
        const { col, ascending } = this.orderSpec;
        out = [...out].sort((a, b) => {
          if (a[col] === b[col]) return 0;
          const lt = a[col] < b[col];
          return ascending ? (lt ? -1 : 1) : lt ? 1 : -1;
        });
      }
      if (this.limitSpec != null) out = out.slice(0, this.limitSpec);
      if (this.rangeSpec) out = out.slice(this.rangeSpec.from, this.rangeSpec.to + 1);
    }
    if (terminal === "maybeSingle") return { data: out[0] ?? null, error: null };
    return { data: out, error: null };
  }

  private applyMemoryUpsert(): Row[] {
    const rows = this.memoryRows as Row[];
    const conflictCols = this.onConflict?.split(",").map((c) => c.trim()) ?? [];
    const list = Array.isArray(this.payload) ? this.payload : this.payload ? [this.payload] : [];
    const result: Row[] = [];
    for (const row of list) {
      const existing =
        conflictCols.length > 0 ? rows.find((r) => conflictCols.every((c) => r[c] === row[c])) : undefined;
      if (existing) {
        Object.assign(existing, row);
        result.push(existing);
      } else {
        const withId = row.id ? row : { ...row, id: this.db.nextId(this.table) };
        rows.push(withId);
        result.push(withId);
      }
    }
    return result;
  }

  // kg flavour: no order/limit, selects return copies, upsert keyed on user_id.
  private resolveKg(terminal: "then" | "single" | "maybeSingle"): ExecResult {
    const rows = this.db.getRows(this.table);
    const list = (): Row[] => (Array.isArray(this.payload) ? this.payload : this.payload ? [this.payload] : []);
    const applyInsert = (): Row[] => {
      this.logResolved("insert");
      const created = list().map((r) => ({ id: r.id ?? this.db.nextId(this.table), ...r }));
      rows.push(...created);
      return created;
    };
    const runSelect = (): { data: Row[]; count: number } => {
      this.logResolved("select");
      let data = rows.filter((r) => this.matches(r));
      const count = data.length;
      if (this.rangeSpec) data = data.slice(this.rangeSpec.from, this.rangeSpec.to + 1);
      return { data: this.headOpt ? [] : data.map((r) => ({ ...r })), count };
    };

    if (terminal === "single") {
      if (this.op === "insert") {
        const r = this.kgInsertedRows[0] ?? applyInsert()[0];
        return { data: r ? { ...r } : null, error: null };
      }
      return { data: runSelect().data[0] ?? null, error: null };
    }
    if (terminal === "maybeSingle") return { data: runSelect().data[0] ?? null, error: null };

    if (this.op === "insert") {
      this.kgInsertedRows = applyInsert();
      return { data: this.kgInsertedRows.map((r) => ({ ...r })), error: null };
    }
    if (this.op === "update") {
      this.logResolved("update");
      const updated: Row[] = [];
      for (const row of rows) {
        if (this.matches(row)) {
          Object.assign(row, (this.payload ?? {}) as Row);
          updated.push(row);
        }
      }
      return { data: updated.map((r) => ({ ...r })), error: null };
    }
    if (this.op === "upsert") {
      this.logResolved("upsert");
      const created: Row[] = [];
      for (const r of list()) {
        const existing = rows.find((x) => x.user_id === r.user_id);
        if (existing) Object.assign(existing, r);
        else {
          const row = { id: r.id ?? this.db.nextId(this.table), ...r };
          rows.push(row);
          created.push(row);
        }
      }
      return { data: created.map((r) => ({ ...r })), error: null };
    }
    const { data, count } = runSelect();
    return { data, error: null, count };
  }

  /** db flavour: project the select list, then apply PostgREST's single/maybeSingle row-count rules. */
  private dbShape(rows: Row[], terminal: "then" | "single" | "maybeSingle"): ExecResult {
    const out = projectRows(rows, this.selectCols);
    if (terminal === "then") return { data: out, error: null };
    if (out.length === 1) return { data: out[0], error: null };
    if (out.length === 0 && terminal === "maybeSingle") return { data: null, error: null };
    return {
      data: null,
      error: {
        code: "PGRST116",
        message: "JSON object requested, multiple (or no) rows returned",
        details: `The result contains ${out.length} rows`,
        hint: null,
      },
    };
  }

  // code-sessions and db flavours: DB_MAX_ROWS clamp, count/head, stamped inserts.
  private resolveCodeSessions(terminal: "then" | "single" | "maybeSingle"): ExecResult {
    const wantSingle = terminal === "single";
    const wantMaybeSingle = terminal === "maybeSingle";
    const rows = this.db.getRows(this.table);
    const op = this.op ?? "select";

    if (op === "select") {
      this.logResolved("select");
      const filtered = rows.filter((r) => this.matches(r));
      const totalCount = filtered.length;
      let ordered = filtered;
      if (this.flavour === "db") {
        if (this.orderSpecs.length > 0) ordered = [...filtered].sort((a, b) => dbOrderCompare(a, b, this.orderSpecs));
      } else if (this.orderSpec) {
        const { col, ascending } = this.orderSpec;
        ordered = [...filtered].sort((a, b) => {
          const av = a[col] as string | number | null | undefined;
          const bv = b[col] as string | number | null | undefined;
          if (av === bv) return 0;
          if (av === undefined || av === null) return ascending ? -1 : 1;
          if (bv === undefined || bv === null) return ascending ? 1 : -1;
          const cmp = av < bv ? -1 : av > bv ? 1 : 0;
          return ascending ? cmp : -cmp;
        });
      }
      let matched: Row[];
      if (this.rangeSpec) {
        const to = Math.min(this.rangeSpec.to, this.rangeSpec.from + DB_MAX_ROWS - 1);
        matched = ordered.slice(this.rangeSpec.from, to + 1);
      } else if (this.limitSpec != null) {
        matched = ordered.slice(0, this.limitSpec);
      } else {
        matched = ordered.slice(0, DB_MAX_ROWS);
      }
      if (this.headOpt && this.countOpt) return { data: null, error: null, count: totalCount };
      if (this.flavour === "db") return this.dbShape(matched, terminal);
      if (wantMaybeSingle) return { data: matched[0] ?? null, error: null };
      if (wantSingle) {
        return matched[0] ? { data: matched[0], error: null } : { data: null, error: { message: "no rows" } };
      }
      return { data: matched, error: null };
    }

    const incoming = Array.isArray(this.payload) ? this.payload : this.payload ? [this.payload] : [];

    if (op === "insert") {
      this.logResolved("insert");
      const inserted = incoming.map((r) => ({ id: this.db.nextId(this.table), created_at: this.db.clock(), ...r }));
      rows.push(...inserted);
      if (this.flavour === "db" && this.selectAfterWrite) return this.dbShape(inserted, terminal);
      if (wantSingle) return { data: inserted[0] ?? null, error: null };
      if (this.selectAfterWrite) return { data: inserted, error: null };
      return { data: null, error: null };
    }

    if (op === "update") {
      this.logResolved("update");
      const matched = rows.filter((r) => this.matches(r));
      for (const r of matched) Object.assign(r, this.payload as Row);
      if (this.flavour === "db" && this.selectAfterWrite) return this.dbShape(matched, terminal);
      if (wantSingle) return { data: matched[0] ?? null, error: null };
      if (this.selectAfterWrite) return { data: matched, error: null };
      return { data: null, error: null };
    }

    if (op === "upsert") {
      this.logResolved("upsert");
      const cols = this.onConflict ? this.onConflict.split(",").map((s) => s.trim()) : [];
      // db flavour, ON CONFLICT DO NOTHING: a conflicting row (stored, or earlier in this call) is skipped, never an error.
      if (this.flavour === "db" && this.ignoreDuplicates) {
        const keyCols = cols.length > 0 ? cols : ["id"];
        const inserted: Row[] = [];
        for (const r of incoming) {
          if (rows.some((row) => keyCols.every((c) => row[c] === r[c]))) continue;
          const row = { id: this.db.nextId(this.table), created_at: this.db.clock(), ...r };
          rows.push(row);
          inserted.push(row);
        }
        if (this.selectAfterWrite) return this.dbShape(inserted, terminal);
        if (wantSingle) return { data: inserted[0] ?? null, error: null };
        return { data: null, error: null };
      }
      // Mirror Postgres: two rows of ONE upsert sharing the conflict key fail the statement (SQLSTATE 21000).
      if (cols.length > 0) {
        const seen = new Set<string>();
        for (const r of incoming) {
          const k = JSON.stringify(cols.map((c) => r[c]));
          if (seen.has(k)) {
            return { data: null, error: { message: "ON CONFLICT DO UPDATE command cannot affect row a second time" } };
          }
          seen.add(k);
        }
      }
      const affected: Row[] = [];
      for (const r of incoming) {
        const existing = cols.length > 0 ? rows.find((row) => cols.every((c) => row[c] === r[c])) : undefined;
        if (existing) {
          Object.assign(existing, r);
          affected.push(existing);
        } else {
          const inserted = { id: this.db.nextId(this.table), created_at: this.db.clock(), ...r };
          rows.push(inserted);
          affected.push(inserted);
        }
      }
      if (this.flavour === "db" && this.selectAfterWrite) return this.dbShape(affected, terminal);
      if (wantSingle) return { data: affected[0] ?? null, error: null };
      if (this.selectAfterWrite) return { data: affected, error: null };
      return { data: null, error: null };
    }

    // delete: replaces the table's array (code-sessions semantics).
    this.logResolved("delete");
    if (this.flavour === "db" && this.selectAfterWrite) {
      const removed = rows.filter((r) => this.matches(r));
      this.db.setRows(
        this.table,
        rows.filter((r) => !this.matches(r)),
      );
      return this.dbShape(removed, terminal);
    }
    this.db.setRows(
      this.table,
      rows.filter((r) => !this.matches(r)),
    );
    return { data: null, error: null };
  }
}

/** Deep copy for the op log and snapshots; a value JSON cannot carry (BigInt, cycles) is kept by reference. */
function clone<T>(v: T): T {
  if (v === undefined) return v;
  try {
    return JSON.parse(JSON.stringify(v)) as T;
  } catch {
    return v;
  }
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort())
      out[k] = sortKeys((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}

/** jsonb `@>`: every key of `want` is in `have`, objects compared recursively. */
function jsonContains(have: unknown, want: unknown): boolean {
  if (want && typeof want === "object" && !Array.isArray(want)) {
    if (!have || typeof have !== "object" || Array.isArray(have)) return false;
    return Object.entries(want as Record<string, unknown>).every(([k, v]) =>
      jsonContains((have as Record<string, unknown>)[k], v),
    );
  }
  return JSON.stringify(have) === JSON.stringify(want);
}

/** Migration 109's guards: p_set must be an object; p_expect, when given, must be contained in props. */
function propsPatchApplies(props: unknown, args: Record<string, unknown>): boolean {
  const set = args.p_set;
  if (set !== undefined && set !== null && (typeof set !== "object" || Array.isArray(set))) return false;
  const expect = args.p_expect;
  if (expect === undefined || expect === null) return true;
  if (typeof expect !== "object" || Array.isArray(expect)) return false;
  return jsonContains(props ?? {}, expect);
}

// --- db flavour: PostgREST semantics ----------------------------------------

interface OrderSpec {
  col: string;
  ascending: boolean;
  nullsFirst: boolean;
}

/** `col->key` yields this for a key that is present with JSON null: jsonb 'null' is not SQL NULL. */
const JSON_NULL = Symbol("jsonb null");

/** Resolve `col`, `col->k` (json) and `col->>k` (text), any depth, as Postgres would. Missing -> SQL NULL. */
function resolveCol(row: Row, col: string): unknown {
  const expr = col.replace(/::\w+$/, "").trim();
  if (!expr.includes("->")) return row[expr];
  const parts = expr.split(/(->>?)/);
  let v: unknown = row[parts[0].trim()];
  let text = false;
  for (let i = 1; i < parts.length; i += 2) {
    const key = parts[i + 1].trim().replace(/^'(.*)'$/, "$1");
    if (v === null || v === undefined || v === JSON_NULL || typeof v !== "object") {
      v = undefined;
    } else if (Array.isArray(v)) {
      v = /^-?\d+$/.test(key) ? v.at(Number(key)) : undefined;
    } else {
      v = (v as Record<string, unknown>)[key];
    }
    text = parts[i] === "->>";
    if (v === undefined) return null;
    if (v === null) {
      if (text) return null;
      v = JSON_NULL;
    }
  }
  if (text && typeof v !== "string") return JSON.stringify(v);
  return v;
}

function isNull(v: unknown): v is null | undefined {
  return v === null || v === undefined;
}

const ISO_TS = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

/** Order two non-null values: numbers numerically, timestamps by instant, everything else by text. */
function compareValues(a: unknown, b: unknown): number {
  if (typeof a === "number" || typeof b === "number") {
    const an = Number(a);
    const bn = Number(b);
    if (!Number.isNaN(an) && !Number.isNaN(bn)) return an < bn ? -1 : an > bn ? 1 : 0;
  }
  if (typeof a === "string" && typeof b === "string" && ISO_TS.test(a) && ISO_TS.test(b)) {
    const at = Date.parse(a);
    const bt = Date.parse(b);
    if (!Number.isNaN(at) && !Number.isNaN(bt) && at !== bt) return at < bt ? -1 : 1;
    if (at === bt) return 0;
  }
  if (typeof a === "boolean" && typeof b === "boolean") return a === b ? 0 : a ? 1 : -1;
  const as = typeof a === "object" ? JSON.stringify(a) : String(a);
  const bs = typeof b === "object" ? JSON.stringify(b) : String(b);
  return as < bs ? -1 : as > bs ? 1 : 0;
}

/** Equality across the text boundary PostgREST puts between the client and the column. */
function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (isNull(a) || isNull(b) || a === JSON_NULL || b === JSON_NULL) return false;
  if (typeof a === "object" || typeof b === "object") return JSON.stringify(a) === JSON.stringify(b);
  if (typeof a === "number" || typeof b === "number") return compareValues(a, b) === 0;
  if (typeof a === "string" && typeof b === "string" && ISO_TS.test(a) && ISO_TS.test(b)) {
    return compareValues(a, b) === 0;
  }
  return String(a) === String(b);
}

function likeToRegExp(pattern: string, flags: string): RegExp {
  const body = pattern
    .split("")
    .map((ch) => (ch === "%" || ch === "*" ? ".*" : ch === "_" ? "." : ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("");
  return new RegExp(`^${body}$`, flags);
}

/** `(a,b)` / `("a","b")` -> ["a","b"]; arrays pass through. */
function parseList(val: unknown): unknown[] {
  if (Array.isArray(val)) return val;
  const s = String(val).trim().replace(/^\(/, "").replace(/\)$/, "");
  return splitTopLevel(s).map(unquote);
}

/** One comparison with SQL null semantics (a NULL operand is never true, except under IS). */
function applyOperator(op: string, v: unknown, want: unknown): boolean {
  switch (op) {
    case "is":
      return (v === JSON_NULL ? "jsonb" : (v ?? null)) === want;
    case "eq":
      // Kept from the pre-PostgREST fake: eq(col, null) matched a null column. Callers use .is() for that.
      if (isNull(v) || isNull(want)) return v === want;
      return valuesEqual(v, want);
    case "neq":
      return !isNull(v) && v !== JSON_NULL && !valuesEqual(v, want);
    case "in":
      if (isNull(v)) return parseList(want).includes(v);
      return parseList(want).some((w) => valuesEqual(v, w));
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      if (isNull(v) || v === JSON_NULL || isNull(want)) return false;
      const c = compareValues(v, want);
      return op === "gt" ? c > 0 : op === "gte" ? c >= 0 : op === "lt" ? c < 0 : c <= 0;
    }
    case "like":
    case "ilike":
      if (isNull(v) || v === JSON_NULL) return false;
      return likeToRegExp(String(want), op === "ilike" ? "i" : "").test(String(v));
    default:
      throw new Error(`fake-db: unsupported filter operator "${op}"`);
  }
}

function dbFilterMatches(row: Row, f: Filter): boolean {
  switch (f.op) {
    case "or":
      return parseOrTerms(f.expr).some((t) => orTermMatches(row, t));
    case "contains": {
      const v = resolveCol(row, f.col);
      return Array.isArray(v) && f.val.every((x) => v.includes(x));
    }
    case "not": {
      const v = resolveCol(row, f.col);
      if (f.operator === "is") return !applyOperator("is", v, f.val);
      if (isNull(v)) return false;
      return !applyOperator(f.operator, v, f.val);
    }
    default:
      return applyOperator(f.op, resolveCol(row, f.col), f.val);
  }
}

type OrTerm = { and: OrTerm[] } | { or: OrTerm[] } | { col: string; op: string; negate: boolean; val: unknown };

/** Split on commas outside parentheses and double quotes. */
function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quoted = false;
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"' && s[i - 1] !== "\\") quoted = !quoted;
    else if (!quoted && ch === "(") depth += 1;
    else if (!quoted && ch === ")") depth -= 1;
    if (ch === "," && depth === 0 && !quoted) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim() !== "") out.push(cur);
  return out.map((t) => t.trim());
}

function unquote(s: string): string {
  const t = s.trim();
  return t.length >= 2 && t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1).replace(/\\"/g, '"') : t;
}

/** PostgREST logic tree: `col.op.value` terms (value may contain dots), `not.` prefix, `and(...)` / `or(...)` groups. */
function parseOrTerms(expr: string): OrTerm[] {
  return splitTopLevel(expr).map(parseOrTerm);
}

function parseOrTerm(term: string): OrTerm {
  const group = /^(and|or)\((.*)\)$/s.exec(term);
  if (group) {
    const inner = parseOrTerms(group[2]);
    return group[1] === "and" ? { and: inner } : { or: inner };
  }
  const firstDot = term.indexOf(".");
  if (firstDot < 0) throw new Error(`fake-db: malformed or() term "${term}"`);
  const col = term.slice(0, firstDot);
  let rest = term.slice(firstDot + 1);
  let negate = false;
  if (rest.startsWith("not.")) {
    negate = true;
    rest = rest.slice(4);
  }
  const secondDot = rest.indexOf(".");
  if (secondDot < 0) throw new Error(`fake-db: malformed or() term "${term}"`);
  const op = rest.slice(0, secondDot);
  const raw = rest.slice(secondDot + 1);
  let val: unknown = op === "in" ? raw : unquote(raw);
  if (op === "is") val = raw === "null" ? null : raw === "true" ? true : raw === "false" ? false : raw;
  return { col, op, negate, val };
}

function orTermMatches(row: Row, t: OrTerm): boolean {
  if ("or" in t) return t.or.some((x) => orTermMatches(row, x));
  if ("and" in t) return t.and.every((x) => orTermMatches(row, x));
  const v = resolveCol(row, t.col);
  if (!t.negate) return applyOperator(t.op, v, t.val);
  if (t.op === "is") return !applyOperator("is", v, t.val);
  return !isNull(v) && !applyOperator(t.op, v, t.val);
}

function dbOrderCompare(a: Row, b: Row, specs: OrderSpec[]): number {
  for (const s of specs) {
    let av = resolveCol(a, s.col);
    let bv = resolveCol(b, s.col);
    if (av === JSON_NULL) av = null;
    if (bv === JSON_NULL) bv = null;
    const an = isNull(av);
    const bn = isNull(bv);
    if (an && bn) continue;
    if (an) return s.nullsFirst ? -1 : 1;
    if (bn) return s.nullsFirst ? 1 : -1;
    const c = compareValues(av, bv);
    if (c !== 0) return s.ascending ? c : -c;
  }
  return 0;
}

/**
 * Project a select list (`a, alias:props->usage, props->>kind`). A bare `*`,
 * no list, or any embedded resource (`foo(*)`) returns whole rows unchanged:
 * the fake has no foreign-key graph to embed from.
 */
function projectRows(rows: Row[], cols: string | undefined): Row[] {
  if (cols === undefined || cols.trim() === "") return rows;
  const items = splitTopLevel(cols);
  if (items.some((i) => i === "*" || i.includes("("))) return rows;
  const fields = items.map((item) => {
    const m = /^([A-Za-z_]\w*)\s*:(?!:)\s*(.+)$/.exec(item);
    const expr = (m ? m[2] : item).trim();
    const bare = expr.replace(/::\w+$/, "");
    const key = m
      ? m[1]
      : (bare
          .split(/->>?/)
          .pop()
          ?.trim()
          .replace(/^'(.*)'$/, "$1") ?? bare);
    return { key, expr };
  });
  return rows.map((row) => {
    const out: Row = {};
    for (const { key, expr } of fields) {
      const v = resolveCol(row, expr);
      out[key] = v === JSON_NULL || v === undefined ? null : v;
    }
    return out;
  });
}
