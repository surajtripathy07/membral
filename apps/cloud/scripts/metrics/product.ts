// Read-only product metrics report — capture coverage, extraction progress,
// memory health, spend, and recall use. No writes, no migrations; every
// query is a plain service-role select/RPC read.
//
// usage (from apps/cloud):
//   npx tsx scripts/metrics/product.ts [--days 14] [--user <email|uuid>]
//
// Env: same pattern as scripts/flags.ts and scripts/memory/retire-subagent-brief.ts
// (NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from apps/cloud/.env.local).
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config } from "dotenv";

config({ path: ".env.local" });

import { selectAllRows } from "../../src/lib/util/pagination";
import { resolveCostCapConfig } from "../../src/lib/llm/config";
import {
  bucketByUser,
  dailyMatrix,
  flagGapsAfterFirstActivity,
  formatTable,
  groupCount,
  lastNDaysUTC,
  money,
  pct,
  percentile,
  utcDayKey,
  utcIsoWeekKey,
} from "./product-helpers";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000; // same window checkMonthlyCeiling uses (src/lib/kg/spend-ledger.ts)
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Args {
  days: number;
  user: string | undefined;
}

function parseArgs(argv: string[]): Args {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const next = argv[i + 1];
    out[arg.slice(2)] = next;
    if (next !== undefined && !next.startsWith("--")) i++;
  }
  const days = out.days ? Number.parseInt(out.days, 10) : 14;
  if (!Number.isFinite(days) || days <= 0) {
    console.error("--days must be a positive integer");
    process.exit(1);
  }
  return { days, user: out.user };
}

function getServiceClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (check apps/cloud/.env.local)");
    process.exit(1);
  }
  return createClient(url, key);
}

/** Resolves --user (email or uuid) to a user id, or exits if not found. Undefined means "all users". */
async function resolveUserFilter(supabase: SupabaseClient, userArg: string | undefined): Promise<string | undefined> {
  if (!userArg) return undefined;
  if (UUID_RE.test(userArg)) return userArg;
  const { data, error } = await supabase.from("profiles").select("id").eq("email", userArg).maybeSingle();
  if (error) {
    console.error(`profiles lookup failed: ${error.message}`);
    process.exit(1);
  }
  if (!data) {
    console.error(`no profile with email ${userArg}`);
    process.exit(1);
  }
  return data.id;
}

// biome-ignore lint/suspicious/noExplicitAny: the supabase-js query-builder generic chain blows up
// TS's instantiation depth when threaded through a constrained generic helper (TS2589); `any` here
// is a plain pass-through, not a widened value the rest of the file relies on.
function applyUserFilter(query: any, userId: string | undefined): any {
  return userId ? query.eq("user_id", userId) : query;
}

async function fetchEndedAtBySessionId(supabase: SupabaseClient, sessionIds: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const CHUNK = 150; // .in() is a URL query param — keep the id list short enough not to hit URI-too-long
  for (let i = 0; i < sessionIds.length; i += CHUNK) {
    const chunk = sessionIds.slice(i, i + CHUNK);
    const { data, error } = await supabase.from("code_sessions").select("id, ended_at").in("id", chunk);
    if (error) throw new Error(`code_sessions ended_at lookup: ${error.message}`);
    for (const row of data ?? []) out.set(row.id as string, row.ended_at as string | null);
  }
  return out;
}

function printHeader(section: string, why: string) {
  console.log(`\n== ${section} ==`);
  console.log(`why: ${why}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const supabase = getServiceClient();
  const targetUserId = await resolveUserFilter(supabase, args.user);

  const dayKeys = lastNDaysUTC(args.days);
  const windowStartIso = new Date(`${dayKeys[0]}T00:00:00.000Z`).toISOString();
  const since30Iso = new Date(Date.now() - THIRTY_DAYS_MS).toISOString();
  const { monthlyCeilingUsd } = resolveCostCapConfig(process.env);

  const { data: profileRows, error: profileErr } = await supabase.from("profiles").select("id, email");
  if (profileErr) throw new Error(`profiles: ${profileErr.message}`);
  const emailById = new Map((profileRows ?? []).map((p) => [p.id as string, (p.email as string) ?? "(no email)"]));

  // ---- fetch everything for the window once, then bucket per user in memory ----
  type CodeSessionRow = { user_id: string; source: string; parent_source_session_id: string | null; created_at: string };
  const codeSessions = await selectAllRows<CodeSessionRow>((from, to) =>
    applyUserFilter(
      supabase.from("code_sessions").select("user_id, source, parent_source_session_id, created_at"),
      targetUserId,
    )
      .gte("created_at", windowStartIso)
      .order("id", { ascending: true })
      .range(from, to),
  );

  type ConversationRow = { user_id: string; source: string; synced_at: string | null };
  const conversations = await selectAllRows<ConversationRow>((from, to) =>
    applyUserFilter(supabase.from("conversations").select("user_id, source, synced_at"), targetUserId)
      .gte("synced_at", windowStartIso)
      .order("id", { ascending: true })
      .range(from, to),
  );

  type QueueRow = { session_id: string; user_id: string; status: string; updated_at: string; queued_at: string };
  const queueAll = await selectAllRows<QueueRow>((from, to) =>
    applyUserFilter(
      supabase.from("memory_extraction_queue").select("session_id, user_id, status, updated_at, queued_at"),
      targetUserId,
    )
      .order("session_id", { ascending: true })
      .range(from, to),
  );
  const queueDoneInWindow = queueAll.filter((q) => q.status === "done" && q.updated_at >= windowStartIso);
  const endedAtBySession = await fetchEndedAtBySessionId(supabase, [...new Set(queueDoneInWindow.map((q) => q.session_id))]);

  type MemoryRow = {
    user_id: string;
    kind: string;
    created_at: string;
    retired_at: string | null;
    retire_reason: string | null;
    supersedes: string | null;
  };
  const memCreated = await selectAllRows<MemoryRow>((from, to) =>
    applyUserFilter(
      supabase.from("session_memories").select("user_id, kind, created_at, retired_at, retire_reason, supersedes"),
      targetUserId,
    )
      .gte("created_at", windowStartIso)
      .order("id", { ascending: true })
      .range(from, to),
  );
  const memRetired = await selectAllRows<MemoryRow>((from, to) =>
    applyUserFilter(
      supabase.from("session_memories").select("user_id, kind, created_at, retired_at, retire_reason, supersedes"),
      targetUserId,
    )
      .gte("retired_at", windowStartIso)
      .order("id", { ascending: true })
      .range(from, to),
  );

  type SpendRow = { user_id: string; pass: string; cost_usd: number; spent_at: string };
  const spendWindow = await selectAllRows<SpendRow>((from, to) =>
    applyUserFilter(supabase.from("llm_spend").select("user_id, pass, cost_usd, spent_at"), targetUserId)
      .gte("spent_at", windowStartIso)
      .order("id", { ascending: true })
      .range(from, to),
  );
  const spend30 = await selectAllRows<{ user_id: string; cost_usd: number }>((from, to) =>
    applyUserFilter(supabase.from("llm_spend").select("user_id, cost_usd"), targetUserId)
      .gte("spent_at", since30Iso)
      .order("id", { ascending: true })
      .range(from, to),
  );

  type RecallRow = { user_id: string; tool: string; served_at: string; record_ids: string[] };
  const recallEvents = await selectAllRows<RecallRow>((from, to) =>
    applyUserFilter(supabase.from("memory_recall_events").select("user_id, tool, served_at, record_ids"), targetUserId)
      .gte("served_at", windowStartIso)
      .order("id", { ascending: true })
      .range(from, to),
  );

  const users = targetUserId
    ? [targetUserId]
    : [
        ...new Set([
          ...codeSessions.map((r) => r.user_id),
          ...conversations.map((r) => r.user_id),
          ...queueAll.map((r) => r.user_id),
          ...memCreated.map((r) => r.user_id),
          ...memRetired.map((r) => r.user_id),
          ...spendWindow.map((r) => r.user_id),
          ...spend30.map((r) => r.user_id),
          ...recallEvents.map((r) => r.user_id),
        ]),
      ].sort();

  console.log(`product metrics — last ${args.days} day(s), window start ${dayKeys[0]} UTC, ${users.length} user(s)`);

  const byUserCodeSessions = bucketByUser(codeSessions);
  const byUserConversations = bucketByUser(conversations);
  const byUserQueueAll = bucketByUser(queueAll);
  const byUserQueueDone = bucketByUser(queueDoneInWindow);
  const byUserMemCreated = bucketByUser(memCreated);
  const byUserMemRetired = bucketByUser(memRetired);
  const byUserSpendWindow = bucketByUser(spendWindow);
  const byUserSpend30 = bucketByUser(spend30);
  const byUserRecall = bucketByUser(recallEvents);

  for (const userId of users) {
    console.log(`\n${"#".repeat(60)}\nuser: ${emailById.get(userId) ?? "(unknown)"} (${userId})`);

    // ---- 1. Capture coverage ----
    printHeader(
      "1. Capture coverage",
      "a harness or chat source going quiet mid-window usually means a broken hook/plugin, not less usage",
    );
    const cs = byUserCodeSessions.get(userId) ?? [];
    const csMatrix = dailyMatrix(
      cs,
      (r) => utcDayKey(r.created_at),
      (r) => `${r.source}:${r.parent_source_session_id ? "sub-agent" : "main"}`,
      dayKeys,
    );
    const csFlags = flagGapsAfterFirstActivity(dayKeys, csMatrix.keys, csMatrix.counts);
    console.log("code sessions captured per day, by harness:");
    console.log(
      formatTable(
        ["day", ...csMatrix.keys, "flags"],
        dayKeys.map((d) => [
          d,
          ...csMatrix.keys.map((k) => csMatrix.counts.get(d)?.get(k) ?? 0),
          (csFlags.get(d) ?? []).join(",") || "-",
        ]),
      ),
    );
    const conv = byUserConversations.get(userId) ?? [];
    const convMatrix = dailyMatrix(
      conv,
      (r) => utcDayKey(r.synced_at ?? new Date().toISOString()),
      (r) => r.source,
      dayKeys,
    );
    const convFlags = flagGapsAfterFirstActivity(dayKeys, convMatrix.keys, convMatrix.counts);
    console.log("\nchats captured per day, by source (synced_at):");
    console.log(
      formatTable(
        ["day", ...convMatrix.keys, "flags"],
        dayKeys.map((d) => [
          d,
          ...convMatrix.keys.map((k) => convMatrix.counts.get(d)?.get(k) ?? 0),
          (convFlags.get(d) ?? []).join(",") || "-",
        ]),
      ),
    );

    // ---- 2. Extraction progress ----
    printHeader("2. Extraction progress", "a growing pending/failed pile means memories are not reaching the user");
    const qAll = byUserQueueAll.get(userId) ?? [];
    const statusCounts = groupCount(qAll, (r) => r.status);
    console.log("current queue by status (all time, not windowed):");
    console.log(formatTable(["status", "count"], [...statusCounts.entries()]));
    const qDone = byUserQueueDone.get(userId) ?? [];
    const doneByDay = groupCount(qDone, (r) => utcDayKey(r.updated_at));
    console.log("\nextracted (status=done) per day in window:");
    console.log(formatTable(["day", "done"], dayKeys.map((d) => [d, doneByDay.get(d) ?? 0])));
    const latencies = qDone
      .map((r) => {
        const endedAt = endedAtBySession.get(r.session_id);
        if (!endedAt) return null;
        return (new Date(r.updated_at).getTime() - new Date(endedAt).getTime()) / 1000;
      })
      .filter((v): v is number => v !== null && v >= 0)
      .sort((a, b) => a - b);
    console.log("\nlatency, session end -> extraction done (seconds), window's done rows:");
    console.log(
      formatTable(
        ["n", "p50", "p95"],
        [[latencies.length, percentile(latencies, 50)?.toFixed(0) ?? "n/a", percentile(latencies, 95)?.toFixed(0) ?? "n/a"]],
      ),
    );

    // ---- 3. Memory health ----
    printHeader("3. Memory health", "retirement/correction mix by kind shows whether extraction quality is improving or backsliding");
    const created = byUserMemCreated.get(userId) ?? [];
    const retired = byUserMemRetired.get(userId) ?? [];
    const weekKeysCreated = [...new Set(created.map((r) => utcIsoWeekKey(r.created_at)))].sort();
    const kindsCreated = [...new Set(created.map((r) => r.kind))].sort();
    const createdMatrix = dailyMatrix(created, (r) => utcIsoWeekKey(r.created_at), (r) => r.kind, weekKeysCreated);
    console.log("memories created per ISO week, by kind:");
    console.log(
      formatTable(
        ["week", ...kindsCreated, "corrected(supersedes)"],
        weekKeysCreated.map((w) => [
          w,
          ...kindsCreated.map((k) => createdMatrix.counts.get(w)?.get(k) ?? 0),
          created.filter((r) => utcIsoWeekKey(r.created_at) === w && r.supersedes).length,
        ]),
      ),
    );
    const weekKeysRetired = [...new Set(retired.map((r) => utcIsoWeekKey(r.retired_at as string)))].sort();
    const reasons = [...new Set(retired.map((r) => r.retire_reason ?? "(none)"))].sort();
    const retiredMatrix = dailyMatrix(
      retired,
      (r) => utcIsoWeekKey(r.retired_at as string),
      (r) => r.retire_reason ?? "(none)",
      weekKeysRetired,
    );
    console.log("\nmemories retired per ISO week, by retire_reason:");
    if (weekKeysRetired.length === 0) console.log("(none retired in window)");
    else
      console.log(
        formatTable(
          ["week", ...reasons],
          weekKeysRetired.map((w) => [w, ...reasons.map((r) => retiredMatrix.counts.get(w)?.get(r) ?? 0)]),
        ),
      );

    // ---- 4. Spend per outcome ----
    printHeader("4. Spend per outcome", "spend that outpaces extractions/memories kept means cost per useful record is rising");
    const spendW = byUserSpendWindow.get(userId) ?? [];
    const passes = [...new Set(spendW.map((r) => r.pass))].sort();
    const spendByDayPass = new Map<string, Map<string, number>>();
    for (const d of dayKeys) spendByDayPass.set(d, new Map());
    for (const r of spendW) {
      const d = utcDayKey(r.spent_at);
      const m = spendByDayPass.get(d);
      if (!m) continue;
      m.set(r.pass, (m.get(r.pass) ?? 0) + Number(r.cost_usd));
    }
    console.log("spend per day by pass ($):");
    console.log(
      formatTable(
        ["day", ...passes],
        dayKeys.map((d) => [d, ...passes.map((p) => money(spendByDayPass.get(d)?.get(p) ?? 0))]),
      ),
    );
    const spent30 = (byUserSpend30.get(userId) ?? []).reduce((s, r) => s + Number(r.cost_usd), 0);
    console.log("\nlast-30-day spend vs monthly ceiling (checkMonthlyCeiling's own window):");
    console.log(
      formatTable(
        ["spent_30d", "ceiling", "pct_of_ceiling", "headroom"],
        [
          [
            money(spent30),
            monthlyCeilingUsd === null ? "unset (not enforcing)" : money(monthlyCeilingUsd),
            monthlyCeilingUsd === null ? "n/a" : pct(spent30, monthlyCeilingUsd),
            monthlyCeilingUsd === null ? "n/a" : money(Math.max(0, monthlyCeilingUsd - spent30)),
          ],
        ],
      ),
    );
    const memorySpendW = spendW.filter((r) => r.pass.startsWith("memory")).reduce((s, r) => s + Number(r.cost_usd), 0);
    const extractedCountW = qDone.length;
    const keptCountW = created.filter((r) => !r.retired_at).length;
    console.log("\ncost per outcome (memory* passes only, window spend):");
    console.log(
      formatTable(
        ["memory_spend", "extracted_sessions", "cost/session", "memories_kept", "cost/memory_kept"],
        [
          [
            money(memorySpendW),
            extractedCountW,
            extractedCountW > 0 ? money(memorySpendW / extractedCountW) : "n/a",
            keptCountW,
            keptCountW > 0 ? money(memorySpendW / keptCountW) : "n/a",
          ],
        ],
      ),
    );

    // ---- 5. Memory recall use ----
    printHeader("5. Memory recall use", "a rising zero-result share means recall is being called but not finding anything to serve");
    const recalls = byUserRecall.get(userId) ?? [];
    const byDay = new Map<string, { calls: number; zero: number }>();
    for (const d of dayKeys) byDay.set(d, { calls: 0, zero: 0 });
    for (const r of recalls) {
      const d = utcDayKey(r.served_at);
      const bucket = byDay.get(d);
      if (!bucket) continue;
      bucket.calls++;
      if (!r.record_ids || r.record_ids.length === 0) bucket.zero++;
    }
    console.log(
      formatTable(
        ["day", "calls", "zero_results", "zero_share"],
        dayKeys.map((d) => {
          const b = byDay.get(d)!;
          return [d, b.calls, b.zero, pct(b.zero, b.calls)];
        }),
      ),
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
