#!/usr/bin/env node
// `npm run smoke` — the maintainer-run smoke test (goal 2026-09-12 W8/D7,
// issue #144). End-to-end against a REAL local Supabase + a real dev server
// + the REAL built CLI: no mocked Supabase client, no fake HTTP layer (the
// goal's own audit found 0 browser/CLI/real-DB tests before this).
//
// Order (each step logs a clear "==> " line and the whole thing exits
// non-zero on the first failure):
//   (a) local Supabase reachable
//   (b) a server answers on :3001 (reused if already up, started
//       otherwise, and only ever stopped here if THIS run started it).
//       SMOKE_MODE=start runs the production build (`next start`, the
//       default on CI: `next dev` compiled a cold session page in 15-20 s
//       and blew Playwright's 30 s budget on every red main run since
//       b275709); SMOKE_MODE=dev keeps `next dev` (the default locally,
//       where the maintainer's build is often mid-edit).
//   (c) throwaway user + an unscoped API key minted through the real
//       POST /api/keys route (a JWT from signInWithPassword, not a
//       hand-inserted DB row)
//   (d) the built CLI imports one Claude Code fixture + one opencode
//       fixture (a temp SQLite db built from the JSON fixture) + one
//       Copilot CLI fixture (a temp Copilot home with session-state/) + one
//       Codex fixture (a temp Codex home with sessions/YYYY/MM/DD/)
//   (e) GET .../api/code-sessions/stats confirms exactly 4 sessions landed
//       (see the note at ASSERT_SESSION_COUNT below — there is no
//       GET /api/code-sessions list route to call)
//   (e2) memory extraction ran through POST /api/memory/extract-next: every
//       queued session leaves 'pending'/'running' (memory_extraction_queue)
//   (f) Playwright: sign in as the throwaway user, open one session page
//       and /code/stats, assert real content renders
//   (g) teardown: delete the throwaway user (cascades), stop the dev
//       server if this run started it, clean up temp fixture dirs
//
// Every throwaway resource is timestamp-unique and every step is safe to
// re-run: a fresh user + fresh temp dirs each time, teardown always runs
// (even on failure), and nothing here ever touches another user's data.
import { createClient } from "@supabase/supabase-js";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildOpencodeFixtureDb } from "./lib/opencode-fixture.mjs";
import { resolveSmokeConfig } from "./lib/env.mjs";
import { resolveSmokeMode } from "./lib/mode.mjs";
import { shiftClaudeCodeJsonl } from "./lib/shift-fixture-time.mjs";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI_ENTRY = join(REPO_ROOT, "packages/cli/dist/index.js");
const CLAUDE_CODE_FIXTURE = join(
  REPO_ROOT,
  "packages/core/src/__tests__/fixtures/claude-code/usage-session.jsonl",
);
const OPENCODE_FIXTURE_JSON = join(REPO_ROOT, "fixtures/sessions/opencode/small-session.json");
const COPILOT_SESSION_ID = "7c0f3a52-1d4e-4b8a-9f61-2e5d8c4b1a01";
const COPILOT_FIXTURE = join(
  REPO_ROOT,
  "fixtures/sessions/copilot-cli/session-state",
  COPILOT_SESSION_ID,
  "events.jsonl",
);
const CODEX_ROLLOUT = "rollout-2026-05-14T09-12-01-5b1e9c2a-7d40-4f8e-a3b6-0c9d2e4f6a11.jsonl";
const CODEX_FIXTURE = join(REPO_ROOT, "fixtures/sessions/codex/sessions/2026/05/14", CODEX_ROLLOUT);
const CLAUDE_CODE_SESSION_ID = "44444444-4444-4444-8444-444444444444";
// Both fixtures' original timestamps are shifted to a few days before "now"
// at import time (see lib/shift-fixture-time.mjs) — a generous window here
// is just cheap insurance, not load-bearing.
const STATS_WINDOW_DAYS = 90;

const args = process.argv.slice(2);
function flagValue(name) {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : undefined;
}

const DEFAULT_BASE_URL = "http://localhost:3001";
const BASE_URL = (flagValue("base-url") ?? process.env.SMOKE_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
/** "start" (next start on the turbo build) or "dev" (next dev). CI defaults to start. */
const SMOKE_MODE = resolveSmokeMode(process.env);

let devServerProc = null;
let claudeCodeRootTmp = null;
let opencodeRootTmp = null;
let copilotRootTmp = null;
let codexRootTmp = null;
let throwawayUserId = null;
let supabaseAdmin = null;
let exitCode = 0;
/** Everything the dev server this run started printed — (e3) scans it for reconcile failures. */
let devServerOutput = "";

function log(msg) {
  console.log(`==> ${msg}`);
}
function warn(msg) {
  console.warn(`!! ${msg}`);
}

class SmokeFailure extends Error {}

function fail(msg) {
  throw new SmokeFailure(msg);
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(label, checkFn, { timeoutMs = 60_000, intervalMs = 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const ok = await checkFn();
      if (ok) return;
    } catch (err) {
      lastErr = err;
    }
    await sleep(intervalMs);
  }
  fail(`timed out waiting for ${label}${lastErr ? ` (last error: ${lastErr.message ?? lastErr})` : ""}`);
}

async function urlAnswers(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return res.status < 500;
  } catch {
    return false;
  }
}

function runCli(cliArgs, env) {
  log(`membral ${cliArgs.join(" ")}`);
  const res = spawnSync(process.execPath, [CLI_ENTRY, ...cliArgs], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  if (res.stdout) process.stdout.write(res.stdout);
  if (res.stderr) process.stderr.write(res.stderr);
  return res.status ?? 1;
}

// ---------------------------------------------------------------------------
// (a) Supabase reachable
// ---------------------------------------------------------------------------
async function checkSupabase(config) {
  log(`(a) checking local Supabase at ${config.supabaseUrl}`);
  if (!config.supabaseUrl || !config.supabaseAnonKey || !config.supabaseServiceRoleKey) {
    fail(
      "Missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY " +
        "(checked process.env, then apps/cloud/.env.local). Run `cd apps/cloud && npx supabase start`, " +
        "then `npx supabase status -o env` to fill apps/cloud/.env.local.",
    );
  }
  const healthUrl = `${config.supabaseUrl.replace(/\/+$/, "")}/auth/v1/health`;
  const reachable = await urlAnswers(healthUrl);
  if (!reachable) {
    fail(
      `Local Supabase is not reachable at ${config.supabaseUrl} (${healthUrl} did not respond). ` +
        "Run `cd apps/cloud && npx supabase start` and re-run `npm run smoke`.",
    );
  }
  log("    Supabase is up.");
}

// ---------------------------------------------------------------------------
// (b) dev server on :3001
// ---------------------------------------------------------------------------
async function ensureDevServer() {
  log(`(b) checking for a dev server at ${BASE_URL}`);
  if (await urlAnswers(BASE_URL)) {
    log("    already answering — reusing it (this run will not stop it).");
    return;
  }
  const port = new URL(BASE_URL).port || "3001";
  const script = SMOKE_MODE === "start" ? "start" : "dev";
  if (SMOKE_MODE === "start" && !existsSync(join(REPO_ROOT, "apps/cloud/.next/BUILD_ID"))) {
    fail(
      "SMOKE_MODE=start needs a production build at apps/cloud/.next — run `npx turbo build` first " +
        "(or set SMOKE_MODE=dev). Never build @membral/cloud while `next dev` is running.",
    );
  }
  log(`    nothing answering — starting \`npm run ${script} --workspace=@membral/cloud -- -p ${port}\` (SMOKE_MODE=${SMOKE_MODE})`);
  // detached: true puts this child in its OWN process group (pgid === its
  // own pid) — `npm run dev` spawns `next dev`, which spawns the actual
  // next-server: killing just the npm PID does not reliably kill that
  // whole tree (npm on macOS was observed leaving next-server as an
  // orphan, `PPID 1`, still bound to :3001, after `npm run dev`'s own
  // process exited). Signaling the negative pid in stopDevServer() below
  // sends the signal to every process in the group at once.
  devServerProc = spawn("npm", ["run", script, "--workspace=@membral/cloud", "--", "-p", port], {
    cwd: REPO_ROOT,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  devServerProc.stdout?.on("data", (d) => {
    devServerOutput += d;
    process.stdout.write(`[dev] ${d}`);
  });
  devServerProc.stderr?.on("data", (d) => {
    devServerOutput += d;
    process.stderr.write(`[dev] ${d}`);
  });
  devServerProc.on("exit", (code, signal) => {
    if (code !== null && code !== 0) warn(`dev server exited early (code ${code}, signal ${signal})`);
  });
  await waitFor(`dev server at ${BASE_URL}`, () => urlAnswers(BASE_URL), { timeoutMs: 120_000, intervalMs: 1500 });
  log("    dev server is up.");
}

function stopDevServer() {
  if (!devServerProc) return;
  log("(g) stopping the dev server this run started");
  try {
    // Negative pid == "signal the whole process group" (POSIX) — see the
    // `detached: true` comment above for why the plain non-group form isn't
    // reliable here.
    process.kill(-devServerProc.pid, "SIGTERM");
  } catch (err) {
    warn(`failed to signal the dev server process group: ${err.message ?? err}`);
  }
  devServerProc = null;
}

// ---------------------------------------------------------------------------
// (c) throwaway user + API key
// ---------------------------------------------------------------------------
async function createThrowawayUserAndKey(config) {
  log("(c) creating a throwaway user + minting an API key");
  supabaseAdmin = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const email = `smoke+${Date.now()}@example.com`;
  const password = `smoke-${Math.random().toString(36).slice(2)}-${Date.now()}`;

  const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (createErr || !created?.user) {
    fail(`failed to create throwaway user: ${createErr?.message ?? "no user returned"}`);
  }
  throwawayUserId = created.user.id;
  log(`    created ${email} (${throwawayUserId})`);

  // A plain anon client, signed in as the throwaway user, gives us the same
  // Supabase JWT the dashboard itself would carry — POST /api/keys accepts
  // exactly that (see apps/cloud/src/app/api/keys/route.ts's getUser()), so
  // this mints a key the same way a real signed-in user would, rather than
  // hand-inserting a row into api_keys/profiles.
  const anon = createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: signedIn, error: signInErr } = await anon.auth.signInWithPassword({ email, password });
  if (signInErr || !signedIn?.session) {
    fail(`failed to sign in as the throwaway user: ${signInErr?.message ?? "no session returned"}`);
  }
  const jwt = signedIn.session.access_token;

  const keyRes = await fetch(`${BASE_URL}/api/keys`, {
    method: "POST",
    headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json" },
    body: "{}",
  });
  if (!keyRes.ok) {
    fail(`POST /api/keys returned ${keyRes.status}: ${await keyRes.text()}`);
  }
  const keyBody = await keyRes.json();
  if (!keyBody.api_key || !keyBody.api_key.startsWith("lls_")) {
    fail(`POST /api/keys did not return an lls_ API key: ${JSON.stringify(keyBody)}`);
  }
  log(`    minted an unscoped API key (${keyBody.api_key.slice(0, 8)}…)`);

  return { email, password, apiKey: keyBody.api_key, userId: throwawayUserId };
}

// ---------------------------------------------------------------------------
// (d) build fixtures + run the built CLI
// ---------------------------------------------------------------------------
async function importFixtures(apiKey) {
  log("(d) building fixtures and importing via the built CLI");
  if (!existsSync(CLI_ENTRY)) {
    fail(`Built CLI not found at ${CLI_ENTRY} — run \`npx turbo build --filter=@membral/cli\` first.`);
  }

  // --- Claude Code fixture: detect() walks <root>/<project>/<session>.jsonl
  // — reuse packages/core's own usage-session.jsonl fixture (real model
  // names + populated usage, exercised by @membral/core's parser tests
  // already) rather than adding a second copy under fixtures/sessions/.
  claudeCodeRootTmp = mkdtempSync(join(tmpdir(), "membral-smoke-claude-code-"));
  const projectDir = join(claudeCodeRootTmp, "acme-webapp");
  await mkdir(projectDir, { recursive: true });
  // Shifted to land a few days before "now" — see shift-fixture-time.mjs:
  // /code/stats (the page) hardcodes a 30-day window with no override, so
  // the fixture's original fixed 2026-02-01 date would import fine but
  // never render on that page.
  const raw = shiftClaudeCodeJsonl(readFileSync(CLAUDE_CODE_FIXTURE, "utf8"));
  await writeFile(join(projectDir, `${CLAUDE_CODE_SESSION_ID}.jsonl`), raw);
  log(`    claude-code fixture root: ${claudeCodeRootTmp}`);

  // --- opencode fixture: a real opencode.db built from the JSON fixture
  // (the CLI reads SQLite for opencode, not JSON — see opencode-export.ts).
  //
  // #143 follow-up: `--root` now applies to whichever `--source` is given
  // (it used to be silently ignored for anything but claude-code — index.ts
  // applied it only when `--source claude-code` was given/implied — which
  // meant this smoke test previously had to fake `$HOME` to keep the
  // opencode import off this machine's REAL `~/.local/share/opencode`, see
  // git history for that workaround). `--source opencode --root <dir>` is
  // now the supported way to point the import at a throwaway db, so this
  // just builds the fixture into a plain temp dir and passes it as --root.
  opencodeRootTmp = mkdtempSync(join(tmpdir(), "membral-smoke-opencode-root-"));
  await buildOpencodeFixtureDb(OPENCODE_FIXTURE_JSON, opencodeRootTmp);
  log(`    opencode fixture db: ${opencodeRootTmp}/opencode.db`);

  // --- Copilot CLI fixture: detect() walks <home>/session-state/<id>/events.jsonl.
  // Same envelope `timestamp` field as Claude Code lines, so the same shifter applies.
  copilotRootTmp = mkdtempSync(join(tmpdir(), "membral-smoke-copilot-"));
  const copilotSessionDir = join(copilotRootTmp, "session-state", COPILOT_SESSION_ID);
  await mkdir(copilotSessionDir, { recursive: true });
  await writeFile(join(copilotSessionDir, "events.jsonl"), shiftClaudeCodeJsonl(readFileSync(COPILOT_FIXTURE, "utf8")));
  log(`    copilot-cli fixture home: ${copilotRootTmp}`);

  // --- Codex fixture: detect() walks <home>/sessions/**/rollout-*.jsonl.
  // Same envelope `timestamp` field, so the same shifter applies.
  codexRootTmp = mkdtempSync(join(tmpdir(), "membral-smoke-codex-"));
  const codexDayDir = join(codexRootTmp, "sessions", "2026", "05", "14");
  await mkdir(codexDayDir, { recursive: true });
  await writeFile(join(codexDayDir, CODEX_ROLLOUT), shiftClaudeCodeJsonl(readFileSync(CODEX_FIXTURE, "utf8")));
  log(`    codex fixture home: ${codexRootTmp}`);

  // MEMBRAL_API_KEY/MEMBRAL_API_URL win over any ~/.membral/credentials.json
  // on this machine (see packages/cli/src/credentials.ts's precedence) —
  // explicit env here, no reliance on any prior `membral login`.
  const uploadEnv = { MEMBRAL_API_KEY: apiKey, MEMBRAL_API_URL: BASE_URL };

  const ccStatus = runCli(["sessions", "--source", "claude-code", "--root", claudeCodeRootTmp], uploadEnv);
  if (ccStatus !== 0) fail(`\`membral sessions --source claude-code\` exited ${ccStatus}`);

  const ocStatus = runCli(["sessions", "--source", "opencode", "--root", opencodeRootTmp], uploadEnv);
  if (ocStatus !== 0) fail(`\`membral sessions --source opencode\` exited ${ocStatus}`);

  const cpStatus = runCli(["sessions", "--source", "copilot-cli", "--root", copilotRootTmp], uploadEnv);
  if (cpStatus !== 0) fail(`\`membral sessions --source copilot-cli\` exited ${cpStatus}`);

  const cxStatus = runCli(["sessions", "--source", "codex", "--root", codexRootTmp], uploadEnv);
  if (cxStatus !== 0) fail(`\`membral sessions --source codex\` exited ${cxStatus}`);

  log("    all four imports exited 0.");
}

// ---------------------------------------------------------------------------
// (e) assert exactly 4 sessions landed
// ---------------------------------------------------------------------------
// NOTE (product gap found by this smoke test, reported rather than fixed
// here — W8 says report, don't fix product code): there is no
// `GET /api/code-sessions` list route. The only GET route under
// /api/code-sessions is `/stats` (lib/code-sessions/auth.ts's
// authenticateCodeSessionsRead — the same unscoped-JWT-or-lls_-key auth as
// the write route). This asserts the session COUNT via that aggregate
// route's `totals.sessions` instead, and fetches the actual session id
// straight from Postgres (service role) to drive the Playwright checks in
// (f) — see the smoke report for the full note.
async function assertSessionCount(apiKey) {
  log("(e) asserting exactly 4 sessions landed (via GET /api/code-sessions/stats)");
  const res = await fetch(`${BASE_URL}/api/code-sessions/stats?days=${STATS_WINDOW_DAYS}`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) fail(`GET /api/code-sessions/stats returned ${res.status}: ${await res.text()}`);
  const body = await res.json();
  const count = body?.totals?.sessions;
  if (count !== 4) {
    fail(`expected exactly 4 sessions, got ${count} (full totals: ${JSON.stringify(body?.totals)})`);
  }
  log(`    totals.sessions === 4 (cost_usd=${body.totals.cost_usd}).`);
}

// ---------------------------------------------------------------------------
// (e2) memory extraction through the queue chain (goal 2026-09-24 review B1)
// ---------------------------------------------------------------------------
// The upload route only queues sessions; POST /api/memory/extract-next
// claims and extracts one per invocation and chains the rest.
//   With a model key: every row must settle and at least one reach 'done'
//   (a real extraction through the chain).
//   Without one (CI sets no OPENAI_API_KEY — review N-m2): the worker cannot
//   build its LLM client, so it releases the first claimed row back to
//   'pending' with last_reason 'no_model_key', attempt uncounted, and stops
//   the chain (P10 re-review N3). That row still proves the upload queued
//   the sessions and the chain claimed one; no LLM call, no spend.
const MEMORY_WAIT_MS = 240_000;
async function assertMemoryExtracted(userId, { serverHasModelKey }) {
  log(
    `(e2) waiting for memory extraction via /api/memory/extract-next (${serverHasModelKey ? "model key set: expect 'done'" : "no model key: expect a 'no_model_key' release"})`,
  );
  const deadline = Date.now() + MEMORY_WAIT_MS;
  const releasedNoKey = (rows) =>
    rows.some((r) => r.status === "pending" && r.last_reason === "no_model_key") &&
    rows.every((r) => r.status !== "running");
  let rows = [];
  while (Date.now() < deadline) {
    const { data, error } = await supabaseAdmin
      .from("memory_extraction_queue")
      .select("session_id, status, attempts, last_reason")
      .eq("user_id", userId);
    if (error) fail(`failed to read memory_extraction_queue: ${error.message}`);
    rows = data ?? [];
    const settled = rows.length > 0 && rows.every((r) => !["pending", "running"].includes(r.status));
    if (settled || (!serverHasModelKey && releasedNoKey(rows))) break;
    await new Promise((r) => setTimeout(r, 3000));
  }
  for (const r of rows) log(`    ${r.session_id}: ${r.status} (attempts=${r.attempts}${r.last_reason ? `, ${r.last_reason}` : ""})`);
  if (rows.length === 0) fail("no memory_extraction_queue rows — the upload route did not queue the imported sessions");
  if (!serverHasModelKey) {
    if (!releasedNoKey(rows)) fail("no model key, but no row was released with last_reason 'no_model_key' — the chain did not run");
    if (rows.some((r) => r.attempts !== 0)) fail("a no_model_key release counted an attempt — it must not burn attempts");
    log("    no model key: the chain claimed a row and released it (no_model_key) — extraction skipped by design.");
    return;
  }
  const unsettled = rows.filter((r) => ["pending", "running"].includes(r.status));
  if (unsettled.length > 0) fail(`${unsettled.length} session(s) still pending/running after ${MEMORY_WAIT_MS / 1000}s`);
  if (!rows.some((r) => r.status === "done")) fail("no session reached 'done' — extraction did not complete through the chain");
  log(`    ${rows.filter((r) => r.status === "done").length}/${rows.length} session(s) extracted (done).`);
}

// ---------------------------------------------------------------------------
// (e3) daily cron reconcile against real Postgres (P10 round 3 R3-M1)
// ---------------------------------------------------------------------------
// Exercises reconcileMemoryExtractionQueue's PostgREST `.or()` filter and
// `props->...` JSON-path selects for real:
//   1. one session is made "extracted, nothing new" (queue 'done',
//      checkpoint = last turn) and the other's queue row is deleted
//      (an upload whose enqueue failed);
//   2. cron run 1: the missing row is re-created (ensure branch) and the
//      done row is left alone (queued_at unchanged — no false positive);
//   3. turn_count is bumped on the done session; cron run 2 requeues it
//      (requeue branch: queued_at moves, status leaves 'done' or is re-done).
// Needs the CRON_SECRET the dev server runs with: smoke sets one when it
// starts the server; a reused server without a known secret skips this step.
async function cron(secret) {
  const res = await fetch(`${BASE_URL}/api/internal/cron/memory-extraction`, {
    headers: { authorization: `Bearer ${secret}` },
  });
  const body = await res.json().catch(() => null);
  if (res.status !== 200) fail(`cron/memory-extraction answered ${res.status}: ${JSON.stringify(body)}`);
  if (body?.reconcile_failed_users !== 0) fail(`cron reconcile did not run cleanly: ${JSON.stringify(body)}`);
  return body;
}

async function queueRow(sessionId) {
  const { data, error } = await supabaseAdmin
    .from("memory_extraction_queue")
    .select("status, queued_at, last_reason")
    .eq("session_id", sessionId)
    .maybeSingle();
  if (error) fail(`failed to read queue row ${sessionId}: ${error.message}`);
  return data;
}

async function assertCronReconcile(userId, cronSecretValue) {
  if (!cronSecretValue) {
    warn("(e3) skipped: reusing a dev server whose CRON_SECRET this run does not know");
    return;
  }
  log("(e3) cron reconcile: ensure a missing queue row, requeue a session whose turns grew");
  const { data: sessions, error } = await supabaseAdmin
    .from("code_sessions")
    .select("id, turn_count, props")
    .eq("user_id", userId)
    .order("id");
  if (error || !sessions || sessions.length < 2) fail(`need 2 sessions for (e3): ${error?.message ?? sessions?.length}`);
  const [grown, missing] = sessions;

  const props = {
    ...(grown.props ?? {}),
    memory_checkpoint_turn_idx: grown.turn_count - 1,
    memory_extraction: { ...(grown.props?.memory_extraction ?? {}), tail_turns_uncovered: 0 },
  };
  delete props.memory_extraction_lock;
  const upd = await supabaseAdmin.from("code_sessions").update({ props }).eq("id", grown.id);
  if (upd.error) fail(`failed to set up the done session: ${upd.error.message}`);
  const done = await supabaseAdmin
    .from("memory_extraction_queue")
    .update({ status: "done", lease_until: null, lease_token: null, dirty: false, last_reason: null })
    .eq("session_id", grown.id);
  if (done.error) fail(`failed to mark the queue row done: ${done.error.message}`);
  const del = await supabaseAdmin.from("memory_extraction_queue").delete().eq("session_id", missing.id);
  if (del.error) fail(`failed to delete the queue row: ${del.error.message}`);
  const before = await queueRow(grown.id);

  const first = await cron(cronSecretValue);
  log(`    cron run 1: ${JSON.stringify(first)}`);
  if (!(await queueRow(missing.id))) fail("reconcile did not re-create the missing queue row (ensure branch)");
  const unchanged = await queueRow(grown.id);
  if (unchanged.status !== "done" || unchanged.queued_at !== before.queued_at) {
    fail(`reconcile requeued a session that did not grow: ${JSON.stringify(unchanged)}`);
  }

  const bump = await supabaseAdmin
    .from("code_sessions")
    .update({ turn_count: grown.turn_count + 1 })
    .eq("id", grown.id);
  if (bump.error) fail(`failed to bump turn_count: ${bump.error.message}`);
  const second = await cron(cronSecretValue);
  log(`    cron run 2: ${JSON.stringify(second)}`);
  if (second.reconciled_requeued < 1) fail(`reconcile did not requeue the grown session: ${JSON.stringify(second)}`);
  const after = await queueRow(grown.id);
  if (after.queued_at === before.queued_at) fail(`grown session's queue row was not requeued: ${JSON.stringify(after)}`);
  log(`    grown session requeued (now ${after.status}${after.last_reason ? `, ${after.last_reason}` : ""}).`);

  if (devServerProc && /"reason":"reconcile_failed"|reconcile failed/.test(devServerOutput)) {
    fail("the dev server logged a reconcile failure");
  }
}

async function fetchOneSessionId(userId) {
  const { data, error } = await supabaseAdmin
    .from("code_sessions")
    .select("id, source, turn_count")
    .eq("user_id", userId)
    .order("started_at", { ascending: true })
    .limit(1);
  if (error) fail(`failed to read back the imported session: ${error.message}`);
  if (!data || data.length === 0) fail("no code_sessions row found for the throwaway user after import");
  return data[0].id;
}

// ---------------------------------------------------------------------------
// (f) Playwright
// ---------------------------------------------------------------------------
function runPlaywright(env) {
  log("(f) running Playwright checks (sign-in, /code/session/<id>, /code/stats)");
  const res = spawnSync(
    "npx",
    ["playwright", "test", "--config", join(REPO_ROOT, "smoke/playwright.config.ts")],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
      stdio: "inherit",
    },
  );
  if (res.status !== 0) fail(`Playwright checks failed (exit ${res.status})`);
  log("    Playwright checks passed.");
}

// ---------------------------------------------------------------------------
// (g) teardown
// ---------------------------------------------------------------------------
async function teardown() {
  log("(g) tearing down");
  if (throwawayUserId && supabaseAdmin) {
    const { error } = await supabaseAdmin.auth.admin.deleteUser(throwawayUserId);
    if (error) {
      warn(`failed to delete throwaway user ${throwawayUserId}: ${error.message}`);
    } else {
      // profiles/code_sessions/code_session_turns/api_keys all carry
      // `references ... on delete cascade` back to auth.users (see
      // migrations 001/029/052) — verify the cascade actually emptied this
      // user's rows rather than assuming it, since a future migration could
      // change that without this test noticing otherwise.
      const { count, error: countErr } = await supabaseAdmin
        .from("code_sessions")
        .select("id", { count: "exact", head: true })
        .eq("user_id", throwawayUserId);
      if (!countErr && count && count > 0) {
        warn(`${count} code_sessions row(s) survived user deletion — cascade did not clean up as expected`);
      } else if (!countErr) {
        log("    throwaway user deleted; code_sessions cascade confirmed empty.");
      }
    }
  }
  if (claudeCodeRootTmp) rmSync(claudeCodeRootTmp, { recursive: true, force: true });
  if (opencodeRootTmp) rmSync(opencodeRootTmp, { recursive: true, force: true });
  if (copilotRootTmp) rmSync(copilotRootTmp, { recursive: true, force: true });
  if (codexRootTmp) rmSync(codexRootTmp, { recursive: true, force: true });
  stopDevServer();
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  const config = resolveSmokeConfig(REPO_ROOT);
  await checkSupabase(config);
  // (e3) calls the cron route: a server this run starts gets a known secret
  // (process env wins over .env.local in next dev).
  let cronSecretValue = config.cronSecret;
  const reusingServer = await urlAnswers(BASE_URL);
  if (!reusingServer && !cronSecretValue) {
    cronSecretValue = randomBytes(24).toString("hex");
    process.env.CRON_SECRET = cronSecretValue;
  }
  // The upload/kick/cron triggers POST extract-next to NEXT_PUBLIC_APP_URL
  // (lib/memory/extraction-trigger.ts), falling back to http://localhost:3000.
  // Unset, a server this run starts hands its queue to whatever else listens on
  // :3000 (e.g. the live server, which has a model key) and (e2) sees rows
  // settle 'done' without this server ever running the worker. An exported
  // value still wins.
  if (!reusingServer && !process.env.NEXT_PUBLIC_APP_URL) process.env.NEXT_PUBLIC_APP_URL = BASE_URL;
  await ensureDevServer();
  const { email, password, apiKey, userId } = await createThrowawayUserAndKey(config);
  await importFixtures(apiKey);
  await assertSessionCount(apiKey);
  await assertMemoryExtracted(userId, config);
  // Driver decision: the cron reconciles and kicks EVERY local user, so with
  // a model key it would extract other users' sessions. Reconcile's DB logic
  // does not depend on the key, so the no-key (CI) run covers it.
  if (config.serverHasModelKey) log("(e3) skipped (model key set; cron would extract other local users)");
  else await assertCronReconcile(userId, cronSecretValue);
  const sessionId = await fetchOneSessionId(userId);
  log(`    using session ${sessionId} for the Playwright page checks.`);
  runPlaywright({
    SMOKE_BASE_URL: BASE_URL,
    SMOKE_EMAIL: email,
    SMOKE_PASSWORD: password,
    SMOKE_SESSION_ID: sessionId,
  });
  log("All smoke checks passed.");
}

try {
  await main();
} catch (err) {
  if (err instanceof SmokeFailure) {
    console.error(`\nSMOKE FAILED: ${err.message}`);
  } else {
    console.error("\nSMOKE FAILED with an unexpected error:");
    console.error(err);
  }
  exitCode = 1;
} finally {
  try {
    await teardown();
  } catch (err) {
    console.error("teardown itself failed:", err);
    exitCode = 1;
  }
}

process.exit(exitCode);
