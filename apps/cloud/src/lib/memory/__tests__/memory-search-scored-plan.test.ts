// Migration 121: memory_search_scored must be planned with each call's actual values. A non-inlined
// `language sql` body is planned with opaque parameters, which made the lexical leg grow with base rows x
// query terms (1.3 s at 10 terms, 6.9 s at 153 on a 3.4k-row project) and timed prompt-time recall out.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATIONS = join(__dirname, "../../../../supabase/migrations");
const CREATE = /create (or replace )?function public\.memory_search_scored\(/;

function migrationsDefiningFunction(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .filter((f) => CREATE.test(readFileSync(join(MIGRATIONS, f), "utf8")));
}

/** The query from `with terms as` through `limit greatest(p_limit, 1);`. */
function queryBody(sql: string): string {
  const start = sql.indexOf("  with terms as (");
  const end = sql.indexOf("  limit greatest(p_limit, 1);");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end);
}

describe("memory_search_scored latest definition (migration 121)", () => {
  const files = migrationsDefiningFunction();
  const latest = files[files.length - 1];
  const sql = readFileSync(join(MIGRATIONS, latest), "utf8");

  it("is plpgsql with a custom plan per call", () => {
    expect(latest).toMatch(/^1(2[1-9]|[3-9]\d)_/);
    expect(sql).toMatch(/^language plpgsql$/m);
    expect(sql).toMatch(/^set plan_cache_mode = force_custom_plan$/m);
    expect(sql).toMatch(/^#variable_conflict use_column$/m);
    expect(sql).toMatch(/return query\n {2}with terms as \(/);
  });

  // Migration 128 changes exactly one thing: the code_sessions join becomes a `limit 1` lateral lookup (nested loop
  // over every session -> primary-key probe, 150 ms -> 60 ms on a 3.7k-row project). Anything else must match 118.
  const JOIN_118 =
    "    left join public.code_sessions cs\n      on cs.id = m.code_session_id and cs.user_id = p_user_id\n";
  const JOIN_128 =
    "    left join lateral (\n      select c.started_at\n      from public.code_sessions c\n      where c.id = m.code_session_id and c.user_id = p_user_id\n      limit 1\n    ) cs on true\n";

  it("keeps 118's query unchanged except the session lookup (128)", () => {
    const v118 = readFileSync(join(MIGRATIONS, "118_embedding_model_family.sql"), "utf8");
    const base = queryBody(v118);
    expect(base).toContain(JOIN_118);
    const expected = latest.startsWith("128_") ? base.replace(JOIN_118, JOIN_128) : base;
    expect(queryBody(sql)).toBe(expected);
  });

  it("keeps the service_role-only grants", () => {
    expect(sql).toMatch(/\) to service_role;/);
    expect(sql).toMatch(/\) from anon;/);
    expect(sql).toMatch(/\) from authenticated;/);
  });
});
