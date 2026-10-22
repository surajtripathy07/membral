// Migration 122: memory_anchor_records matches a prompt's path or file name on a path boundary. The SQL regex is read
// from the migration and run here as a JS RegExp (lookahead and bracket classes mean the same in Postgres AREs), so a
// change to the boundary in SQL fails this test. Verified against Postgres by a rolled-back run of the migration.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SQL = readFileSync(join(__dirname, "../../../../supabase/migrations/122_memory_session_title_fts.sql"), "utf8");

function textMatcher(): (text: string, token: string) => boolean {
  const m = SQL.match(/lower\(m\.text\) ~ \('([^']+)' \|\| toks\.re \|\| '([^']+)'\)/);
  expect(m).not.toBeNull();
  const [, lead, tail] = m as RegExpMatchArray;
  return (text, token) =>
    new RegExp(`${lead}${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}${tail}`).test(text.toLowerCase());
}

/** The paths rule as the migration states it: equal, or ends with `/` + token. */
function pathMatch(path: string, token: string): boolean {
  const p = path.toLowerCase();
  return p === token || p.endsWith(`/${token}`);
}

describe("memory_anchor_records (migration 122)", () => {
  const matches = textMatcher();

  it("is user- and project-scoped, live and verified only, service_role only", () => {
    expect(SQL).toMatch(/where m\.user_id = p_user_id\n\s+and m\.code_project_id = p_code_project_id/);
    expect(SQL).toMatch(/and m\.retired_at is null\n\s+and m\.verified/);
    expect(SQL).toMatch(/memory_anchor_records\(uuid, uuid, text\[\], text\[\], int\) to service_role;/);
    expect(SQL).toMatch(/memory_anchor_records\(uuid, uuid, text\[\], text\[\], int\) from anon;/);
    expect(SQL).toContain("right(lower(p.path), length(toks.tok) + 1) = '/' || toks.tok");
  });

  it("a full path in the prompt matches a record carrying that file in paths or text", () => {
    expect(pathMatch("apps/cloud/src/lib/kg/queue.ts", "apps/cloud/src/lib/kg/queue.ts")).toBe(true);
    expect(matches("R5 leaves apps/cloud/src/lib/kg/queue.ts alone for #157", "lib/kg/queue.ts")).toBe(true);
    expect(matches("see `apps/cloud/src/lib/kg/queue.ts`.", "apps/cloud/src/lib/kg/queue.ts")).toBe(true);
  });

  it("a bare file name never matches a longer file name (boundary)", () => {
    expect(matches("edited apps/cloud/src/lib/memory/extraction-queue.ts today", "queue.ts")).toBe(false);
    expect(pathMatch("apps/cloud/src/lib/memory/extraction-queue.ts", "queue.ts")).toBe(false);
    expect(matches("myqueue.ts and queue.tsx and queue.ts.bak", "queue.ts")).toBe(false);
    expect(matches("lib/kg/queue.ts: frozen", "queue.ts")).toBe(true);
  });
});
