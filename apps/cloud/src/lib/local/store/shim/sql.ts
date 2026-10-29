// SQL generation for the in-process PostgREST shim. The rules that keep it injection-safe:
//   - every VALUE (filter operand, row data, rpc argument) goes through Params.add() and reaches the database as a
//     bound $n parameter, never as text in the statement;
//   - every IDENTIFIER (table, column, relationship, alias) is matched against a strict pattern and then quoted;
//   - JSON-path keys are validated by parseCol() against [A-Za-z0-9_-] before being inlined as '...' literals (a
//     parameter cannot be used there: `a ->> $1` leaves the operator ambiguous between text and int keys);
//   - the only other text that reaches a statement is fixed SQL and names read from the system catalogs.
import {
  type ColRef,
  type Cond,
  IDENT,
  type OrderTerm,
  type ParsedQuery,
  RestError,
  type SelectItem,
  unsupported,
} from "./parse";

/** Collects bound values; add() returns the placeholder to splice into the statement. */
export class Params {
  readonly values: unknown[] = [];
  add(v: unknown): string {
    this.values.push(v);
    return `$${this.values.length}`;
  }
  /** A bound value forced to text first, so the driver never applies a type serializer to it (`$1::text`). */
  text(v: string): string {
    return `(${this.add(v)}::text)`;
  }
}

export interface Built {
  sql: string;
  params: unknown[];
}

export function qi(name: string): string {
  if (!IDENT.test(name)) throw new RestError(400, "PGRST100", `Invalid identifier "${name}"`);
  return `"${name}"`;
}
const ALIAS = /^[A-Za-z_][A-Za-z0-9_]*$/;
function qa(name: string): string {
  if (!ALIAS.test(name)) throw new RestError(400, "PGRST100", `Invalid alias "${name}"`);
  return `"${name}"`;
}
/** A table in the public schema, always schema-qualified so a same-named object elsewhere is unreachable. */
export const tbl = (name: string) => `"public".${qi(name)}`;

export function colSql(col: ColRef, alias: string | null): string {
  let s = `${alias ? `${alias}.` : ""}${qi(col.name)}`;
  for (const step of col.path) {
    const key = /^\d+$/.test(step.key) ? step.key : `'${step.key}'`;
    s += `${step.text ? "->>" : "->"}${key}`;
  }
  return s;
}

// ---- conditions -----------------------------------------------------------------------------------------------

const CMP_SQL = {
  eq: "=",
  neq: "<>",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
  like: "like",
  ilike: "ilike",
  cs: "@>",
  cd: "<@",
  ov: "&&",
} as const;

export function condSql(c: Cond, alias: string | null, p: Params): string {
  let sql: string;
  switch (c.kind) {
    case "is":
      sql = `${colSql(c.col, alias)} is ${c.value}`;
      break;
    case "in":
      sql = c.values.length ? `${colSql(c.col, alias)} in (${c.values.map((v) => p.add(v)).join(", ")})` : "false";
      break;
    case "cmp":
      sql = `${colSql(c.col, alias)} ${CMP_SQL[c.op]} ${p.add(c.value)}`;
      break;
    case "fts": {
      const cfg = c.config ? `'${c.config}'::regconfig, ` : ""; // c.config matched [a-z_][a-z0-9_]* in the parser
      sql = `${colSql(c.col, alias)} @@ ${c.fn}(${cfg}${p.add(c.value)})`;
      break;
    }
    case "logic":
      sql = `(${c.items.map((i) => condSql(i, alias, p)).join(c.op === "and" ? " and " : " or ")})`;
      break;
  }
  return c.neg ? `not (${sql})` : sql;
}

export function orderSql(terms: OrderTerm[], alias: string | null): string {
  if (!terms.length) return "";
  return ` order by ${terms
    .map((t) => `${colSql(t.col, alias)}${t.desc ? " desc" : " asc"}${t.nulls ? ` nulls ${t.nulls}` : ""}`)
    .join(", ")}`;
}

// ---- relationships and projection -----------------------------------------------------------------------------

export interface Fk {
  src: string;
  srcCol: string;
  dst: string;
  dstCol: string;
  name: string;
}

export const FK_SQL = `select c.conname as name, s.relname as src, d.relname as dst,
  (select a.attname from pg_attribute a where a.attrelid = c.conrelid and a.attnum = c.conkey[1]) as src_col,
  (select a.attname from pg_attribute a where a.attrelid = c.confrelid and a.attnum = c.confkey[1]) as dst_col
  from pg_constraint c
  join pg_class s on s.oid = c.conrelid join pg_namespace sn on sn.oid = s.relnamespace and sn.nspname = 'public'
  join pg_class d on d.oid = c.confrelid join pg_namespace dn on dn.oid = d.relnamespace and dn.nspname = 'public'
  where c.contype = 'f' and array_length(c.conkey, 1) = 1`;

export function fkFromRow(r: Record<string, unknown>): Fk {
  return {
    name: String(r.name),
    src: String(r.src),
    srcCol: String(r.src_col),
    dst: String(r.dst),
    dstCol: String(r.dst_col),
  };
}

export const hasEmbed = (items: SelectItem[]): boolean => items.some((i) => i.kind === "embed");

interface Ctx {
  fks: Fk[];
  p: Params;
  q: ParsedQuery;
  used: Set<string>;
  aliasN: number;
}

function relation(ctx: Ctx, parent: string, rel: string, hint?: string) {
  const match = (f: Fk) => !hint || f.srcCol === hint || f.name === hint;
  const m2o = ctx.fks.filter((f) => f.src === parent && f.dst === rel && match(f));
  const o2m = ctx.fks.filter((f) => f.src === rel && f.dst === parent && match(f));
  const n = m2o.length + o2m.length;
  if (n === 0) {
    throw new RestError(
      400,
      "PGRST200",
      `Could not find a relationship between '${parent}' and '${rel}' in the schema cache`,
      "Only single-column foreign keys are supported",
    );
  }
  if (n > 1) {
    throw new RestError(
      300,
      "PGRST201",
      `More than one relationship was found for '${parent}' and '${rel}'`,
      null,
      "Disambiguate with !<column> or !<constraint>",
    );
  }
  const one = m2o[0];
  if (one) return { one: true, parentCol: one.srcCol, childCol: one.dstCol };
  const many = o2m[0] as Fk;
  return { one: false, parentCol: many.dstCol, childCol: many.srcCol };
}

function embeddedConds(ctx: Ctx, prefix: string, alias: string): string[] {
  const list = ctx.q.embedded.get(prefix);
  if (!list) return [];
  ctx.used.add(prefix);
  return list.map((c) => condSql(c, alias, ctx.p));
}

function nextAlias(ctx: Ctx, tag: string): string {
  return `${tag}${++ctx.aliasN}`;
}

function projection(ctx: Ctx, table: string, a: string, items: SelectItem[], prefix: string): string[] {
  const cols: string[] = [];
  for (const it of items) {
    if (it.kind === "star") cols.push(`${a}.*`);
    else if (it.kind === "col") {
      const expr = it.cast ? `(${colSql(it.col, a)})::${it.cast}` : colSql(it.col, a);
      cols.push(it.alias === it.col.name && !it.col.path.length && !it.cast ? expr : `${expr} as ${qa(it.alias)}`);
    } else {
      const r = relation(ctx, table, it.rel, it.hint);
      const e = nextAlias(ctx, "e");
      const sub = prefix ? `${prefix}.${it.alias}` : it.alias;
      const subCols = projection(ctx, it.rel, e, it.children, sub);
      const where = [
        `${e}.${qi(r.childCol)} = ${a}.${qi(r.parentCol)}`,
        ...embeddedConds(ctx, sub, e),
        ...innerConds(ctx, it.rel, e, it.children, sub),
      ];
      const body = `select ${subCols.join(", ")} from ${tbl(it.rel)} ${e} where ${where.join(" and ")}`;
      cols.push(
        r.one
          ? `(select to_json(x) from (${body}) x) as ${qa(it.alias)}`
          : `(select coalesce(json_agg(x), '[]'::json) from (${body}) x) as ${qa(it.alias)}`,
      );
    }
  }
  return cols;
}

/** For `!inner` embeds: the parent row needs a matching child. Evaluated against alias `a` of `table`. */
function innerConds(ctx: Ctx, table: string, a: string, items: SelectItem[], prefix: string): string[] {
  const out: string[] = [];
  for (const it of items) {
    if (it.kind !== "embed" || !it.inner) continue;
    const r = relation(ctx, table, it.rel, it.hint);
    const f = nextAlias(ctx, "f");
    const sub = prefix ? `${prefix}.${it.alias}` : it.alias;
    const where = [
      `${f}.${qi(r.childCol)} = ${a}.${qi(r.parentCol)}`,
      ...embeddedConds(ctx, sub, f),
      ...innerConds(ctx, it.rel, f, it.children, sub),
    ];
    out.push(`exists (select 1 from ${tbl(it.rel)} ${f} where ${where.join(" and ")})`);
  }
  return out;
}

function newCtx(q: ParsedQuery, fks: Fk[]): Ctx {
  return { fks, p: new Params(), q, used: new Set(), aliasN: 0 };
}

function assertEmbeddedUsed(ctx: Ctx): void {
  for (const k of ctx.q.embedded.keys()) {
    if (!ctx.used.has(k)) throw new RestError(400, "PGRST108", `'${k}' is not an embedded resource in this request`);
  }
}

function rejectWriteExtras(q: ParsedQuery): void {
  if (q.embedded.size) throw unsupported("filters on embedded resources in a write");
  if (q.order.length || q.limit !== null || q.offset !== null) throw unsupported("order, limit or offset on a write");
}

// ---- reads ----------------------------------------------------------------------------------------------------

export function selectSql(table: string, q: ParsedQuery, items: SelectItem[], fks: Fk[]): Built {
  const ctx = newCtx(q, fks);
  const a = "t";
  const cols = projection(ctx, table, a, items, "");
  const where = [...q.filters.map((c) => condSql(c, a, ctx.p)), ...innerConds(ctx, table, a, items, "")];
  assertEmbeddedUsed(ctx);
  const sql =
    `select coalesce(json_agg(r), '[]'::json) as d from (select ${cols.join(", ")} from ${tbl(table)} ${a}` +
    `${where.length ? ` where ${where.join(" and ")}` : ""}${orderSql(q.order, a)}` +
    `${q.limit !== null ? ` limit ${q.limit}` : ""}${q.offset !== null ? ` offset ${q.offset}` : ""}) r`;
  return { sql, params: ctx.p.values };
}

export function countSql(table: string, q: ParsedQuery, items: SelectItem[], fks: Fk[]): Built {
  const ctx = newCtx(q, fks);
  const a = "t";
  const where = [...q.filters.map((c) => condSql(c, a, ctx.p)), ...innerConds(ctx, table, a, items, "")];
  return {
    sql: `select count(*)::int as n from ${tbl(table)} ${a}${where.length ? ` where ${where.join(" and ")}` : ""}`,
    params: ctx.p.values,
  };
}

// ---- writes ---------------------------------------------------------------------------------------------------

export type WriteResult = { mode: "rows"; items: SelectItem[] } | { mode: "count" };

function wrapWrite(ctx: Ctx, table: string, stmt: string, result: WriteResult): string {
  if (result.mode === "count") return `with w0 as (${stmt}) select count(*)::int as n from w0`;
  const cols = projection(ctx, table, "w", result.items, "");
  return `with w0 as (${stmt}) select coalesce(json_agg(r), '[]'::json) as d from (select ${cols.join(", ")} from w0 w) r`;
}

export interface InsertOpts {
  resolution?: string;
  /** The primary key, used as the conflict target when merge-duplicates comes without on_conflict. */
  pk: string[];
}

export function insertSql(
  table: string,
  rows: Record<string, unknown>[],
  q: ParsedQuery,
  o: InsertOpts,
  result: WriteResult,
): Built {
  rejectWriteExtras(q);
  const ctx = newCtx(q, []);
  const keys = q.columns ?? [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const cols = keys.map(qi);
  let stmt: string;
  if (!cols.length) {
    if (rows.length !== 1) throw new RestError(400, "PGRST102", "Cannot insert several rows without columns");
    stmt = `insert into ${tbl(table)} default values`;
  } else {
    const data = ctx.p.text(JSON.stringify(rows));
    stmt = `insert into ${tbl(table)} (${cols.join(", ")}) select ${cols.join(", ")} from jsonb_populate_recordset(null::${tbl(table)}, ${data}::jsonb)`;
  }
  if (o.resolution) {
    const target = q.onConflict ?? o.pk;
    if (o.resolution === "ignore-duplicates") {
      // No primary key and no on_conflict: nothing to conflict on, so no clause (a bare `on conflict do nothing` would hide every unique violation).
      if (target.length) stmt += ` on conflict (${target.map(qi).join(", ")}) do nothing`;
    } else if (o.resolution === "merge-duplicates") {
      if (!target.length)
        throw new RestError(400, "PGRST102", `${table} has no primary key; pass on_conflict to upsert`);
      const set = keys.filter((k) => !target.includes(k));
      const sets = (set.length ? set : [target[0] as string]).map((k) => `${qi(k)} = excluded.${qi(k)}`);
      stmt += ` on conflict (${target.map(qi).join(", ")}) do update set ${sets.join(", ")}`;
    } else throw unsupported(`Prefer resolution=${o.resolution}`);
  } else if (q.onConflict) throw unsupported("on_conflict without a Prefer resolution");
  stmt += " returning *";
  return { sql: wrapWrite(ctx, table, stmt, result), params: ctx.p.values };
}

export function updateSql(table: string, body: Record<string, unknown>, q: ParsedQuery, result: WriteResult): Built {
  rejectWriteExtras(q);
  const ctx = newCtx(q, []);
  const keys = Object.keys(body);
  if (!keys.length) throw new RestError(400, "PGRST102", "Empty update body");
  const rec = ctx.p.text(JSON.stringify(body));
  const sets = keys.map((k) => `${qi(k)} = (jsonb_populate_record(null::${tbl(table)}, ${rec}::jsonb)).${qi(k)}`);
  const alias = tbl(table);
  const where = q.filters.map((c) => condSql(c, alias, ctx.p));
  const stmt = `update ${tbl(table)} set ${sets.join(", ")}${where.length ? ` where ${where.join(" and ")}` : ""} returning *`;
  return { sql: wrapWrite(ctx, table, stmt, result), params: ctx.p.values };
}

export function deleteSql(table: string, q: ParsedQuery, result: WriteResult): Built {
  rejectWriteExtras(q);
  const ctx = newCtx(q, []);
  const where = q.filters.map((c) => condSql(c, tbl(table), ctx.p));
  const stmt = `delete from ${tbl(table)}${where.length ? ` where ${where.join(" and ")}` : ""} returning *`;
  return { sql: wrapWrite(ctx, table, stmt, result), params: ctx.p.values };
}
