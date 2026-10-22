// MCP tool usage report over mcp_tool_calls (migration 098).
//
// usage (from apps/cloud):
//   npx tsx scripts/metrics/mcp-usage.ts [--days 7] [--user <email|uuid>]
//   (or: npm run metrics:mcp -- --days 30 --user x@y.com)
//
// Prints, for the window:
//   - per tool: calls, error %, degraded %, paged %, p50/p95 latency, avg result chars
//   - per client (client_name/client_version): calls
//   - follow-through for search_conversations and list_recent_conversations:
//     the share of calls with results after which the same user opened one of
//     the returned ids (get_conversation / get_code_session, args.id) within
//     15 minutes.
//
// Reads NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from .env.local.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config } from "dotenv";

config({ path: ".env.local" });

const PAGE = 1000;
const FOLLOW_WINDOW_MS = 15 * 60 * 1000;
const FOLLOW_SOURCES = ["search_conversations", "list_recent_conversations"];
const OPEN_TOOLS = new Set(["get_conversation", "get_code_session"]);

interface CallRow {
  user_id: string;
  client_name: string | null;
  client_version: string | null;
  tool: string;
  ok: boolean;
  latency_ms: number | null;
  result_chars: number | null;
  result_ids: string[] | null;
  degraded: boolean;
  paged: boolean;
  args: Record<string, unknown> | null;
  created_at: string;
}

function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (check apps/cloud/.env.local)");
    process.exit(1);
  }
  return createClient(url, key);
}

function parseArgs(argv: string[]): { days: number; user?: string } {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const days = Number(get("--days") ?? 7);
  if (!Number.isInteger(days) || days < 1) {
    console.error("--days must be a whole number >= 1");
    process.exit(1);
  }
  return { days, user: get("--user") };
}

async function resolveUserId(supabase: SupabaseClient, user: string): Promise<string> {
  if (!user.includes("@")) return user;
  const { data: profile } = await supabase.from("profiles").select("id").ilike("email", user).maybeSingle();
  if (profile?.id) return profile.id as string;
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
    if (error) break;
    const match = data.users.find((u) => u.email?.toLowerCase() === user.toLowerCase());
    if (match) return match.id;
    if (data.users.length < 200) break;
  }
  console.error(`No user found for email ${user}`);
  process.exit(1);
}

async function fetchCalls(supabase: SupabaseClient, sinceIso: string, userId?: string): Promise<CallRow[]> {
  const rows: CallRow[] = [];
  for (let from = 0; ; from += PAGE) {
    let q = supabase
      .from("mcp_tool_calls")
      .select(
        "user_id, client_name, client_version, tool, ok, latency_ms, result_chars, result_ids, degraded, paged, args, created_at",
      )
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (userId) q = q.eq("user_id", userId);
    const { data, error } = await q;
    if (error) {
      console.error(`mcp_tool_calls query failed: ${error.message}`);
      process.exit(1);
    }
    rows.push(...((data ?? []) as CallRow[]));
    if (!data || data.length < PAGE) break;
  }
  return rows;
}

function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(1)}%` : "-");
const num = (v: number | null) => (v === null ? "-" : String(Math.round(v)));

function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells: string[]) => cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join("  ");
  return [line(headers), widths.map((w) => "-".repeat(w)).join("  "), ...rows.map(line)].join("\n");
}

function perTool(calls: CallRow[]): string[][] {
  const byTool = new Map<string, CallRow[]>();
  for (const c of calls) byTool.set(c.tool, [...(byTool.get(c.tool) ?? []), c]);
  return [...byTool.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([tool, rows]) => {
      const latencies = rows.map((r) => r.latency_ms).filter((v): v is number => v !== null);
      const chars = rows.map((r) => r.result_chars).filter((v): v is number => v !== null);
      return [
        tool,
        String(rows.length),
        pct(rows.filter((r) => !r.ok).length, rows.length),
        pct(rows.filter((r) => r.degraded).length, rows.length),
        pct(rows.filter((r) => r.paged).length, rows.length),
        num(percentile(latencies, 0.5)),
        num(percentile(latencies, 0.95)),
        num(chars.length ? chars.reduce((a, b) => a + b, 0) / chars.length : null),
      ];
    });
}

function perClient(calls: CallRow[]): string[][] {
  const counts = new Map<string, number>();
  for (const c of calls) {
    const key = c.client_name ? `${c.client_name}${c.client_version ? `/${c.client_version}` : ""}` : "(unknown)";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => [k, String(n)]);
}

/** Calls are sorted by created_at ascending. */
function followThrough(calls: CallRow[]): string[][] {
  const opens = calls.filter((c) => OPEN_TOOLS.has(c.tool) && c.ok && typeof c.args?.id === "string");
  return FOLLOW_SOURCES.map((tool) => {
    const sources = calls.filter((c) => c.tool === tool && c.ok && (c.result_ids?.length ?? 0) > 0);
    let followed = 0;
    for (const s of sources) {
      const start = Date.parse(s.created_at);
      const ids = new Set(s.result_ids ?? []);
      const hit = opens.some((o) => {
        if (o.user_id !== s.user_id) return false;
        const t = Date.parse(o.created_at);
        return t >= start && t - start <= FOLLOW_WINDOW_MS && ids.has(o.args?.id as string);
      });
      if (hit) followed++;
    }
    return [tool, String(sources.length), String(followed), pct(followed, sources.length)];
  });
}

async function main() {
  const { days, user } = parseArgs(process.argv.slice(2));
  const supabase = getServiceClient();
  const userId = user ? await resolveUserId(supabase, user) : undefined;
  const sinceIso = new Date(Date.now() - days * 86_400_000).toISOString();
  const calls = await fetchCalls(supabase, sinceIso, userId);

  console.log(`MCP tool usage, last ${days} day(s)${userId ? `, user ${userId}` : ", all users"}: ${calls.length} calls\n`);
  if (!calls.length) return;

  console.log(
    table(["tool", "calls", "error", "degraded", "paged", "p50 ms", "p95 ms", "avg chars"], perTool(calls)),
  );
  console.log(`\n${table(["client", "calls"], perClient(calls))}`);
  console.log(
    `\nFollow-through (opened a returned id within 15 min)\n${table(
      ["tool", "calls with results", "followed", "rate"],
      followThrough(calls),
    )}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
