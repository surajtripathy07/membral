// Operator CLI for the per-user `feature_flags` table (issue #126, ADR
// 0047; budgets added issue #128, ADR 0047 v2) — grant/revoke/list access
// to a spend-gated feature (`llm` or `embeddings`) for one user, by email or
// user id. Also owns the app-wide `mode` switch (issue #127 self-hosting
// decision, migration 081). Service-role only; reads apps/cloud/.env.local
// exactly like scripts/kg/bootstrap.ts.
//
// usage (from apps/cloud):
//   npx tsx scripts/flags.ts grant  --feature llm --email x@y.com [--budget-usd 0.15] [--daily-usd 0.01] [--note "teaser"]
//   npx tsx scripts/flags.ts grant  --feature llm --user-id <uuid> [--note "..."]
//   npx tsx scripts/flags.ts revoke --feature llm --email x@y.com
//   npx tsx scripts/flags.ts list   [--feature llm] [--email x@y.com | --user-id <uuid>]
//   npx tsx scripts/flags.ts mode   <show|open|hosted>
//
// `revoke` writes enabled=false rather than deleting the row (an explicit,
// auditable "someone turned this off", with `note` and `updated_at`
// preserved/refreshed) — matching hasFeature's own contract, which treats a
// disabled row and a missing row identically.
//
// `--budget-usd`/`--daily-usd` (issue #128): the lifetime/trailing-24h USD
// caps checkFeature enforces (lib/feature-flags.ts). Omitted entirely ->
// the grant leaves budget_usd/daily_usd untouched on an existing row (same
// "don't clobber what --note already protects" convention as `note` below)
// or NULL (unlimited) on a brand-new row — a bare `grant --feature llm` with
// no budget flags is still the "full, unlimited enable" issue #128 asks
// for. Pass `--budget-usd 0` explicitly to set a real, enforcing zero (rare,
// but matches migration 035's own "0 is a valid enforcing value"
// precedent) — `0` and "not passed" are distinguished the same way `--note`
// already is (typeof check, not falsy check).
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config } from "dotenv";

config({ path: ".env.local" });

function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (check apps/cloud/.env.local)");
    process.exit(1);
  }
  return createClient(url, key);
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

async function resolveUserId(
  supabase: SupabaseClient,
  opts: { email?: string; userId?: string },
): Promise<string> {
  if (opts.userId) return opts.userId;
  if (!opts.email) {
    console.error("Provide --email or --user-id");
    process.exit(1);
  }

  // Case-insensitive (issue #126 finding 12) — the admin-API fallback below
  // already compares case-insensitively; this primary lookup used to be
  // case-SENSITIVE (`.eq`), so `--email Founder@x.com` could resolve
  // differently depending on which branch answered.
  const { data: profile } = await supabase
    .from("profiles")
    .select("id")
    .ilike("email", opts.email)
    .maybeSingle();
  if (profile?.id) return profile.id as string;

  // Fall back to the auth admin API (paginated) for an account whose
  // profiles row has no email backfilled yet.
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
    if (error) break;
    const match = data.users.find((u) => u.email?.toLowerCase() === opts.email?.toLowerCase());
    if (match) return match.id;
    if (data.users.length < 200) break;
  }

  console.error(`No user found for email ${opts.email}`);
  process.exit(1);
}

async function grant(supabase: SupabaseClient, args: Record<string, string | boolean>) {
  const feature = args.feature as string;
  if (!feature) {
    console.error("Provide --feature <name>");
    process.exit(1);
  }
  const userId = await resolveUserId(supabase, { email: args.email as string, userId: args["user-id"] as string });
  const noteProvided = typeof args.note === "string";

  // issue #128: same "only touch what was explicitly passed" convention as
  // `note` below — a bare `grant` with no `--budget-usd`/`--daily-usd`
  // leaves an existing row's budget untouched (re-grant after a revoke
  // keeps whatever budget it had) and defaults a BRAND NEW row's budget to
  // NULL (unlimited) — a plain `grant --feature llm` is still the "full,
  // unlimited enable" issue #128 calls for; `--budget-usd 0.15` is how a
  // teaser grant is made instead.
  const budgetProvided = typeof args["budget-usd"] === "string";
  const dailyProvided = typeof args["daily-usd"] === "string";
  let budgetUsd: number | undefined;
  let dailyUsd: number | undefined;
  if (budgetProvided) {
    budgetUsd = Number(args["budget-usd"]);
    if (!Number.isFinite(budgetUsd) || budgetUsd < 0) {
      console.error(`--budget-usd must be a non-negative number, got "${args["budget-usd"]}"`);
      process.exit(1);
    }
  }
  if (dailyProvided) {
    if (args["daily-usd"] === "none") {
      // Round-5 verification F6: explicitly unlimited, even in HOSTED mode
      // where a bare (no --daily-usd at all) full grant would otherwise get
      // MEMBRAL_LLM_DEFAULT_DAILY_USD applied automatically.
      dailyUsd = DAILY_UNLIMITED_SENTINEL;
    } else {
      dailyUsd = Number(args["daily-usd"]);
      if (!Number.isFinite(dailyUsd) || dailyUsd < 0) {
        console.error(`--daily-usd must be a non-negative number, or the literal "none" for explicitly unlimited, got "${args["daily-usd"]}"`);
        process.exit(1);
      }
    }
  }

  // issue #126 finding 12: only include `note` in the upsert payload when
  // `--note` was actually passed. supabase-js's upsert only SETs the
  // columns present in the payload on conflict — omitting `note` entirely
  // leaves an existing operator note untouched instead of silently
  // overwriting it with null on a bare re-grant. Same rule now applies to
  // budget_usd/daily_usd (issue #128).
  const payload: Record<string, unknown> = {
    user_id: userId,
    feature,
    enabled: true,
    updated_at: new Date().toISOString(),
  };
  if (noteProvided) payload.note = args.note as string;
  if (budgetProvided) payload.budget_usd = budgetUsd;
  if (dailyProvided) payload.daily_usd = dailyUsd;

  const { error } = await supabase.from("feature_flags").upsert(payload, { onConflict: "user_id,feature" });
  if (error) {
    console.error(`grant failed: ${error.message}`);
    process.exit(1);
  }
  console.log(
    `granted "${feature}" to user ${userId}` +
      `${noteProvided ? ` (note: ${args.note})` : ""}` +
      `${budgetProvided ? ` (budget: $${budgetUsd})` : ""}` +
      `${dailyProvided ? ` (daily: ${dailyUsd === DAILY_UNLIMITED_SENTINEL ? "unlimited, explicit" : `$${dailyUsd}`})` : ""}`,
  );
}

async function revoke(supabase: SupabaseClient, args: Record<string, string | boolean>) {
  const feature = args.feature as string;
  if (!feature) {
    console.error("Provide --feature <name>");
    process.exit(1);
  }
  const userId = await resolveUserId(supabase, { email: args.email as string, userId: args["user-id"] as string });
  const noteProvided = typeof args.note === "string";

  // issue #126 finding 12: `revoke` (with no `--note`) used to upsert
  // `note: null` unconditionally, silently destroying whatever operator note
  // explained the original grant — the exact audit trail this file's header
  // says revoke exists to preserve. Only touch `note` when `--note` was
  // explicitly passed.
  const payload: Record<string, unknown> = {
    user_id: userId,
    feature,
    enabled: false,
    updated_at: new Date().toISOString(),
  };
  if (noteProvided) payload.note = args.note as string;

  const { error } = await supabase.from("feature_flags").upsert(payload, { onConflict: "user_id,feature" });
  if (error) {
    console.error(`revoke failed: ${error.message}`);
    process.exit(1);
  }
  console.log(`revoked "${feature}" for user ${userId}`);
}

// Issue #128: the SAME embedding pass names lib/feature-flags.ts's
// EMBEDDING_PASSES uses — kept as a local literal (not imported) since this
// script deliberately avoids importing from src/lib/feature-flags.ts (that
// module pulls in `next/server`, which is not a safe dependency for a
// bare `tsx` script run outside the Next.js runtime). Duplicated, not
// shared — if the pass vocabulary changes, both copies need updating; a
// stale copy here only affects `list`'s displayed spend figure, never
// enforcement (checkFeature is the only enforcement path).
const EMBEDDING_PASSES = ["chunk_embedding", "conversation_embedding", "query_embedding"];

// Round-5 verification F6 — SAME sentinel lib/feature-flags.ts's
// resolveFlags reads (duplicated, not imported — this script deliberately
// avoids importing from src/lib/feature-flags.ts, see EMBEDDING_PASSES's own
// comment above for why). `--daily-usd none` writes this into
// feature_flags.daily_usd to mean "explicitly, permanently unlimited" —
// distinct from leaving --daily-usd unset (which, for a "full" llm grant in
// HOSTED mode, now gets MEMBRAL_LLM_DEFAULT_DAILY_USD applied automatically
// by checkFeature; see feature-flags.ts's own comment on this constant).
const DAILY_UNLIMITED_SENTINEL = -1;

/** Lifetime spend for one (user, feature) pair, via the same llm_spend_sum RPC + pass-group split checkFeature uses (migration 080). Returns 0 on any error rather than throwing — `list` is read-only tooling, never worth failing the whole command over one row's spend figure. */
async function spendForFeature(supabase: SupabaseClient, userId: string, feature: string): Promise<number> {
  const passParams =
    feature === "embeddings" ? { p_include_passes: EMBEDDING_PASSES } : { p_exclude_passes: EMBEDDING_PASSES };
  const { data, error } = await supabase.rpc("llm_spend_sum", {
    p_user_id: userId,
    p_since: new Date(0).toISOString(),
    p_run_id: null,
    ...passParams,
  });
  if (error) return 0;
  const n = Number(data);
  return Number.isFinite(n) ? n : 0;
}

async function list(supabase: SupabaseClient, args: Record<string, string | boolean>) {
  // Issue #127 self-hosting decision: show the app-wide mode first — it's
  // the single biggest thing that changes what every row below actually
  // means (an "unlimited" feature_flags row is redundant noise in open
  // mode, but the whole story in hosted mode).
  const { mode: current, error: modeError } = await currentAppMode(supabase);
  console.log(`mode: ${modeError ? `(unknown — query failed: ${modeError})` : current}`);

  let query = supabase
    .from("feature_flags")
    .select("user_id, feature, enabled, note, budget_usd, daily_usd, created_at, updated_at")
    .order("updated_at", { ascending: false });

  if (args.feature) query = query.eq("feature", args.feature as string);
  if (args["user-id"]) query = query.eq("user_id", args["user-id"] as string);
  if (args.email) {
    const userId = await resolveUserId(supabase, { email: args.email as string });
    query = query.eq("user_id", userId);
  }

  const { data, error } = await query;
  if (error) {
    console.error(`list failed: ${error.message}`);
    process.exit(1);
  }
  if (!data || data.length === 0) {
    console.log("(no rows)");
    return;
  }

  // Join in emails for readability — profiles is small, one extra query.
  const userIds = Array.from(new Set(data.map((r) => r.user_id as string)));
  const { data: profiles } = await supabase.from("profiles").select("id, email").in("id", userIds);
  const emailById = new Map((profiles ?? []).map((p) => [p.id as string, p.email as string | null]));

  for (const row of data) {
    const email = emailById.get(row.user_id as string) ?? "(unknown)";
    // issue #128: budget/daily/spent — spent is only worth querying for a
    // row that actually has a budget or daily cap; an unlimited row's spend
    // figure isn't gating anything, so skip the extra round trip for it.
    const budgetUsd = row.budget_usd === null ? null : Number(row.budget_usd);
    const rawDailyUsd = row.daily_usd === null ? null : Number(row.daily_usd);
    // Round-5 verification F6: DAILY_UNLIMITED_SENTINEL (-1) reads back as
    // "explicitly unlimited" here, never as a literal $-1 daily cap — and,
    // like a genuinely null daily_usd on a fully-null row, isn't worth a
    // spend round trip.
    const explicitDailyUnlimited = rawDailyUsd === DAILY_UNLIMITED_SENTINEL;
    const dailyUsd = explicitDailyUnlimited ? null : rawDailyUsd;
    const spentUsd = budgetUsd !== null || dailyUsd !== null ? await spendForFeature(supabase, row.user_id as string, row.feature as string) : null;
    // Round-5 verification F6: this is the RAW row, not checkFeature's
    // resolved runtime value — a "full" llm grant (budget/daily both null,
    // not explicitly unlimited) actually gets MEMBRAL_LLM_DEFAULT_DAILY_USD
    // applied at check time when the instance is in `hosted` mode (see
    // feature-flags.ts's resolveFlags). Flag that here rather than showing
    // a bare "unlimited" that would be wrong the moment `current === "hosted"`.
    const hostedDailyDefaultApplies =
      current === "hosted" && row.feature === "llm" && budgetUsd === null && dailyUsd === null && !explicitDailyUnlimited;
    const budgetPart =
      budgetUsd === null && dailyUsd === null
        ? explicitDailyUnlimited
          ? "unlimited (daily explicitly unlimited)"
          : hostedDailyDefaultApplies
            ? `unlimited budget (hosted-mode daily default applies — see MEMBRAL_LLM_DEFAULT_DAILY_USD)`
            : "unlimited"
        : `spent=$${(spentUsd ?? 0).toFixed(4)}` +
          `${budgetUsd !== null ? ` budget=$${budgetUsd}` : ""}` +
          `${dailyUsd !== null ? ` daily=$${dailyUsd}` : ""}`;
    console.log(
      `${row.enabled ? "ENABLED " : "disabled"}  ${row.feature.padEnd(10)} user=${row.user_id} email=${email}  ${budgetPart}` +
        `${row.note ? `  note="${row.note}"` : ""}  updated_at=${row.updated_at}`,
    );
  }
}

// Issue #127 self-hosting decision (2026-09-08, migration 081): `mode
// show|open|hosted` — the app-wide constraints switch. `app_settings` row
// `key='mode'`, value 'open' or 'hosted' (jsonb string) — same table/
// upsert convention as `signups` below. NO ROW = 'open' (matches migration
// 081's `public.app_mode()` SQL function and
// lib/feature-flags.ts's `getAppMode()` — three independent readers of the
// same row, deliberately not one calling another so a bare Postgres client
// gets the same default with no Next.js/app-layer dependency). This script
// stays a standalone reader/writer for the same reason EMBEDDING_PASSES is
// duplicated above rather than imported: lib/feature-flags.ts pulls in
// next/server, unsafe outside the Next.js runtime.
//
// 'open': no product constraints — llm/embeddings enabled and unlimited
// for every user unless an explicit `feature_flags` row (grant/revoke
// above) says otherwise; new signups get an unlimited (NULL)
// conversation_limit. 'hosted': today's constrained defaults — llm off
// unless granted (or MEMBRAL_LLM_DEFAULT_BUDGET_USD > 0), embeddings
// bounded by MEMBRAL_EMBED_DEFAULT_*, new signups capped at
// conversation_limit = 100. See docs/SELF-HOSTING.md's "Constraints: what
// is on by default and how to change it" for the full table.
async function currentAppMode(supabase: SupabaseClient): Promise<{ mode: "open" | "hosted"; error?: string }> {
  const { data, error } = await supabase.from("app_settings").select("value").eq("key", "mode").maybeSingle();
  if (error) return { mode: "open", error: error.message };
  if (!data) return { mode: "open" };
  return { mode: data.value === "hosted" ? "hosted" : "open" };
}

/**
 * Round-5 verification F4: `mode show`'s whole point is letting an operator
 * SEE the exposure before/after flipping the switch — a bare "mode: open"
 * doesn't say how many accounts already have an unlimited conversation_limit
 * as a result. Counts profiles with `conversation_limit is null` (the exact
 * predicate the DEPLOY.md backfill SQL uses) via a head-only `count: "exact"`
 * select — one indexed count query, no rows fetched. Returns null (not 0) on
 * a query error so the caller can distinguish "genuinely zero" from
 * "couldn't check" rather than silently reporting a false all-clear.
 */
async function countNullConversationLimits(supabase: SupabaseClient): Promise<number | null> {
  const { count, error } = await supabase
    .from("profiles")
    .select("id", { count: "exact", head: true })
    .is("conversation_limit", null);
  if (error) return null;
  return count ?? 0;
}

async function mode(supabase: SupabaseClient, subcommand?: string) {
  if (!subcommand || subcommand === "show") {
    const { mode: current, error } = await currentAppMode(supabase);
    if (error) {
      console.error(`mode show failed: ${error}`);
      process.exit(1);
    }
    console.log(`mode: ${current}${current === "open" ? " (no app_settings row — this is the default)" : ""}`);
    const nullLimitCount = await countNullConversationLimits(supabase);
    console.log(
      nullLimitCount === null
        ? "profiles with conversation_limit = NULL (unlimited): (unknown — count query failed)"
        : `profiles with conversation_limit = NULL (unlimited): ${nullLimitCount}`,
    );
    return;
  }

  if (subcommand !== "open" && subcommand !== "hosted") {
    console.error("usage: npx tsx scripts/flags.ts mode <show|open|hosted>");
    process.exit(1);
  }

  const { error } = await supabase
    .from("app_settings")
    .upsert({ key: "mode", value: subcommand, updated_at: new Date().toISOString() }, { onConflict: "key" });
  if (error) {
    console.error(`mode ${subcommand} failed: ${error.message}`);
    process.exit(1);
  }
  console.log(
    `app mode is now "${subcommand}" — ` +
      (subcommand === "open"
        ? "no product constraints (llm/embeddings unlimited for every user unless an explicit feature_flags row says otherwise; new signups get an unlimited conversation_limit)"
        : "today's constrained defaults (llm off unless granted, embeddings budgeted, new signups capped at conversation_limit = 100)"),
  );
}

// Round-2 review HIGH 5: `signups on|off|status` — the DB-level half of the
// signup kill-switch (migration 079's app_settings table + the
// enforce_signups_enabled trigger on auth.users). This is what makes the
// switch real against a direct GoTrue call, not just the Next.js signup
// server action (MEMBRAL_SIGNUPS_DISABLED, lib/env.ts).
//
// #134 adversarial review round 3/4 (R3-B1, R4-M2): this command is the
// operator's deterministic lifecycle owner for the SIBLING
// `signups_disabled_at` marker key (apps/cloud/src/lib/
// signups-disabled-marker.ts — that module's app-side call sites only ever
// STAMP the marker, eagerly, from every request that observes
// MEMBRAL_SIGNUPS_DISABLED; round 4 removed the app-side CLEAR entirely,
// because MEMBRAL_SIGNUPS_DISABLED is read per-deployment on Vercel and a
// stale deployment still carrying the old value could otherwise delete
// shared state out from under every other deployment). `on` below is now
// the ONLY thing that clears this key — run it explicitly, don't rely on
// app traffic. `off` stamps a fresh marker (DB-clock `updated_at
// default now()`, via an insert-if-absent so a marker already stamped by
// app traffic this incident is left untouched); `on` deletes it, so a
// LATER incident starts its own window instead of reusing this one's.
async function signups(supabase: SupabaseClient, subcommand?: string) {
  if (subcommand === "status") {
    const { data, error } = await supabase.from("app_settings").select("value, updated_at").eq("key", "signups_disabled").maybeSingle();
    if (error) {
      console.error(`signups status failed: ${error.message}`);
      process.exit(1);
    }
    const disabled = data?.value === true;
    console.log(`signups: ${disabled ? "OFF (disabled)" : "ON (open)"}${data ? `  updated_at=${data.updated_at}` : "  (no row yet — defaults to ON)"}`);

    const { data: marker, error: markerError } = await supabase
      .from("app_settings")
      .select("updated_at")
      .eq("key", "signups_disabled_at")
      .maybeSingle();
    if (markerError) {
      console.error(`  signups_disabled_at marker read failed: ${markerError.message}`);
    } else {
      console.log(`  signups_disabled_at marker: ${marker ? marker.updated_at : "(none)"}`);
    }
    return;
  }

  if (subcommand !== "on" && subcommand !== "off") {
    console.error("usage: npx tsx scripts/flags.ts signups <on|off|status>");
    process.exit(1);
  }

  const { error } = await supabase
    .from("app_settings")
    .upsert(
      { key: "signups_disabled", value: subcommand === "off", updated_at: new Date().toISOString() },
      { onConflict: "key" },
    );
  if (error) {
    console.error(`signups ${subcommand} failed: ${error.message}`);
    process.exit(1);
  }

  if (subcommand === "off") {
    const { error: markerError } = await supabase
      .from("app_settings")
      .upsert({ key: "signups_disabled_at", value: true }, { onConflict: "key", ignoreDuplicates: true });
    if (markerError) {
      console.error(`warning: signups_disabled_at marker upsert failed: ${markerError.message}`);
    }
  } else {
    const { error: markerError } = await supabase.from("app_settings").delete().eq("key", "signups_disabled_at");
    if (markerError) {
      console.error(`warning: signups_disabled_at marker clear failed: ${markerError.message}`);
    }
  }

  console.log(`signups are now ${subcommand === "off" ? "OFF (disabled — auth.users insert blocked at the DB level)" : "ON (open)"}`);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const supabase = getServiceClient();

  if (command === "signups") {
    const [subcommand] = rest;
    await signups(supabase, subcommand);
    return;
  }

  if (command === "mode") {
    const [subcommand] = rest;
    await mode(supabase, subcommand);
    return;
  }

  const args = parseArgs(rest);
  switch (command) {
    case "grant":
      await grant(supabase, args);
      break;
    case "revoke":
      await revoke(supabase, args);
      break;
    case "list":
      await list(supabase, args);
      break;
    default:
      console.error(
        "usage: npx tsx scripts/flags.ts <grant|revoke|list> --feature llm|embeddings [--email x | --user-id uuid] [--budget-usd N] [--daily-usd N] [--note ...]\n" +
          "       npx tsx scripts/flags.ts signups <on|off|status>\n" +
          "       npx tsx scripts/flags.ts mode <show|open|hosted>",
      );
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
