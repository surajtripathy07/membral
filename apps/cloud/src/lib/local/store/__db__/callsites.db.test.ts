// The 10 census call sites from the PGlite spike, promoted: real app functions, reached through getServiceClient(),
// which lands on the embedded store (pglite mode) or on PostgREST (postgrest mode).
import { beforeAll, describe, expect, it } from "vitest";
import { getConversationQuota } from "@/lib/billing";
import { getRecentSessionsForStats } from "@/lib/code-sessions/queries";
import { getServiceClient } from "@/lib/db/clients";
import { llmSpendSum } from "@/lib/llm/spend-ledger";
import { getContradictedCandidates } from "@/lib/memory/dogfood-signals";
import {
  claimNextMemoryExtraction,
  countClaimableMemoryExtraction,
  enqueueMemoryExtraction,
} from "@/lib/memory/extraction-queue";
import { memorySearch } from "@/lib/memory/search";
import { writeSessionIssueRows } from "@/lib/memory/session-issues";
import { getConversationStats } from "@/lib/stats";
import { type DbEnv, ids, openDb, USER_A } from "../../../../../test/db-store";
import { newUserWithSessions } from "./helpers";

let env: DbEnv;
beforeAll(async () => {
  env = await openDb();
}, 300_000);
const db = () => getServiceClient();

describe("real app functions on the store", () => {
  it("1 getRecentSessionsForStats: many-to-one embed code_projects(...)", async () => {
    const rows = await getRecentSessionsForStats(db(), USER_A, new Date(Date.now() - 7 * 864e5).toISOString(), 10);
    expect(rows.map((r) => r.id)).toEqual([ids.s1, ids.s2]); // started_at desc; s3 (40 d) is outside the gte window
    expect(rows[0]).toMatchObject({
      project_display_name: "Acme API",
      project_repo_identity: "codehub/acme-api",
      git_branch: "feat/retry",
    });
  });

  it("2 getContradictedCandidates: embed + range pagination + two order keys", async () => {
    const out = await getContradictedCandidates(db(), USER_A, 7);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: ids.m1,
      text: "Retry the import on a 504 with exponential backoff",
      record_quote: "retry on 504 with backoff",
      quote: "actually no backoff needed",
      turn_idx: 9,
    });
  });

  it("3 getConversationStats: !inner embed, embedded filter, neq, range, order", async () => {
    const s = await getConversationStats(USER_A, 1, 20, "chat");
    expect(s.total).toBe(2);
    expect(s.bySource).toEqual({ chatgpt: 2 });
    expect(s.byType).toEqual({ planning: 2 });
    expect(s.topTopics.map((t: { topic: string }) => t.topic).sort()).toEqual(["food", "travel"]);
    expect(s.recentConversations[0].title).toBe("Recipe ideas");
  });

  it("4 memorySearch: rpc memory_search_scored (keyword path) and the recall-event insert", async () => {
    const res = await memorySearch(db(), USER_A, null, { query: "retry import 504 backoff" }, { logEvent: true });
    const hits = (res as { records: Array<{ id: string }> }).records;
    expect(hits.map((h) => h.id)).toContain(ids.m1);
    // The recall event is fire-and-forget in the app.
    let events: Record<string, unknown>[] = [];
    for (let i = 0; i < 20 && events.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 150));
      events = await env.query(
        "select tool, record_ids from memory_recall_events where user_id = $1 and $2 = any(record_ids)",
        [USER_A, ids.m1],
      );
    }
    expect(events.length).toBeGreaterThan(0);
  });

  it("5 llmSpendSum: an rpc returning a scalar numeric", async () => {
    const since = new Date(Date.now() - 864e5 * 7).toISOString();
    expect(await llmSpendSum(db(), USER_A, { sinceIso: since })).toBeCloseTo(0.75, 5);
  });

  it("6 writeSessionIssueRows: select, upsert(onConflict), update and delete with in()", async () => {
    const { userId, sessions } = await newUserWithSessions(env, 1);
    const sid = sessions[0] as string;
    const issue = (ref: string, n: number) => ({
      ref,
      number: n,
      kind: "issue",
      role: "worked_on",
      role_source: "observed",
      evidence_quote: "q",
      turn_idx: 1,
      review_verb: null,
      build_verb: "edited",
      tier: "observed",
      turn_share: 0.5,
      related_to: ["#2"],
    });
    expect(await writeSessionIssueRows(db(), userId, sid, [issue("#1", 1), issue("#2", 2)] as never, true)).toBe(2);
    // Upsert #1 in place, drop #2 (delete in()), add #3.
    expect(await writeSessionIssueRows(db(), userId, sid, [issue("#1", 1), issue("#3", 3)] as never, true)).toBe(2);
    const rows = await env.query(
      "select ref, related_to, turn_share from code_session_issues where session_id = $1 order by ref",
      [sid],
    );
    expect(rows.map((r) => r.ref)).toEqual(["#1", "#3"]);
    expect(rows[0]?.related_to).toEqual(["#2"]);
    // A tail run takes the update path for the stale #3.
    expect(await writeSessionIssueRows(db(), userId, sid, [issue("#1", 1)] as never, false)).toBe(1);
    const stale = await env.query("select turn_share from code_session_issues where session_id = $1 and ref = '#3'", [
      sid,
    ]);
    expect(Number(stale[0]?.turn_share)).toBe(0);
  });

  it("7 getConversationQuota: single() plus count exact head", async () => {
    // limit is the profile cap (50) or Infinity under self-host mode; the count is the exact head count.
    const quota = await getConversationQuota(USER_A);
    expect(quota.count).toBe(3);
    expect(quota.limit).toBeGreaterThanOrEqual(50);
  });

  it("8 and 9 the extraction queue: or(a,and(b,c)) head count, rpc with uuid[], rpc returning a table", async () => {
    const { userId, sessions } = await newUserWithSessions(env, 2);
    expect(await countClaimableMemoryExtraction(db(), userId)).toBe(0);
    expect(await enqueueMemoryExtraction(db(), userId, { requeue: sessions })).toBe(2);
    expect(await countClaimableMemoryExtraction(db(), userId)).toBe(2);
    const claimed = await claimNextMemoryExtraction(db(), userId, {});
    expect(claimed?.sessionId).toBeTruthy();
    expect(await countClaimableMemoryExtraction(db(), userId)).toBe(1);
  });

  it("10 maybeSingle, update by filter, and a unique violation shaped like PostgREST's", async () => {
    const c = db();
    const none = await c.from("profiles").select("id").eq("id", "99999999-9999-4999-8999-999999999999").maybeSingle();
    expect(none).toMatchObject({ data: null, error: null });
    const user = await env.newUser();
    const some = await c.from("profiles").select("id, tier").eq("id", user).maybeSingle();
    expect(some.data).toEqual({ id: user, tier: "free" });
    const upd = await c
      .from("profiles")
      .update({ tier: "pro", display_name: "Scratch" })
      .eq("id", user)
      .select("id, tier")
      .single();
    expect(upd.data).toEqual({ id: user, tier: "pro" });
    const first = await c.from("code_projects").insert({ user_id: user, repo_identity: "codehub/dup" });
    expect(first.error).toBeNull();
    const dup = await c.from("code_projects").insert({ user_id: user, repo_identity: "codehub/dup" });
    expect(dup.error?.code).toBe("23505");
  });
});
