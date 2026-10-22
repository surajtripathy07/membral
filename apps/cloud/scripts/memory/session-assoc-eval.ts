// D-057 evaluation (docs/design/session-issue-association.md §7): runs the
// session–issue association over the fixture case sets and/or the founder
// corpus N times and reports precision, recall and EVERY wrong link verbatim
// (session, turn range, linked ref, expected). A link counts as wrong if any
// run produces it; ship bar = zero wrong links on every set.
//
// usage (from apps/cloud):
//   npx tsx scripts/memory/session-assoc-eval.ts [--runs 3] [--max-usd 0.25]
//     [--sets d053,pivot,return,confusable] [--cases S1,R1]
//     [--founder --user <uuid> [--sessions a,b] [--limit 23] [--days 90]]
//     [--label-file labels.jsonl] [--unverified-out assoc-eval-unverified.jsonl]
//     [--no-fixtures] [--out result.json] [--pace-ms 0] [--route openai|openrouter]
//
// --max-usd: hard cap PER RUN (default $0.25). The client refuses the next call
//   once a run's spend reaches it; the run's remaining cases are reported
//   `skipped_budget`, never silently dropped.
// --founder: flag-ON dry run over a user's top-level sessions (read-only: only
//   SELECTs; nothing is written — not issue rows, not props, not the spend
//   ledger). Every linked build action lands in one of three buckets:
//   verified-correct / verified-wrong (a commit audited with `gh pr list --search
//   <sha>`: the PRs containing it and the issues they close), or UNVERIFIED (no
//   PR holds the commit, or an edit/push). Unverified links are never counted
//   correct: each is written to --unverified-out (session, turn range, ref,
//   evidence quotes, commit subjects in range, label: null) for a human to label;
//   pass the labelled file back with --label-file (JSON array or JSONL of
//   {key, label: "correct"|"wrong"}) and labels feed precision. The founder
//   gate is "pass" only with zero wrong AND zero unverified links.
// Model: pinned gpt-4o-mini (--route openai: OPENAI_API_KEY_DIRECT, else
//   OPENAI_API_KEY with no MEMBRAL_MODEL_BASE_URL; --route openrouter:
//   openai/gpt-4o-mini through MEMBRAL_MODEL_BASE_URL). Keys are never printed.
// Rate limits (CLAUDE.md rule 4): a 429 re-queues the case at the back and the
//   pace grows proportionally; success decays it 0.9x, never reset.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { config } from "dotenv";

config({ path: ".env.local", quiet: true });

const MODEL = "gpt-4o-mini";
const OPENROUTER_MODEL = process.env.ASSOC_EVAL_MODEL?.trim() || "openai/gpt-4o-mini";
const MAX_RATE_LIMIT_RETRIES = 3;

interface Args {
  runs: number;
  maxUsd: number;
  sets?: string[];
  cases?: string[];
  fixtures: boolean;
  founder: boolean;
  userId?: string;
  sessionIds?: string[];
  limit: number;
  days: number;
  out?: string;
  labelFile?: string;
  unverifiedOut: string;
  paceMs: number;
  route: "openai" | "openrouter";
}

function parseArgs(argv: string[]): Args {
  const val = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const num = (flag: string, dflt: number): number => {
    const raw = val(flag);
    if (raw === undefined) return dflt;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) {
      console.error(`${flag} must be a non-negative number`);
      process.exit(1);
    }
    return n;
  };
  const list = (flag: string) =>
    val(flag)
      ?.split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  const args: Args = {
    runs: Math.max(1, Math.floor(num("--runs", 3))),
    maxUsd: num("--max-usd", 0.25),
    sets: list("--sets"),
    cases: list("--cases"),
    fixtures: !argv.includes("--no-fixtures"),
    founder: argv.includes("--founder"),
    userId: val("--user"),
    sessionIds: list("--sessions"),
    limit: Math.floor(num("--limit", 23)),
    days: num("--days", 90),
    out: val("--out"),
    labelFile: val("--label-file"),
    unverifiedOut: val("--unverified-out") ?? "assoc-eval-unverified.jsonl",
    paceMs: num("--pace-ms", 0),
    route: val("--route") === "openrouter" ? "openrouter" : "openai",
  };
  if (args.founder && !args.userId) {
    console.error("--founder needs --user <uuid>");
    process.exit(1);
  }
  return args;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- forge truth (founder mode) --------------------------------------------------

interface PrHit {
  number: number;
  title: string;
  closes: number[];
}
const prCache = new Map<string, PrHit[] | null>();

function ghJson(args: string[]): unknown {
  const out = execFileSync("gh", args, { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });
  return JSON.parse(out);
}

/** PRs that contain `sha` (null when gh cannot answer). Read-only. */
function prsForSha(repo: string, sha: string): PrHit[] | null {
  const key = `${repo}@${sha}`;
  if (prCache.has(key)) return prCache.get(key) ?? null;
  let hits: PrHit[] | null = null;
  try {
    const raw = ghJson([
      "pr",
      "list",
      "-R",
      repo,
      "--state",
      "all",
      "--search",
      sha,
      "--json",
      "number,title,closingIssuesReferences",
    ]) as Array<{ number: number; title: string; closingIssuesReferences?: Array<{ number: number }> }>;
    hits = raw.map((p) => ({
      number: p.number,
      title: p.title,
      closes: (p.closingIssuesReferences ?? []).map((i) => i.number),
    }));
  } catch {
    hits = null;
  }
  prCache.set(key, hits);
  return hits;
}

function forgeVerdict(
  repo: string | null,
  sha: string | undefined,
  refNumber: number,
  kind: string,
): { verdict: "confirmed" | "contradicted" | "unverified"; truth: string } {
  if (!repo || !sha) return { verdict: "unverified", truth: "no GitHub repo or no sha" };
  const prs = prsForSha(repo, sha);
  if (prs === null) return { verdict: "unverified", truth: "gh could not answer" };
  if (prs.length === 0) return { verdict: "unverified", truth: "no PR contains this commit — audit the diff" };
  const desc = prs.map((p) => `PR #${p.number} "${p.title}" closes [${p.closes.join(",")}]`).join("; ");
  const hit = kind === "merge_request" ? prs.some((p) => p.number === refNumber) : prs.some((p) => p.closes.includes(refNumber) || p.number === refNumber);
  if (hit) return { verdict: "confirmed", truth: desc };
  const closesOther = prs.some((p) => p.closes.length > 0);
  return { verdict: kind === "merge_request" || closesOther ? "contradicted" : "unverified", truth: desc };
}

// --- labels (founder mode) --------------------------------------------------------

type Verdict = "correct" | "wrong" | "unverified";
interface LabelRow {
  key: string;
  label: "correct" | "wrong";
}

/** A founder link's stable key for a human label: session, build action, linked ref. */
function labelKey(session: string, b: { verb: string; mainIdx: number; sha?: string; child: string | null }, ref: string): string {
  return `${session}|${b.child ?? ""}|${b.verb}|${b.sha ?? b.mainIdx}|${ref.toLowerCase()}`;
}

function readLabels(path: string | undefined): Map<string, "correct" | "wrong"> {
  const out = new Map<string, "correct" | "wrong">();
  if (!path) return out;
  const raw = readFileSync(path, "utf8").trim();
  const rows: unknown[] = raw.startsWith("[") ? JSON.parse(raw) : raw.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  for (const r of rows as Partial<LabelRow>[]) {
    if (typeof r.key === "string" && (r.label === "correct" || r.label === "wrong")) out.set(r.key, r.label);
  }
  return out;
}

// --- main --------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { LlmClient } = await import("../../src/lib/llm/client");
  const { resolveModelConfig } = await import("../../src/lib/llm/config");
  const { nextPaceMs, decayPaceMs } = await import("../../src/lib/code-sessions/short-title");
  const evalLib = await import("../../src/lib/memory/session-association-eval");
  const assoc = await import("../../src/lib/memory/session-association");
  const { evalCases } = await import("../../src/lib/memory/__tests__/assoc-eval/cases");

  const baseUrl = process.env.MEMBRAL_MODEL_BASE_URL?.trim() || "";
  let apiKey: string | undefined;
  let model = MODEL;
  if (args.route === "openrouter") {
    if (!/openrouter\.ai/.test(baseUrl)) {
      console.error("[assoc-eval] --route openrouter needs MEMBRAL_MODEL_BASE_URL pointing at openrouter.ai");
      process.exit(1);
    }
    apiKey = process.env.OPENAI_API_KEY?.trim();
    model = OPENROUTER_MODEL;
  } else {
    apiKey = process.env.OPENAI_API_KEY_DIRECT?.trim() || (baseUrl ? undefined : process.env.OPENAI_API_KEY?.trim());
  }
  if (!apiKey) {
    console.error("[assoc-eval] no API key for this route (see the header comment)");
    process.exit(1);
  }
  const modelConfig = resolveModelConfig({
    ...process.env,
    MEMBRAL_MODEL: model,
    MEMBRAL_MODEL_BASE_URL: args.route === "openrouter" ? baseUrl : "",
    OPENAI_API_KEY: apiKey,
  });

  let cases = args.fixtures ? evalCases() : [];
  if (args.sets) cases = cases.filter((c) => args.sets?.includes(c.set));
  if (args.cases) cases = cases.filter((c) => args.cases?.includes(c.id));
  const labels = readLabels(args.labelFile);

  console.error(
    `[assoc-eval] prompt=${assoc.SESSION_ASSOC_PROMPT_VERSION} model=${model} runs=${args.runs} max_usd/run=$${args.maxUsd.toFixed(2)} fixture_cases=${cases.length} founder=${args.founder} labels=${labels.size}`,
  );

  type FounderSession = Awaited<ReturnType<typeof loadFounder>>[number];
  const founder: FounderSession[] = args.founder ? await loadFounder(args) : [];

  const report: Record<string, unknown>[] = [];
  const wrongEver = new Map<string, Record<string, unknown>>();
  const unverifiedEver = new Map<string, Record<string, unknown>>();
  let totalUsd = 0;

  for (let run = 1; run <= args.runs; run++) {
    const llm = new LlmClient(modelConfig, { capUsd: args.maxUsd, maxRetries: 0, timeoutMs: 60_000 });
    let pace = args.paceMs;
    const results: Awaited<ReturnType<typeof evalLib.runEvalCase>>[] = [];
    const queue = cases.map((c) => ({ c, tries: 0 }));
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;
      if (pace > 0) await sleep(pace);
      const r = await evalLib.runEvalCase(llm, item.c);
      if (r.status === "rate_limited" && item.tries < MAX_RATE_LIMIT_RETRIES) {
        pace = nextPaceMs(pace);
        queue.push({ c: item.c, tries: item.tries + 1 });
        continue;
      }
      pace = decayPaceMs(pace, args.paceMs);
      results.push(r);
      for (const l of r.links) {
        console.log(JSON.stringify({ run, ...l }));
        if (l.verdict === "wrong") {
          const k = `${l.caseId}\u0000${l.verb}\u0000${l.sha ?? l.turn}\u0000${l.ref}|${l.kind}`;
          if (!wrongEver.has(k)) wrongEver.set(k, { run, ...l });
        }
      }
    }
    const summary = evalLib.summarize(cases, results);

    // Founder corpus, this run: three buckets — verified-correct, verified-wrong, unverified.
    const founderLinks: Record<string, unknown>[] = [];
    const founderMissed: Record<string, unknown>[] = [];
    const founderStatus: Record<string, number> = {};
    for (const s of founder) {
      const input = {
        sessionId: s.id,
        projectIdentity: s.projectIdentity,
        turns: s.turns,
        trace: s.trace,
        candidates: s.candidates,
        childSessions: s.childSessions,
      };
      if (pace > 0) await sleep(pace);
      let res = await assoc.callAssociation(llm, input);
      for (let t = 0; res.status === "rate_limited" && t < MAX_RATE_LIMIT_RETRIES; t++) {
        pace = nextPaceMs(pace);
        await sleep(pace);
        res = await assoc.callAssociation(llm, input);
      }
      pace = decayPaceMs(pace, args.paceMs);
      founderStatus[res.status] = (founderStatus[res.status] ?? 0) + 1;
      const claimed = new Set<unknown>();
      for (const seg of res.segments) {
        if (!seg.ref) continue;
        const inRange = s.trace.builds.filter(
          (b) => b.verb === "committed" && !b.untimed && b.mainIdx >= seg.from_turn && b.mainIdx <= seg.to_turn,
        );
        for (const b of assoc.claimedBuilds(seg, s.trace)) {
          claimed.add(b);
          const n = Number(/(\d+)$/.exec(seg.ref)?.[1] ?? Number.NaN);
          // Commits are audited against the forge; edits and pushes go to the human label file.
          const forge =
            b.verb === "committed"
              ? forgeVerdict(s.ghRepo, b.sha, n, seg.kind ?? "issue")
              : { verdict: "unverified" as const, truth: `${b.verb}: not auditable from the forge` };
          const key = labelKey(s.id, b, seg.ref);
          const label = labels.get(key);
          const verdict: Verdict = label ?? (forge.verdict === "confirmed" ? "correct" : forge.verdict === "contradicted" ? "wrong" : "unverified");
          const link = {
            run,
            key,
            session: s.id,
            turn_range: `${seg.from_turn}-${seg.to_turn}`,
            verb: b.verb,
            turn: b.mainIdx,
            ...(b.sha ? { sha: b.sha } : {}),
            ...(b.file ? { file: b.file } : {}),
            ...(b.branch ? { branch: b.branch } : {}),
            linked_ref: seg.ref,
            kind: seg.kind,
            evidence: seg.evidence,
            reason: seg.reason,
            commit_subjects_in_range: inRange.map((x) => `${x.sha ?? "?"} ${x.subject ?? ""}`.trim()),
            forge_verdict: forge.verdict,
            truth: forge.truth,
            ...(label ? { label } : {}),
            verdict,
          };
          founderLinks.push(link);
          console.log(JSON.stringify({ founder: true, ...link }));
          if (verdict === "wrong" && !wrongEver.has(key)) wrongEver.set(key, link);
          if (verdict === "unverified" && !unverifiedEver.has(key)) unverifiedEver.set(key, link);
        }
      }
      // Recall: unlinked build commits the forge ties to an item.
      for (const b of s.trace.builds) {
        if (b.verb !== "committed" || b.landed !== null || claimed.has(b) || !b.sha || !s.ghRepo) continue;
        const prs = prsForSha(s.ghRepo, b.sha);
        if (prs && prs.some((p) => p.closes.length > 0))
          founderMissed.push({ run, session: s.id, turn: b.mainIdx, sha: b.sha, subject: b.subject, forge: prs });
      }
    }
    const count = (v: Verdict) => founderLinks.filter((l) => l.verdict === v).length;
    const founderSummary = args.founder
      ? {
          set: "founder",
          sessions: founder.length,
          status: founderStatus,
          links: founderLinks.length,
          verified_correct: count("correct"),
          verified_wrong: count("wrong"),
          unverified: count("unverified"),
          // Unverified links are never counted correct: precision is over verified links only, and
          // the gate stays closed while any link is unverified.
          precision_verified:
            count("correct") + count("wrong") > 0 ? count("correct") / (count("correct") + count("wrong")) : null,
          missed_with_forge_evidence: founderMissed.length,
          gate: count("wrong") === 0 && count("unverified") === 0 ? "pass" : "blocked",
        }
      : null;

    totalUsd += llm.totalCostUsd;
    report.push({
      run,
      cost_usd: Number(llm.totalCostUsd.toFixed(6)),
      capped: llm.overBudget(),
      sets: summary,
      founder: founderSummary,
      missed: results.flatMap((r) => r.missed),
      founder_missed: founderMissed,
      statuses: results.map((r) => ({ case: r.caseId, status: r.status })),
    });
    console.error(`[assoc-eval] run ${run}: $${llm.totalCostUsd.toFixed(4)}${llm.overBudget() ? " (CAP REACHED)" : ""}`);
    for (const s of summary)
      console.error(
        `  ${s.set.padEnd(10)} precision=${s.precision === null ? "n/a" : s.precision.toFixed(3)} recall=${s.recall === null ? "n/a" : s.recall.toFixed(3)} links=${s.linksMade} wrong=${s.wrong} expected=${s.expectedLinks} malformed/failed=${s.malformedOrFailed} over_cap=${s.overCap}`,
      );
    if (founderSummary) console.error(`  founder    ${JSON.stringify(founderSummary)}`);
  }

  const wrong = [...wrongEver.values()];
  const unverified = [...unverifiedEver.values()];
  if (args.founder) {
    writeFileSync(args.unverifiedOut, `${unverified.map((u) => JSON.stringify({ ...u, label: null })).join("\n")}\n`);
    console.error(
      `[assoc-eval] ${unverified.length} unverified founder link(s) written to ${args.unverifiedOut} — set "label" to "correct"/"wrong" and pass it back with --label-file`,
    );
  }
  console.error(`\n[assoc-eval] WRONG LINKS (any run): ${wrong.length}  total spend $${totalUsd.toFixed(4)}`);
  for (const w of wrong) {
    const x = w as Record<string, unknown>;
    const where = x.caseId ? `${x.caseId} turns ${x.fromTurn}-${x.toTurn}` : `founder:${x.session} turns ${x.turn_range}`;
    console.error(
      `  WRONG ${where} ${x.verb} ${x.sha ?? x.file ?? x.branch ?? `turn ${x.turn}`} → ${x.ref ?? x.linked_ref} (${x.kind}) expected ${x.caseId ? (x.expected ?? "no link") : (x.truth ?? "label: wrong")} | reason: ${x.reason}`,
    );
  }
  const final = {
    prompt_version: assoc.SESSION_ASSOC_PROMPT_VERSION,
    model,
    runs: report,
    wrong_any_run: wrong,
    unverified_any_run: unverified.length,
  };
  console.log(
    JSON.stringify({
      summary: { wrong_any_run: wrong.length, unverified_any_run: unverified.length, total_usd: Number(totalUsd.toFixed(6)) },
    }),
  );
  if (args.out) writeFileSync(args.out, JSON.stringify(final, null, 2));

  async function loadFounder(a: Args) {
    const { getServiceClient: getServiceSupabase } = await import("../../src/lib/db/clients");
    const { selectAllRows } = await import("../../src/lib/util/pagination");
    const { groundSessionIssues } = await import("../../src/lib/memory/extract");
    const tail = await import("../../src/lib/memory/tail-capture");
    const supabase = getServiceSupabase();
    const since = new Date(Date.now() - a.days * 24 * 60 * 60_000).toISOString();
    let q = supabase
      .from("code_sessions")
      .select(
        "id, user_id, code_project_id, source, git_branch, started_at, props, parent_source_session_id, source_session_id, code_projects(repo_identity)",
      )
      .eq("user_id", a.userId as string)
      .is("parent_source_session_id", null);
    if (a.sessionIds) q = q.in("id", a.sessionIds);
    else q = q.gte("started_at", since);
    const { data, error } = await q.order("started_at", { ascending: false }).limit(a.limit);
    if (error) throw new Error(`session read failed: ${error.message}`);
    const out = [];
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      const cp = row.code_projects as { repo_identity?: string } | Array<{ repo_identity?: string }> | null;
      const identity =
        (Array.isArray(cp) ? cp[0]?.repo_identity : cp?.repo_identity) || `code-project:${row.code_project_id}`;
      const turns = (await selectAllRows((from, to) =>
        supabase
          .from("code_session_turns")
          .select("idx, role, kind, text, tool_name, file_path, ts, props")
          .eq("session_id", row.id as string)
          .eq("user_id", a.userId as string)
          .order("idx", { ascending: true })
          .range(from, to),
      )) as never[];
      const session = row as never;
      const childSessions = await tail.fetchChildSessionsForProfile(supabase, a.userId as string, session);
      const lineage = await tail.fetchBranchLineage(supabase, a.userId as string, session);
      const trace: { value?: import("../../src/lib/code-sessions/profile").ProfileTrace } = {};
      const actionsVersion = (row.props as { actions_version?: unknown } | null)?.actions_version;
      groundSessionIssues([], turns, identity, {
        actionsVersion: typeof actionsVersion === "number" ? actionsVersion : null,
        childSessions,
        knownBranches: lineage.knownBranches,
        startBranch: row.git_branch as string | null,
        defaultBranch: lineage.defaultBranch,
        // N1: pinned — the local MEMBRAL_INFER_REF must not change what counts as linked.
        inferRef: false,
        trace,
      });
      if (!trace.value || !assoc.isCandidateSession(trace.value)) continue;
      const candidates = await assoc.fetchAssocCandidates(
        supabase,
        a.userId as string,
        session,
        identity,
        turns,
        childSessions,
      );
      const m = /^github\.com\/([^/]+\/[^/]+)$/i.exec(identity);
      out.push({
        id: row.id as string,
        projectIdentity: identity,
        ghRepo: m ? m[1] : null,
        turns,
        trace: trace.value,
        candidates,
        childSessions,
      });
    }
    console.error(`[assoc-eval] founder: ${out.length} candidate sessions of ${(data ?? []).length} read`);
    return out;
  }
}

main().catch((err) => {
  console.error(`[assoc-eval] failed: ${(err as Error).message}`);
  process.exit(1);
});
