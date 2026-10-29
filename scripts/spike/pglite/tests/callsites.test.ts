import { afterAll, beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error plain ESM helper
import { boot, USER, ids } from "./setup.mjs";
import { getServiceClient } from "@/lib/db/clients";
import { getRecentSessionsForStats } from "@/lib/code-sessions/queries";
import { getContradictedCandidates } from "@/lib/memory/dogfood-signals";
import { getConversationStats } from "@/lib/stats";
import { memorySearch } from "@/lib/memory/search";
import { llmSpendSum } from "@/lib/llm/spend-ledger";
import { writeSessionIssueRows } from "@/lib/memory/session-issues";
import { getConversationQuota } from "@/lib/billing";
import { countClaimableMemoryExtraction, enqueueMemoryExtraction, claimNextMemoryExtraction } from "@/lib/memory/extraction-queue";

let env: Awaited<ReturnType<typeof boot>>;
beforeAll(async () => { env = await boot(); }, 120_000);
afterAll(() => { console.log("DENIALS " + JSON.stringify([...new Set(env.shim.denials)])); env?.restore(); });
const db = () => getServiceClient();

describe("real app functions through the PGlite PostgREST shim", () => {
  it("1 getRecentSessionsForStats: many-to-one embed code_projects(...) [queries.ts:993]", async () => {
    const rows = await getRecentSessionsForStats(db() as never, USER, new Date(Date.now() - 7 * 864e5).toISOString(), 10);
    expect(rows.map((r) => r.id)).toEqual([ids.s1, ids.s2]); // order started_at desc, s3 (40d) filtered by gte
    expect(rows[0]).toMatchObject({ project_display_name: "Acme API", project_repo_identity: "codehub/acme-api", git_branch: "feat/retry" });
  });
  it("2 getContradictedCandidates: embed session_memories(text,quote) + range pagination + 2 order keys [dogfood-signals.ts:387]", async () => {
    const out = await getContradictedCandidates(db() as never, USER, 7);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: ids.m1, text: "Retry the import on a 504 with exponential backoff", record_quote: "retry on 504 with backoff", quote: "actually no backoff needed", turn_idx: 9 });
  });
  it("3 getConversationStats: !inner embed + embedded filter + neq + range + order [stats.ts:78]", async () => {
    const s = await getConversationStats(USER, 1, 20, "chat");
    expect(s.total).toBe(2);
    expect(s.bySource).toEqual({ chatgpt: 2 });
    expect(s.byType).toEqual({ planning: 2 });
    expect(s.topTopics.map((t: { topic: string }) => t.topic).sort()).toEqual(["food", "travel"]);
    expect(s.recentConversations[0].title).toBe("Recipe ideas");
  });
  it("4 memorySearch: rpc memory_search_scored (keyword path) + resolveProjectId reads + recall-event insert", async () => {
    const res = await memorySearch(db() as never, USER, null, { query: "retry import 504 backoff" }, { logEvent: true });
    const hits = (res as { records: Array<{ id: string }> }).records;
    expect(hits.map((h) => h.id)).toContain(ids.m1);
    await new Promise((r) => setTimeout(r, 300)); // recall event is fire-and-forget in the app
    const ev = await env.db.query("select tool, record_ids from memory_recall_events");
    expect(ev.rows.length).toBe(1);
    expect(ev.rows[0].record_ids).toContain(ids.m1);
  });
  it("5 llmSpendSum: rpc returning a scalar numeric [spend-ledger.ts:139]", async () => {
    expect(await llmSpendSum(db() as never, USER, { sinceIso: new Date(Date.now() - 864e5 * 7).toISOString() })).toBeCloseTo(0.75, 5);
  });
  it("6 writeSessionIssueRows: select + upsert(onConflict) + update + delete with in() [session-issues.ts:41]", async () => {
    const issue = (ref: string, n: number, role = "worked_on") => ({ ref, number: n, kind: "issue", role, role_source: "observed", evidence_quote: "q", turn_idx: 1, review_verb: null, build_verb: "edited", tier: "observed", turn_share: 0.5, related_to: ["#2"] });
    expect(await writeSessionIssueRows(db() as never, USER, ids.s1, [issue("#1", 1), issue("#2", 2)] as never, true)).toBe(2);
    expect(await writeSessionIssueRows(db() as never, USER, ids.s1, [issue("#1", 1), issue("#3", 3)] as never, true)).toBe(2); // upsert #1 in place, drop #2 (delete in()), add #3
    const r = await env.db.query("select ref, related_to, turn_share from code_session_issues order by ref");
    expect(r.rows.map((x: { ref: string }) => x.ref)).toEqual(["#1", "#3"]);
    expect(r.rows[0].related_to).toEqual(["#2"]);
    const upd = await writeSessionIssueRows(db() as never, USER, ids.s1, [issue("#1", 1)] as never, false); // tail run -> update path for stale #3
    expect(upd).toBe(1);
    const s = await env.db.query("select ref, turn_share from code_session_issues where ref='#3'");
    expect(Number(s.rows[0].turn_share)).toBe(0); // stale #3 had share 0.5 > 0 -> the app's .update({turn_share: 0}).in('id',...) ran
  });
  it("7 getConversationQuota: .single() + count exact head [billing.ts:~41]", async () => {
    expect(await getConversationQuota(USER)).toEqual({ limit: 50, count: 3 });
  });
  it("8 countClaimableMemoryExtraction: or(a,and(b,c)) + head count [extraction-queue.ts:399]", async () => {
    expect(await countClaimableMemoryExtraction(db() as never, USER)).toBe(0);
    expect(await enqueueMemoryExtraction(db() as never, USER, { requeue: [ids.s1, ids.s2] })).toBe(2); // rpc with uuid[] args
    expect(await countClaimableMemoryExtraction(db() as never, USER)).toBe(2);
  });
  it("9 claimNextMemoryExtraction: rpc returning a row/table [extraction-queue.ts:325]", async () => {
    const c = await claimNextMemoryExtraction(db() as never, USER, {});
    expect(c?.sessionId).toBeTruthy();
    expect(await countClaimableMemoryExtraction(db() as never, USER)).toBe(1);
  });
  it("10 maybeSingle / update by filter: raw supabase-js calls shaped like the app's", async () => {
    const c = db();
    const none = await c.from("profiles").select("id").eq("id", "99999999-9999-9999-9999-999999999999").maybeSingle();
    expect(none).toMatchObject({ data: null, error: null });
    const some = await c.from("profiles").select("id, tier").eq("id", USER).maybeSingle();
    expect(some.data).toEqual({ id: USER, tier: "free" });
    const upd = await c.from("profiles").update({ tier: "pro", display_name: "Local" }).eq("id", USER).select("id, tier").single();
    expect(upd.data).toEqual({ id: USER, tier: "pro" });
    const dup = await c.from("code_projects").insert({ user_id: USER, repo_identity: "codehub/acme-api" });
    expect(dup.error?.code).toBe("23505"); // unique violation maps to a PostgREST-shaped error
  });
});
