// rpc/<function> for the in-process PostgREST shim. Arguments are coerced from the function's DECLARED parameter
// types (read from pg_proc), not from the JavaScript type of the value, and overloads are resolved by argument
// names the way PostgREST does. Every value is bound as text and cast to the declared type in SQL.
import { RestError } from "./parse";
import { type Built, Params, qi } from "./sql";

export const FN_SQL = `select p.proargnames as names, p.proargmodes as modes, p.pronargdefaults::int as ndef,
  p.proretset as retset, t.typtype as rtype, t.typname as rname,
  (select array_agg(format_type(x.t, null) order by x.o)
     from unnest(coalesce(p.proallargtypes, p.proargtypes::oid[])) with ordinality as x(t, o)) as types
  from pg_proc p join pg_type t on t.oid = p.prorettype
  where p.pronamespace = 'public'::regnamespace and p.prokind = 'f' and p.proname = $1`;

export interface FnArg {
  name: string;
  type: string;
  hasDefault: boolean;
}
export interface FnInfo {
  name: string;
  args: FnArg[];
  /** An input argument without a name cannot be passed by name, so this overload takes no arguments from a request. */
  positional: boolean;
  retset: boolean;
  returns: "void" | "scalar" | "row";
}

const TYPE_OK = /^[A-Za-z0-9_ ."[\](),]+$/;

export function fnFromRow(name: string, r: Record<string, unknown>): FnInfo {
  const names = (r.names as (string | null)[] | null) ?? [];
  const modes = (r.modes as string[] | null) ?? null;
  const types = (r.types as string[] | null) ?? [];
  const ndef = Number(r.ndef ?? 0);
  const inputs: { name: string | null; type: string }[] = [];
  types.forEach((type, i) => {
    const mode = modes?.[i] ?? "i";
    if (mode === "i" || mode === "b") inputs.push({ name: names[i] || null, type });
    else if (mode === "v") inputs.push({ name: null, type }); // VARIADIC: not callable by name
  });
  const firstDefault = inputs.length - ndef;
  const args = inputs.map((a, i) => ({ name: a.name ?? "", type: a.type, hasDefault: i >= firstDefault }));
  for (const a of args)
    if (!TYPE_OK.test(a.type)) throw new RestError(500, "PGRST000", `Unexpected argument type "${a.type}" on ${name}`);
  const rtype = String(r.rtype);
  const rname = String(r.rname);
  const retset = r.retset === true;
  const returns = rname === "void" ? "void" : retset || rtype === "c" || rtype === "p" ? "row" : "scalar";
  // A set-returning function over a non-composite type yields a list of scalars, not rows.
  const scalarSet = retset && rtype !== "c" && rtype !== "p";
  return {
    name,
    args,
    positional: args.some((a) => !a.name),
    retset,
    returns: scalarSet ? "scalar" : returns,
  };
}

/** The overload PostgREST would pick for these argument names: every name must be a parameter, every parameter without a default must be given. */
export function resolveOverload(name: string, candidates: FnInfo[], given: string[]): FnInfo {
  const sig = `public.${name}(${[...given].sort().join(", ")})`;
  const hits = candidates.filter((f) => {
    if (f.positional) return given.length === 0 && f.args.every((a) => a.hasDefault);
    const names = new Set(f.args.map((a) => a.name));
    return given.every((g) => names.has(g)) && f.args.every((a) => a.hasDefault || given.includes(a.name));
  });
  if (hits.length === 0) {
    throw new RestError(
      404,
      "PGRST202",
      `Could not find the function ${sig} in the schema cache`,
      null,
      "Perhaps you meant to call a different function, or the arguments do not match",
    );
  }
  if (hits.length > 1) {
    throw new RestError(
      300,
      "PGRST203",
      `Could not choose the best candidate function between: ${hits.map((h) => `public.${name}(${h.args.map((a) => `${a.name} => ${a.type}`).join(", ")})`).join(", ")}`,
      null,
      "Try renaming the parameters or the function itself in the database so function overloading can be resolved",
    );
  }
  return hits[0] as FnInfo;
}

const isJson = (t: string) => t === "json" || t === "jsonb";
const isArray = (t: string) => t.endsWith("[]");
const isVector = (t: string) => t === "vector" || t.startsWith("vector(") || t.endsWith(".vector");

function pgQuote(s: string): string {
  return `"${s.replace(/(["\\])/g, "\\$1")}"`;
}
function arrayLiteral(a: unknown[]): string {
  return `{${a
    .map((x) => {
      if (x === null || x === undefined) return "NULL";
      if (Array.isArray(x)) return arrayLiteral(x);
      return pgQuote(typeof x === "object" ? JSON.stringify(x) : String(x));
    })
    .join(",")}}`;
}

/** The text form of `value` for a parameter declared as `type`, or null for SQL NULL. `fromQuery`: GET arguments arrive as strings. */
export function coerceArg(arg: FnArg, value: unknown, fromQuery: boolean): string | null {
  if (value === null || value === undefined) return null;
  const bad = () => new RestError(400, "PGRST102", `Invalid value for argument "${arg.name}" of type ${arg.type}`);
  if (isJson(arg.type)) return fromQuery && typeof value === "string" ? value : JSON.stringify(value);
  if (isArray(arg.type)) {
    if (Array.isArray(value)) return arrayLiteral(value);
    if (typeof value === "string") return value; // already a "{a,b}" literal
    throw bad();
  }
  if (isVector(arg.type) && Array.isArray(value)) return JSON.stringify(value);
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  throw bad();
}

export function rpcSql(fn: FnInfo, args: Record<string, unknown>, fromQuery: boolean): Built {
  const p = new Params();
  const byName = new Map(fn.args.map((a) => [a.name, a]));
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new RestError(400, "PGRST100", `Invalid argument name "${k}"`);
    const arg = byName.get(k) as FnArg;
    const text = coerceArg(arg, v, fromQuery);
    const expr = text === null ? `null::${arg.type}` : `${p.text(text)}::${arg.type}`;
    parts.push(`"${k}" => ${expr}`);
  }
  const call = `"public".${qi(fn.name)}(${parts.join(", ")})`;
  let sql: string;
  if (fn.returns === "void") sql = `select ${call}, null::json as d`;
  else if (fn.retset && fn.returns === "scalar")
    sql = `select coalesce(json_agg(t.x), '[]'::json) as d from ${call} as t(x)`;
  else if (fn.retset) sql = `select coalesce(json_agg(t), '[]'::json) as d from ${call} t`;
  else if (fn.returns === "row") sql = `select to_json(t) as d from ${call} t`;
  else sql = `select to_json(${call}) as d`;
  return { sql, params: p.values };
}
