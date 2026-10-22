#!/usr/bin/env node
// MCP efficiency report (goal 2026-09-26 P8) — prints, per Membral MCP tool,
// how a user's agent actually used it, from mcp_tool_calls (migration 098):
//
//   calls          how many times the tool was called in the window
//   ok %           share of calls that did not error
//   med chars      median result_chars (how big the answers were)
//   chars/result   result_chars / result_count over calls that reported a
//                  count (how much text each returned item cost)
//   re-query %     share of calls followed by ANOTHER MCP call by the same
//                  user within 60 s — the agent asked again, so the first
//                  answer probably did not settle it
//
// Then the user's most recent user_stats rows (migration 104), if the table
// exists — so the nightly derivation can be checked from the same command.
//
// usage:  npm run mcp:audit -- --user <uuid> [--days 30]
//
// Reads SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) and
// SUPABASE_SERVICE_ROLE_KEY together from ONE source: the shell when either
// is set there, else apps/cloud/.env.local (the same tiny loader the smoke
// run uses). Never a shell URL with the file's key or the reverse — that
// pairs a prod URL with a local service key. No new dependency: PostgREST over
// fetch. Prints a plain table; there is no UI for this on purpose.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvFile } from "../smoke/lib/env.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REQUERY_WINDOW_MS = 60_000;
const PAGE = 1000;

function usage(msg) {
  if (msg) console.error(`mcp-audit: ${msg}`);
  console.error("usage: npm run mcp:audit -- --user <uuid> [--days 30]");
  process.exit(msg ? 1 : 0);
}

function parseArgs(argv) {
  const get = (flag) => {
    const i = argv.indexOf(flag);
    const v = i >= 0 ? argv[i + 1] : undefined;
    return v === undefined || v.startsWith("--") ? undefined : v; // `--user --days 7` is a missing uuid, not "--days"
  };
  if (argv.includes("--help") || argv.includes("-h")) usage();
  const user = get("--user");
  if (!user) usage("--user <uuid> is required");
  const days = Number(get("--days") ?? 30);
  if (!Number.isInteger(days) || days < 1) usage("--days must be a whole number >= 1");
  return { user, days };
}

function resolveEnv() {
  const fromShell = ["SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"].some(
    (k) => process.env[k],
  );
  const src = fromShell ? process.env : loadEnvFile(`${REPO_ROOT}/apps/cloud/.env.local`);
  const url = src.SUPABASE_URL || src.NEXT_PUBLIC_SUPABASE_URL;
  const key = src.SUPABASE_SERVICE_ROLE_KEY;
  if (fromShell && (!url || !key)) {
    console.error(
      "mcp-audit: the shell sets only half of the Supabase env. Set BOTH SUPABASE_URL (or\n" +
        "NEXT_PUBLIC_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY in the shell, or neither (then\n" +
        "apps/cloud/.env.local supplies both). Never mixed. Nothing was read.",
    );
    process.exit(2);
  }
  if (!url || !key) {
    console.error(
      "mcp-audit: missing Supabase env. Set SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) and\n" +
        "SUPABASE_SERVICE_ROLE_KEY in the shell or in apps/cloud/.env.local (run `npx supabase start`\n" +
        "in apps/cloud and copy the printed values). Nothing was read.",
    );
    process.exit(2);
  }
  return { url: url.replace(/\/+$/, ""), key };
}

/** Drain one PostgREST select past the 1000-row cap. `query` must carry a stable `order`. */
async function selectAll(env, table, query) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const res = await fetch(`${env.url}/rest/v1/${table}?${query}`, {
      headers: {
        apikey: env.key,
        authorization: `Bearer ${env.key}`,
        range: `${from}-${from + PAGE - 1}`,
        prefer: "count=none",
      },
    });
    if (res.status === 404) return { missing: true, rows: out };
    if (!res.ok && res.status !== 206) {
      const body = await res.text().catch(() => "");
      throw new Error(`${table}: HTTP ${res.status} ${body.slice(0, 300)}`);
    }
    const rows = await res.json();
    if (!Array.isArray(rows)) throw new Error(`${table}: unexpected response shape`);
    out.push(...rows);
    if (rows.length < PAGE) return { missing: false, rows: out };
  }
}

function median(nums) {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

/** Per-tool rows of the P8 table, from calls sorted by created_at ascending. */
export function auditMcpCalls(calls) {
  const sorted = [...calls].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  const byTool = new Map();
  for (let i = 0; i < sorted.length; i++) {
    const c = sorted[i];
    let t = byTool.get(c.tool);
    if (!t) {
      t = { tool: c.tool, calls: 0, ok: 0, chars: [], charsWithCount: 0, results: 0, requeried: 0 };
      byTool.set(c.tool, t);
    }
    t.calls++;
    if (c.ok) t.ok++;
    if (typeof c.result_chars === "number") {
      t.chars.push(c.result_chars);
      if (typeof c.result_count === "number" && c.result_count > 0) {
        t.charsWithCount += c.result_chars;
        t.results += c.result_count;
      }
    }
    const next = sorted[i + 1];
    if (next && next.user_id === c.user_id && Date.parse(next.created_at) - Date.parse(c.created_at) <= REQUERY_WINDOW_MS) {
      t.requeried++;
    }
  }
  return [...byTool.values()]
    .map((t) => ({
      tool: t.tool,
      calls: t.calls,
      ok_pct: Math.round((100 * t.ok) / t.calls),
      median_result_chars: median(t.chars),
      chars_per_result: t.results > 0 ? Math.round(t.charsWithCount / t.results) : null,
      requery_pct: Math.round((100 * t.requeried) / t.calls),
    }))
    .sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool));
}

function printTable(rows, columns) {
  const cells = rows.map((r) => columns.map((c) => (r[c.key] === null || r[c.key] === undefined ? "-" : String(r[c.key]))));
  const widths = columns.map((c, i) => Math.max(c.label.length, ...cells.map((row) => row[i].length)));
  const line = (parts) => parts.map((p, i) => (columns[i].right ? p.padStart(widths[i]) : p.padEnd(widths[i]))).join("  ");
  console.log(line(columns.map((c) => c.label)));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const row of cells) console.log(line(row));
}

async function main() {
  const { user, days } = parseArgs(process.argv.slice(2));
  const env = resolveEnv();
  const since = new Date(Date.now() - days * 86_400_000).toISOString();

  const { rows: calls } = await selectAll(
    env,
    "mcp_tool_calls",
    `select=user_id,tool,ok,result_chars,result_count,created_at&user_id=eq.${encodeURIComponent(user)}` +
      `&created_at=gte.${encodeURIComponent(since)}&order=created_at.asc,id.asc`,
  );

  console.log(`MCP audit — user ${user}, last ${days} day(s), ${calls.length} call(s)\n`);
  if (calls.length === 0) {
    console.log("No MCP calls in the window. Is the MCP server pointed at this database, and is this the right user id?");
  } else {
    printTable(auditMcpCalls(calls), [
      { key: "tool", label: "tool" },
      { key: "calls", label: "calls", right: true },
      { key: "ok_pct", label: "ok %", right: true },
      { key: "median_result_chars", label: "med chars", right: true },
      { key: "chars_per_result", label: "chars/result", right: true },
      { key: "requery_pct", label: "re-query %", right: true },
    ]);
    console.log("\nre-query % = another MCP call by the same user within 60 s of this one.");
  }

  const stats = await selectAll(
    env,
    "user_stats",
    `select=day,sessions,sub_agent_sessions,cost_usd,edits,commits,tool_calls,mcp_calls,longest_session_seconds,busiest_repo,start_hour` +
      `&user_id=eq.${encodeURIComponent(user)}&order=day.desc&limit=14`,
  );
  console.log("");
  if (stats.missing) {
    console.log("user_stats: table not found — apply migration 104 (apps/cloud/supabase/migrations/104_user_stats.sql).");
  } else if (stats.rows.length === 0) {
    console.log("user_stats: no rows yet — the nightly cron (/api/internal/cron/memory-extraction) writes yesterday's row.");
  } else {
    console.log("user_stats (most recent days; cost is an estimate)");
    printTable(
      stats.rows.map((r) => ({ ...r, cost_usd: `$${Number(r.cost_usd).toFixed(2)} est.` })),
      [
        { key: "day", label: "day" },
        { key: "sessions", label: "sessions", right: true },
        { key: "sub_agent_sessions", label: "sub-agents", right: true },
        { key: "cost_usd", label: "cost", right: true },
        { key: "edits", label: "edits", right: true },
        { key: "commits", label: "commits", right: true },
        { key: "tool_calls", label: "tool calls", right: true },
        { key: "mcp_calls", label: "mcp calls", right: true },
        { key: "longest_session_seconds", label: "longest (s)", right: true },
        { key: "start_hour", label: "start h", right: true },
        { key: "busiest_repo", label: "busiest repo" },
      ],
    );
  }
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err) => {
    console.error(`mcp-audit: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
