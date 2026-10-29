// Parsing for the in-process PostgREST shim: the query string and the `select` list become plain data. Nothing here
// builds SQL or touches a database; sql.ts does that, and every value it reads from here is bound as a parameter.
// Anything outside the supported subset throws a RestError (400, PGRST100) naming the feature. It never degrades
// to an empty result.

export class RestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: string | null = null,
    readonly hint: string | null = null,
  ) {
    super(message);
  }
}

export const unsupported = (feature: string) =>
  new RestError(
    400,
    "PGRST100",
    `Unsupported PostgREST feature: ${feature}`,
    null,
    "The embedded store serves a subset of PostgREST",
  );

export const IDENT = /^[a-z_][a-z0-9_]*$/;
const JSON_KEY = /^[A-Za-z0-9_-]{1,64}$/;

export interface PathStep {
  /** The key, validated against JSON_KEY; a digit-only key is an array index. */
  key: string;
  /** `->>` (text) rather than `->` (json). */
  text: boolean;
}
export interface ColRef {
  name: string;
  path: PathStep[];
}

/** `a`, `a->b`, `a->b->>c`. Column and keys are validated here, so sql.ts can quote them without binding. */
export function parseCol(raw: string): ColRef {
  const parts = raw.split(/(->>|->)/);
  const name = parts[0] ?? "";
  if (!IDENT.test(name)) throw new RestError(400, "PGRST100", `Invalid column name "${name}"`);
  const path: PathStep[] = [];
  for (let i = 1; i < parts.length; i += 2) {
    const key = parts[i + 1] ?? "";
    if (!JSON_KEY.test(key)) throw new RestError(400, "PGRST100", `Invalid JSON path key "${key}" in "${raw}"`);
    const text = parts[i] === "->>";
    if (text && i + 2 < parts.length) throw new RestError(400, "PGRST100", `"->>" must end the JSON path in "${raw}"`);
    path.push({ key, text });
  }
  return { name, path };
}

/** Splits on `sep` outside parentheses and double quotes (a backslash escapes inside quotes). */
export function splitTop(s: string, sep = ","): string[] {
  const out: string[] = [];
  let depth = 0;
  let inQ = false;
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i] as string;
    if (inQ) {
      cur += ch;
      if (ch === "\\" && i + 1 < s.length) cur += s[++i];
      else if (ch === '"') inQ = false;
      continue;
    }
    if (ch === '"') inQ = true;
    else if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") depth--;
    if (ch === sep && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (inQ || depth !== 0) throw new RestError(400, "PGRST100", `Unbalanced quotes or brackets in "${s}"`);
  if (cur.trim()) out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

function unquote(v: string): string {
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1).replace(/\\(.)/g, "$1");
  return v;
}

// ---- select list ----------------------------------------------------------------------------------------------

export type SelectItem =
  | { kind: "star" }
  | { kind: "col"; col: ColRef; alias: string; cast?: string }
  | { kind: "embed"; rel: string; alias: string; inner: boolean; hint?: string; children: SelectItem[] };

const CAST = /^[a-z_][a-z0-9_]*(\[\])?$/;

function parseSelectItem(item: string): SelectItem {
  const m = item.match(/^(?:([A-Za-z_]\w*):)?([A-Za-z_]\w*)((?:![A-Za-z_]\w*)*)\(([\s\S]*)\)$/);
  if (m) {
    const [, alias, rel, mods, body] = m as unknown as [string, string | undefined, string, string, string];
    if (!IDENT.test(rel)) throw new RestError(400, "PGRST100", `Invalid relationship name "${rel}"`);
    const flags = mods.split("!").filter(Boolean);
    let hint: string | undefined;
    let inner = false;
    for (const f of flags) {
      if (f === "inner") inner = true;
      else if (f === "left") continue;
      else if (!hint) hint = f;
      else throw unsupported(`select hint "${item}"`);
    }
    if (hint && !IDENT.test(hint)) throw new RestError(400, "PGRST100", `Invalid relationship hint "${hint}"`);
    return { kind: "embed", rel, alias: alias ?? rel, inner, hint, children: parseSelect(body) };
  }
  if (item === "*") return { kind: "star" };
  const c = item.match(/^(?:([A-Za-z_]\w*):)?([^:]+?)(?:::([A-Za-z_][\w]*(?:\[\])?))?$/);
  if (!c) throw unsupported(`select item "${item}"`);
  const col = parseCol(c[2] as string);
  const cast = c[3];
  if (cast && !CAST.test(cast.toLowerCase())) throw unsupported(`select cast "${cast}"`);
  const alias = c[1] ?? (col.path.length ? (col.path[col.path.length - 1] as PathStep).key : col.name);
  return { kind: "col", col, alias, cast: cast?.toLowerCase() };
}

export function parseSelect(sel: string | null | undefined): SelectItem[] {
  const items = splitTop(sel && sel.trim() ? sel : "*").map(parseSelectItem);
  if (!items.length) throw new RestError(400, "PGRST100", "Empty select list");
  return items;
}

// ---- filters --------------------------------------------------------------------------------------------------

export type Cond =
  | { kind: "is"; col: ColRef; neg: boolean; value: "null" | "true" | "false" | "unknown" }
  | { kind: "in"; col: ColRef; neg: boolean; values: string[] }
  | { kind: "cmp"; col: ColRef; neg: boolean; op: CmpOp; value: string }
  | {
      kind: "fts";
      col: ColRef;
      neg: boolean;
      fn: "to_tsquery" | "plainto_tsquery" | "phraseto_tsquery" | "websearch_to_tsquery";
      config?: string;
      value: string;
    }
  | { kind: "logic"; op: "and" | "or"; neg: boolean; items: Cond[] };

export type CmpOp = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "like" | "ilike" | "cs" | "cd" | "ov";
const CMP_OPS = new Set<string>(["eq", "neq", "gt", "gte", "lt", "lte", "like", "ilike", "cs", "cd", "ov"]);
const FTS_FN = {
  fts: "to_tsquery",
  plfts: "plainto_tsquery",
  phfts: "phraseto_tsquery",
  wfts: "websearch_to_tsquery",
} as const;

/** `expr` is what follows `col=`: `eq.5`, `not.is.null`, `in.(a,b)`, `fts(english).word`. */
export function parseCondition(colRaw: string, expr: string, neg = false): Cond {
  const col = parseCol(colRaw);
  let e = expr;
  let n = neg;
  while (e.startsWith("not.")) {
    n = !n;
    e = e.slice(4);
  }
  const dot = e.indexOf(".");
  if (dot < 0) throw new RestError(400, "PGRST100", `Failed to parse filter "${colRaw}=${expr}"`);
  const opRaw = e.slice(0, dot);
  const val = e.slice(dot + 1);
  const cfgMatch = opRaw.match(/^([a-z]+)\(([a-z_][a-z0-9_]*)\)$/);
  const op = cfgMatch ? (cfgMatch[1] as string) : opRaw;
  if (op === "is") {
    if (val !== "null" && val !== "true" && val !== "false" && val !== "unknown")
      throw new RestError(400, "PGRST100", `Invalid "is" value "${val}"`);
    return { kind: "is", col, neg: n, value: val };
  }
  if (op === "in") {
    if (!val.startsWith("(") || !val.endsWith(")"))
      throw new RestError(400, "PGRST100", `"in" needs a parenthesised list, got "${val}"`);
    return { kind: "in", col, neg: n, values: splitTop(val.slice(1, -1)).map(unquote) };
  }
  if (CMP_OPS.has(op) && !cfgMatch) {
    const v = op === "like" || op === "ilike" ? unquote(val).replace(/\*/g, "%") : unquote(val);
    return { kind: "cmp", col, neg: n, op: op as CmpOp, value: v };
  }
  if (op in FTS_FN) {
    return {
      kind: "fts",
      col,
      neg: n,
      fn: FTS_FN[op as keyof typeof FTS_FN],
      config: cfgMatch?.[2],
      value: unquote(val),
    };
  }
  throw unsupported(`filter operator "${opRaw}"`);
}

/** `or=(a.eq.1,b.is.null,and(c.gt.2,d.lt.3))`. */
export function parseLogic(op: "and" | "or", body: string, neg = false): Cond {
  if (!body.startsWith("(") || !body.endsWith(")"))
    throw new RestError(400, "PGRST100", `"${op}" needs a parenthesised list`);
  const items = splitTop(body.slice(1, -1)).map((p): Cond => {
    const m = p.match(/^(not\.)?(and|or)(\([\s\S]*\))$/);
    if (m) return parseLogic(m[2] as "and" | "or", m[3] as string, !!m[1]);
    const i = p.indexOf(".");
    if (i < 0) throw new RestError(400, "PGRST100", `Failed to parse logic term "${p}"`);
    return parseCondition(p.slice(0, i), p.slice(i + 1));
  });
  if (!items.length) throw new RestError(400, "PGRST100", `Empty "${op}" list`);
  return { kind: "logic", op, neg, items };
}

// ---- the whole query string -----------------------------------------------------------------------------------

export interface OrderTerm {
  col: ColRef;
  desc: boolean;
  nulls?: "first" | "last";
}

export interface ParsedQuery {
  select: string | null;
  /** Filters on the root table. */
  filters: Cond[];
  /** Filters on embedded resources, keyed by the dotted alias path ("members" or "sessions.turns"). */
  embedded: Map<string, Cond[]>;
  order: OrderTerm[];
  limit: number | null;
  offset: number | null;
  onConflict: string[] | null;
  columns: string[] | null;
}

const RESERVED = new Set(["select", "order", "limit", "offset", "on_conflict", "columns"]);

function intParam(name: string, v: string): number {
  if (!/^\d{1,9}$/.test(v)) throw new RestError(416, "PGRST103", `Invalid ${name} "${v}"`);
  return Number(v);
}

export function parseOrder(s: string): OrderTerm[] {
  return splitTop(s).map((p) => {
    const [c, ...mods] = p.split(".");
    const col = parseCol(c as string);
    let desc = false;
    let nulls: "first" | "last" | undefined;
    for (const m of mods) {
      if (m === "desc") desc = true;
      else if (m === "asc") desc = false;
      else if (m === "nullsfirst") nulls = "first";
      else if (m === "nullslast") nulls = "last";
      else throw unsupported(`order modifier "${m}"`);
    }
    return { col, desc, nulls };
  });
}

export function parseQuery(params: [string, string][]): ParsedQuery {
  const out: ParsedQuery = {
    select: null,
    filters: [],
    embedded: new Map(),
    order: [],
    limit: null,
    offset: null,
    onConflict: null,
    columns: null,
  };
  for (const [k, v] of params) {
    if (RESERVED.has(k)) {
      if (k === "select") out.select = v;
      else if (k === "order") out.order = parseOrder(v);
      else if (k === "limit") out.limit = intParam("limit", v);
      else if (k === "offset") out.offset = intParam("offset", v);
      else if (k === "on_conflict") out.onConflict = splitTop(v.replace(/"/g, "")).map((c) => parseCol(c).name);
      else out.columns = splitTop(v.replace(/"/g, "")).map((c) => parseCol(c).name);
      continue;
    }
    const logic = k.match(/^(?:(.+)\.)?(not\.)?(and|or)$/);
    if (logic) {
      const cond = parseLogic(logic[3] as "and" | "or", v, !!logic[2]);
      push(out, logic[1], cond);
      continue;
    }
    const embeddedReserved = k.match(/^(.+)\.(select|order|limit|offset|on_conflict|columns)$/);
    if (embeddedReserved) throw unsupported(`"${embeddedReserved[2]}" on embedded resource "${embeddedReserved[1]}"`);
    // An embedded filter is "alias.path.col"; JSON-path keys cannot contain a dot, so the last dot splits.
    const dot = k.lastIndexOf(".");
    if (dot >= 0) {
      push(out, k.slice(0, dot), parseCondition(k.slice(dot + 1), v));
    } else push(out, undefined, parseCondition(k, v));
  }
  return out;
}

function push(q: ParsedQuery, prefix: string | undefined, cond: Cond): void {
  if (!prefix) {
    q.filters.push(cond);
    return;
  }
  for (const seg of prefix.split("."))
    if (!IDENT.test(seg)) throw new RestError(400, "PGRST100", `Invalid embedded resource "${prefix}"`);
  const list = q.embedded.get(prefix) ?? [];
  list.push(cond);
  q.embedded.set(prefix, list);
}

/** `Prefer: return=representation, count=exact` into a map. */
export function parsePrefer(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(",")) {
    const [k, ...rest] = part.trim().split("=");
    if (k) out[k.trim()] = rest.join("=").trim();
  }
  return out;
}
