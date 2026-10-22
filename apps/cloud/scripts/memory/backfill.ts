// Memory v1, source C — backfill over the stored corpus (docs/design/
// memory-v1.md §8 bullet 2, goal 2026-09-13 D2, issue #151).
//
// usage (from apps/cloud):
//   npx tsx scripts/memory/backfill.ts --user <uuid> [--limit N] [--dry-run]
//     [--session <uuid>] [--project <code_project_id>]
//     [--exclude-project <code_project_id>] [--force]
//     [--max-usd 1.00] [--reverify] [--repair-paths] [--no-user-pass]
//   (or: npm run memory:backfill -- --user <uuid> ...)
//
// --no-user-pass (open-weight trial, 2026-09-24): turns the D3 decision C2/C3
// user-turn pass off for this run (real run only — --dry-run/--reverify/
// --repair-paths never call the user pass anyway). Passed straight through
// to runTailCaptureForSession's opts.userPass: false — see that function's
// doc comment for why an OFF user pass never holds back the checkpoint.
//
// --repair-paths (step2d, docs/goals/2026-09-13_memory-v1-build_goal.md;
// issue #151, finding 2/4/15): a NO-LLM repair pass over every LIVE row in
// scope (honors --user/--project/--session, ignores --limit/--force/
// --max-usd), applied in this fixed order —
//   1. `paths[]` rewritten to repo-relative (merge.ts's `toRepoRelativePath`,
//      using the session's `cwd` or its project's `repo_path`), dropping any
//      entry outside the repo.
//   2. dangling-receipt clamp (finding 15): a `turn_idx` matching no turn in
//      its session is clamped to the session's last turn, `verified` forced
//      false.
//   3. turn_role repair (finding 4): corrected from the (possibly just-
//      clamped) receipt turn's ACTUAL role; a `preference` whose receipt
//      turn is an assistant turn is RETIRED (never repaired in place — a
//      preference is definitionally the owner's).
//   4. a final `--reverify` pass (below) over whatever's left live, since
//      steps 2-3 may have moved a `turn_idx` a quote-based re-check can now
//      resolve better.
// Never deletes; only ever retires (preference-on-assistant-turn) or updates
// columns in place.
//
// --project <code_project_id>: the one-repo gate (step2b) — restricts the
// run to one project's sessions instead of the whole corpus, so a prompt
// change can be measured for ~$0.10 before ~$0.60 is spent on everything.
//
// --exclude-project <code_project_id> (step2c): the inverse — the corpus
// re-run, once a one-repo gate has already re-extracted one project under
// the new prompt, uses this to skip re-spending on that project a second
// time. Mutually orthogonal to --project (both may be set; --project scopes
// the candidate set, --exclude-project then narrows it further).
//
// --force: re-extracts sessions that ALREADY carry `props.memory_extraction`
// (normally skipped — see fetchCandidates) under the CURRENT PROMPT_VERSION.
// runTailCaptureForSession does the actual work: ignores the stored
// checkpoint (re-windows and re-extracts the WHOLE session), retires
// (never deletes) that session's prior live `source='extractor'` rows
// before writing the new ones, and records what it retired in
// `props.memory_extraction.previous`.
//
// --dry-run: renders + windows every candidate session (NO LLM calls, no
// network beyond reading Postgres) and prints windows_total + a realistic
// (post-degrade) cost estimate per session, then a grand total — "measure
// before spending" (this repo's own rule, and the goal's step 9). Never
// writes anything.
//
// --reverify (step2c, docs/goals/2026-09-13_memory-v1-build_goal.md; issue
// #151; residual 2's normalizer fix): recomputes `verified`/`turn_idx` for
// every LIVE `session_memories` row in scope (honors --user/--project/
// --session, ignores --limit/--force/--max-usd) via verify.ts's
// `verifyRecords` — the SAME batched receipt re-check the read tools run at
// serve time, now sharing normalize.ts's `normalizeQuote` with the write
// path. NO LLM call, no cost, nothing windowed or re-extracted: this only
// re-runs the grounding check against text already in the database with
// the new normalizer and updates rows whose `verified` or `turn_idx`
// changed. Prints how many flipped false->true, true->false, and how many
// had `turn_idx` repaired. Exits before touching `dryRun`/`realRun`.
// D3 decision B (D-046, 2026-09-24; migration 086): the candidate set is
// every LIVE row plus every row retired with `retire_reason` "unverified…"
// — and no other retired row. A retired-unverified row that now grounds is
// UN-retired (retired_at/retire_reason cleared); a live row that now fails
// is retired with `unverified:<reason>` (D-046: a failing record is never
// served). Rows retired for any other reason (rerun, duplicate, owner-voice
// repair, or pre-086 with no reason) are never touched.
//
// Real run: ONE shared, cost-guarded LlmClient for the whole run
// (createCostGuardedLlm, `capUsdOverride: maxUsd`) so the run-wide cap is
// enforced call-by-call, not just checked between sessions. Incremental and
// re-runnable: a session already carrying `props.memory_extraction` is
// skipped (tail-capture.ts's own checkpoint arithmetic would also no-op it,
// this just avoids the read+render work). Cancellable: one full session
// is awaited at a time, so ctrl-c between sessions loses nothing already
// written — the interrupted session (if any) simply looks "unprocessed"
// again and is retried on the next run.
import { randomUUID } from "node:crypto";
import { config } from "dotenv";

config({ path: ".env.local" });

interface Args {
  userId: string;
  limit: number | undefined;
  dryRun: boolean;
  sessionId: string | undefined;
  projectId: string | undefined;
  excludeProjectId: string | undefined;
  force: boolean;
  maxUsd: number;
  reverify: boolean;
  repairPaths: boolean;
  /** Open-weight trial (2026-09-24): --no-user-pass turns the D3 decision C2/C3 user-turn pass off for this run (runTailCaptureForSession opts.userPass: false) — see that function's doc comment for why this never holds back the checkpoint. */
  userPass: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const userId = get("--user");
  if (!userId) {
    console.error(
      "usage: npx tsx scripts/memory/backfill.ts --user <uuid> [--limit N] [--dry-run] [--session <uuid>] [--project <code_project_id>] [--exclude-project <code_project_id>] [--force] [--max-usd 1.00] [--reverify] [--repair-paths] [--no-user-pass]",
    );
    process.exit(1);
  }
  const limitRaw = get("--limit");
  const maxUsdRaw = get("--max-usd");
  return {
    userId,
    limit: limitRaw ? Number(limitRaw) : undefined,
    dryRun: argv.includes("--dry-run"),
    sessionId: get("--session"),
    projectId: get("--project"),
    excludeProjectId: get("--exclude-project"),
    force: argv.includes("--force"),
    maxUsd: maxUsdRaw ? Number(maxUsdRaw) : 1.0,
    reverify: argv.includes("--reverify"),
    repairPaths: argv.includes("--repair-paths"),
    userPass: !argv.includes("--no-user-pass"),
  };
}

interface ReverifyRow {
  id: string;
  code_session_id: string;
  turn_idx: number;
  kind: "outcome" | "decision" | "learning" | "blocker" | "preference";
  text: string;
  quote: string | null;
  ref: string | null;
  verified: boolean;
  turn_role: "user" | "assistant";
  retired_at: string | null;
  retire_reason: string | null;
  extraction_pass: string | null;
}

/**
 * --reverify (step2c, residual 2): no LLM calls, no windowing — just
 * verify.ts's own batched receipt re-check run against whatever text is
 * already in the database, with whatever normalizer verify.ts currently
 * uses (normalize.ts's `normalizeQuote` as of this commit). Only rows whose
 * `verified` or `turn_idx` actually changed are written back.
 */
async function reverify(args: Args): Promise<void> {
  const { getServiceClient: getServiceSupabase } = await import("../../src/lib/db/clients");
  const { selectAllRows } = await import("../../src/lib/util/pagination");
  const { verifyRecords } = await import("../../src/lib/memory/verify");
  const { REVERIFY_SCOPE_OR_FILTER, planReverifyUpdate } = await import("../../src/lib/memory/write");

  const supabase = getServiceSupabase();
  const rows = (await selectAllRows((from, to) => {
    let q = supabase
      .from("session_memories")
      .select(
        "id, code_session_id, turn_idx, kind, text, quote, ref, verified, turn_role, retired_at, retire_reason, extraction_pass",
      )
      .eq("user_id", args.userId)
      .or(REVERIFY_SCOPE_OR_FILTER);
    if (args.projectId) q = q.eq("code_project_id", args.projectId);
    if (args.sessionId) q = q.eq("code_session_id", args.sessionId);
    return q.order("created_at", { ascending: true }).range(from, to);
  })) as ReverifyRow[];

  const retiredUnverifiedInScope = rows.filter((r) => r.retired_at !== null).length;
  console.log(
    `[memory:backfill] --reverify: ${rows.length - retiredUnverifiedInScope} live + ${retiredUnverifiedInScope} retired-unverified row(s) in scope (project=${args.projectId ?? "(all)"})`,
  );

  const results = await verifyRecords(
    supabase,
    rows.map((r) => ({
      id: r.id,
      code_session_id: r.code_session_id,
      turn_idx: r.turn_idx,
      kind: r.kind,
      text: r.text,
      quote: r.quote,
      ref: r.ref,
      extraction_pass: r.extraction_pass,
    })),
  );

  let unretired = 0;
  let retiredUnverified = 0;
  let turnRoleRepaired = 0;
  let flippedToVerified = 0;
  let flippedToUnverified = 0;
  let turnIdxRepaired = 0;
  let quotesResnapped = 0;
  let updated = 0;
  for (const row of rows) {
    const outcome = results.get(row.id);
    if (!outcome) continue;
    // D3 decision B: write.ts's planReverifyUpdate — un-retire only a row
    // retired as unverified that now grounds; retire a live row that fails.
    const plan = planReverifyUpdate(row, outcome, new Date().toISOString());
    const update = plan.update;
    if (!update) continue;

    if (plan.verifiedChanged) {
      if (outcome.verified) flippedToVerified++;
      else flippedToUnverified++;
    }
    if (plan.turnIdxChanged) turnIdxRepaired++;
    if (plan.quoteChanged) quotesResnapped++;
    if (plan.turnRoleChanged) turnRoleRepaired++;
    if (plan.unretire) unretired++;
    if (plan.retire) retiredUnverified++;

    const { error } = await supabase.from("session_memories").update(update).eq("id", row.id);
    if (error) {
      console.error(`  ${row.id}: update failed — ${error.message}`);
      continue;
    }
    updated++;
  }

  console.log(
    `\n[memory:backfill] --reverify done. checked=${rows.length} updated=${updated} flipped_to_verified=${flippedToVerified} flipped_to_unverified=${flippedToUnverified} turn_idx_repaired=${turnIdxRepaired} turn_role_repaired=${turnRoleRepaired} quotes_resnapped=${quotesResnapped} unretired=${unretired} retired_unverified=${retiredUnverified}`,
  );
}

interface RepairMemoryRow {
  id: string;
  code_session_id: string;
  code_project_id: string;
  turn_idx: number;
  turn_role: "user" | "assistant";
  kind: "outcome" | "decision" | "learning" | "blocker" | "preference";
  paths: string[];
}

interface RepairSessionRow {
  id: string;
  cwd: string | null;
  code_project_id: string;
}

interface RepairTurnRow {
  session_id: string;
  idx: number;
  role: "user" | "assistant";
}

/**
 * --repair-paths: see this file's header for the fixed order (paths ->
 * dangling clamp -> turn_role repair/preference-retire -> final --reverify).
 * No LLM call. Scoped by --user (required) and, optionally, --project/
 * --session; --limit/--force/--max-usd are ignored (this always covers every
 * live row in scope).
 */
async function repairPaths(args: Args): Promise<void> {
  const { getServiceClient: getServiceSupabase } = await import("../../src/lib/db/clients");
  const { selectAllRows } = await import("../../src/lib/util/pagination");
  const { toRepoRelativePath } = await import("../../src/lib/memory/paths");

  const supabase = getServiceSupabase();

  const rows = (await selectAllRows((from, to) => {
    let q = supabase
      .from("session_memories")
      .select("id, code_session_id, code_project_id, turn_idx, turn_role, kind, paths")
      .eq("user_id", args.userId)
      .is("retired_at", null);
    if (args.projectId) q = q.eq("code_project_id", args.projectId);
    if (args.sessionId) q = q.eq("code_session_id", args.sessionId);
    return q.order("created_at", { ascending: true }).range(from, to);
  })) as RepairMemoryRow[];

  console.log(`[memory:backfill] --repair-paths: ${rows.length} live row(s) in scope (user=${args.userId})`);
  if (rows.length === 0) {
    console.log("[memory:backfill] --repair-paths: nothing to repair.");
    return;
  }

  const sessionIds = [...new Set(rows.map((r) => r.code_session_id))];
  const sessionsData = (await selectAllRows((from, to) =>
    supabase.from("code_sessions").select("id, cwd, code_project_id").in("id", sessionIds).range(from, to),
  )) as RepairSessionRow[];
  const sessionCwd = new Map<string, string | null>();
  const projectIdsNeedingRepoPath = new Set<string>();
  for (const s of sessionsData) {
    sessionCwd.set(s.id, s.cwd);
    if (!s.cwd) projectIdsNeedingRepoPath.add(s.code_project_id);
  }
  const projectRepoPath = new Map<string, string | null>();
  if (projectIdsNeedingRepoPath.size > 0) {
    const projRes = await supabase
      .from("code_projects")
      .select("id, repo_path")
      .in("id", [...projectIdsNeedingRepoPath]);
    if (projRes.error) throw new Error(`--repair-paths: code_projects read failed: ${projRes.error.message}`);
    for (const p of (projRes.data ?? []) as { id: string; repo_path: string | null }[]) {
      projectRepoPath.set(p.id, p.repo_path);
    }
  }
  const repoPathFor = (sessionId: string, codeProjectId: string): string | undefined =>
    sessionCwd.get(sessionId) || projectRepoPath.get(codeProjectId) || undefined;

  const turnsData = (await selectAllRows((from, to) =>
    supabase
      .from("code_session_turns")
      .select("session_id, idx, role")
      .in("session_id", sessionIds)
      .order("session_id", { ascending: true })
      .order("idx", { ascending: true })
      .range(from, to),
  )) as RepairTurnRow[];
  const turnsBySession = new Map<string, RepairTurnRow[]>();
  for (const t of turnsData) {
    const arr = turnsBySession.get(t.session_id) ?? [];
    arr.push(t);
    turnsBySession.set(t.session_id, arr);
  }

  let pathsRewritten = 0;
  let danglingClamped = 0;
  let turnRoleCorrected = 0;
  let preferenceRetiredAssistant = 0;
  const toRetire: string[] = [];
  const patches = new Map<string, Record<string, unknown>>();
  const queuePatch = (id: string, patch: Record<string, unknown>) => {
    patches.set(id, { ...patches.get(id), ...patch });
  };

  for (const row of rows) {
    const turns = turnsBySession.get(row.code_session_id) ?? [];
    let turnIdx = row.turn_idx;
    let turn = turns.find((t) => t.idx === turnIdx);

    if (!turn && turns.length > 0) {
      turnIdx = Math.max(...turns.map((t) => t.idx));
      turn = turns.find((t) => t.idx === turnIdx);
      danglingClamped++;
      queuePatch(row.id, { turn_idx: turnIdx, verified: false });
    }

    let retiring = false;
    if (turn) {
      if (row.kind === "preference" && turn.role !== "user") {
        toRetire.push(row.id);
        preferenceRetiredAssistant++;
        retiring = true;
      } else if (turn.role !== row.turn_role) {
        queuePatch(row.id, { turn_role: turn.role });
        turnRoleCorrected++;
      }
    }
    if (retiring) continue; // no point repairing paths on a row we're about to retire

    const repoPath = repoPathFor(row.code_session_id, row.code_project_id);
    const newPaths = [
      ...new Set(
        row.paths.map((p) => toRepoRelativePath(p, repoPath)).filter((p): p is string => typeof p === "string"),
      ),
    ];
    const pathsChanged = newPaths.length !== row.paths.length || newPaths.some((p, i) => p !== row.paths[i]);
    if (pathsChanged) {
      queuePatch(row.id, { paths: newPaths });
      pathsRewritten++;
    }
  }

  const retireSet = new Set(toRetire);
  let patched = 0;
  for (const [id, patch] of patches) {
    if (retireSet.has(id)) continue;
    const { error } = await supabase.from("session_memories").update(patch).eq("user_id", args.userId).eq("id", id);
    if (error) {
      console.error(`  ${id}: patch failed — ${error.message}`);
      continue;
    }
    patched++;
  }

  if (toRetire.length > 0) {
    const retiredAt = new Date().toISOString();
    const { error } = await supabase
      .from("session_memories")
      .update({ retired_at: retiredAt, retire_reason: "preference_assistant_turn" })
      .eq("user_id", args.userId)
      .in("id", toRetire);
    if (error) throw new Error(`--repair-paths: retire failed: ${error.message}`);
  }

  console.log(
    `[memory:backfill] --repair-paths done. rows_scanned=${rows.length} rows_patched=${patched} paths_rewritten=${pathsRewritten} dangling_clamped=${danglingClamped} turn_role_corrected=${turnRoleCorrected} preference_retired_assistant=${preferenceRetiredAssistant}`,
  );

  // step2d finding 2 ("Rows whose quote was scrubbed by the old rule are
  // re-verified by the repair pass"): a final --reverify sweep over whatever
  // is left live in this same scope, since the turn_idx clamp/repair above
  // can change what a quote-based re-check resolves.
  await reverify(args);
}

interface CandidateRow {
  id: string;
  code_project_id: string;
  props: Record<string, unknown> | null;
  started_at: string | null;
}

/**
 * `force`: keeps sessions that already carry `props.memory_extraction`
 * instead of filtering them out — the whole point of `--force` is to
 * re-extract exactly those (`runTailCaptureForSession(..., {force: true})`
 * does the retire-then-rewrite; see this file's header comment).
 */
async function fetchCandidates(
  supabase: import("@supabase/supabase-js").SupabaseClient,
  userId: string,
  opts: { projectId?: string; excludeProjectId?: string; force?: boolean } = {},
): Promise<CandidateRow[]> {
  const { selectAllRows } = await import("../../src/lib/util/pagination");
  const rows = (await selectAllRows((from, to) => {
    let q = supabase
      .from("code_sessions")
      .select("id, code_project_id, props, started_at")
      .eq("user_id", userId);
    if (opts.projectId) q = q.eq("code_project_id", opts.projectId);
    if (opts.excludeProjectId) q = q.neq("code_project_id", opts.excludeProjectId);
    return q.order("started_at", { ascending: true }).range(from, to);
  })) as CandidateRow[];
  if (opts.force) return rows;
  return rows.filter((r) => !(r.props && typeof r.props === "object" && "memory_extraction" in r.props));
}

async function dryRun(args: Args): Promise<void> {
  const { getServiceClient: getServiceSupabase } = await import("../../src/lib/db/clients");
  const { selectAllRows } = await import("../../src/lib/util/pagination");
  const { renderSessionHeader, renderTurnLines } = await import("../../src/lib/memory/render");
  const { buildWindows, fetchChatPrecontext, renderPrecontextBlock } = await import("../../src/lib/memory/windows");
  const { resolveSessionBudgetUsd, selectWindowsWithinBudget } = await import("../../src/lib/memory/budget");

  const supabase = getServiceSupabase();
  let candidates = await fetchCandidates(supabase, args.userId, {
    projectId: args.projectId,
    excludeProjectId: args.excludeProjectId,
    force: args.force,
  });
  if (args.sessionId) candidates = candidates.filter((c) => c.id === args.sessionId);
  if (args.limit) candidates = candidates.slice(0, args.limit);

  const sessionBudgetUsd = resolveSessionBudgetUsd();
  let grandTotal = 0;
  let totalWindows = 0;
  const scope = args.force ? "force re-extract" : "unprocessed";
  console.log(`[memory:backfill] DRY RUN — ${candidates.length} ${scope} session(s), session budget $${sessionBudgetUsd}`);

  for (const c of candidates) {
    const sessionRes = await supabase
      .from("code_sessions")
      .select("id, user_id, code_project_id, git_branch, model, started_at, ended_at, duration_seconds, files_touched, props")
      .eq("id", c.id)
      .single();
    if (sessionRes.error || !sessionRes.data) {
      console.log(`  ${c.id}: SKIP (read failed: ${sessionRes.error?.message ?? "no row"})`);
      continue;
    }
    const session = sessionRes.data as {
      id: string;
      user_id: string;
      code_project_id: string;
      git_branch: string | null;
      model: string | null;
      started_at: string | null;
      ended_at: string | null;
      duration_seconds: number | null;
      files_touched: string[];
      props: Record<string, unknown> | null;
    };
    const turns = (await selectAllRows((from, to) =>
      supabase
        .from("code_session_turns")
        .select("idx, role, kind, text, tool_name, file_path, ts, props")
        .eq("session_id", c.id)
        .order("idx", { ascending: true })
        .range(from, to),
    )) as import("../../src/lib/memory/render").TurnRow[];

    const header = renderSessionHeader(
      { ...session, source: "claude-code", source_session_id: session.id, project_display_name: null },
      turns,
    );
    const precontext = await fetchChatPrecontext(supabase, args.userId, c.code_project_id);
    const headerAndPrecontextChars = header.text.length + renderPrecontextBlock(precontext).length;
    const windows = buildWindows(renderTurnLines(turns));
    const degrade = selectWindowsWithinBudget(windows, {
      budgetUsd: sessionBudgetUsd,
      model: "gpt-4o-mini",
      headerAndPrecontextChars,
    });
    grandTotal += degrade.estimatedCostUsd;
    totalWindows += windows.length;
    console.log(
      `  ${c.id}: turns=${turns.length} windows_total=${windows.length} windows_selected=${degrade.selected.length} est=$${degrade.estimatedCostUsd.toFixed(4)}`,
    );
  }

  console.log(`\n[memory:backfill] DRY RUN totals: sessions=${candidates.length} windows_total=${totalWindows} projected_cost=$${grandTotal.toFixed(4)}`);
  if (grandTotal > args.maxUsd) {
    console.log(`[memory:backfill] STOP: projected cost $${grandTotal.toFixed(4)} exceeds --max-usd $${args.maxUsd.toFixed(2)} — not running for real.`);
  } else {
    console.log(`[memory:backfill] projected cost is within --max-usd $${args.maxUsd.toFixed(2)} — safe to run for real.`);
  }
}

async function realRun(args: Args): Promise<void> {
  const { getServiceClient: getServiceSupabase } = await import("../../src/lib/db/clients");
  const { createCostGuardedLlm } = await import("../../src/lib/llm/spend-ledger");
  const { runTailCaptureForSession } = await import("../../src/lib/memory/tail-capture");

  const supabase = getServiceSupabase();
  let candidates = await fetchCandidates(supabase, args.userId, {
    projectId: args.projectId,
    excludeProjectId: args.excludeProjectId,
    force: args.force,
  });
  if (args.sessionId) candidates = candidates.filter((c) => c.id === args.sessionId);
  if (args.limit) candidates = candidates.slice(0, args.limit);

  const runId = randomUUID();
  // Operator script (issue #126 convention: bootstrap.ts/seed-tusk-demo.ts
  // etc. all bypass the per-user gate — a --user is supplied by hand by a
  // trusted operator, never HTTP-reachable). capUsdOverride enforces the
  // --max-usd run-wide cap call-by-call, not just between sessions.
  const guarded = await createCostGuardedLlm(supabase, args.userId, {
    runId,
    bypassFeatureGate: true,
    capUsdOverride: args.maxUsd,
  });
  if (!guarded.ok) {
    console.error(`[memory:backfill] cost guard refused: ${JSON.stringify(guarded)}`);
    process.exit(1);
  }

  console.log(
    `[memory:backfill] run_id=${runId} candidates=${candidates.length} project=${args.projectId ?? "(all)"} force=${args.force} max_usd=$${args.maxUsd.toFixed(2)} user_pass=${args.userPass}`,
  );
  // R2-N2 (review round 3): a plain --no-user-pass real run holds the
  // checkpoint back (S3 fix, tail-capture.ts) so a later default run can
  // still cover those turns — but the model is non-deterministic, so a
  // REPEATED --no-user-pass run keeps re-extracting the same turn range and
  // upsert only dedupes an identical content_hash, not a near-identical
  // reworded record. Nudge the operator toward --force (re-extract on
  // purpose) or --dry-run (no writes at all) instead of an unbounded rerun.
  if (!args.userPass && !args.force && !args.dryRun) {
    console.warn(
      "[memory:backfill] WARNING: --no-user-pass without --force or --dry-run — repeated runs will re-extract the same user-pass turn range and may write near-duplicate records (upsert only dedupes an identical content_hash).",
    );
  }
  let processed = 0;
  let totalRecords = 0;
  try {
    for (const c of candidates) {
      if (guarded.llm.overBudget()) {
        console.log(`[memory:backfill] STOP: run cap $${args.maxUsd.toFixed(2)} reached — ${candidates.length - processed} session(s) left unprocessed (resumable next run).`);
        break;
      }
      try {
        const summary = await runTailCaptureForSession({ supabase, llm: guarded.llm }, args.userId, c.id, {
          runId,
          force: args.force,
          userPass: args.userPass,
        });
        processed++;
        totalRecords += summary.recordsWritten;
        console.log(
          `  [${processed}/${candidates.length}] ${c.id}: windows=${summary.windowsExtracted}/${summary.windowsTotal} records=${summary.recordsWritten} verified=${summary.recordsVerified} retired_unverified=${summary.recordsRetiredUnverified} budget_hit=${summary.budgetHit} dropped_pii=${summary.droppedPii} repaired_pii=${summary.repairedPii} repaired_ref=${summary.repairedRef} retried_empty=${summary.retriedEmpty} retry_recovered=${summary.retryRecovered} retry_skipped_budget=${summary.retrySkippedBudget} retry_failed=${summary.retryFailed} cost=$${summary.costUsd.toFixed(4)} running_total=$${guarded.llm.totalCostUsd.toFixed(4)}`,
        );
      } catch (err) {
        console.error(`  ${c.id}: FAILED — ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } finally {
    await guarded.flushSpend();
  }
  console.log(`\n[memory:backfill] done. sessions_processed=${processed} records_written=${totalRecords} total_cost=$${guarded.llm.totalCostUsd.toFixed(4)}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.repairPaths) await repairPaths(args);
  else if (args.reverify) await reverify(args);
  else if (args.dryRun) await dryRun(args);
  else await realRun(args);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
