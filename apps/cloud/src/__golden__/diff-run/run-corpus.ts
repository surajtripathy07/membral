// G0 step 0.10 — corpus runner for scripts/diff-run.mjs. Test-only: no production seam is used.
//
// Runs the pipeline golden harness (../pipeline/harness.ts) over a corpus and writes one
// stable-JSON artefact bundle per session under $MEMBRAL_DIFFRUN_OUT/<session-id>/.
// scripts/diff-run.mjs copies this file into a git worktree of each SHA and runs it there
// through vitest (the harness relies on vi.mock and fake timers), then byte-compares the two
// output trees. See README.md.
//
// Env (set by diff-run.mjs):
//   MEMBRAL_DIFFRUN_OUT      output root (required; without it the suite is skipped)
//   MEMBRAL_DIFFRUN_CORPUS   JSON array of corpus entries: "builtin" (the golden fixtures) or an absolute dir
//   MEMBRAL_DIFFRUN_STORE    absolute replay-store dir (layout: replay-store/README.md)
//   MEMBRAL_DIFFRUN_LIMIT    cap on the number of sessions (after ordering)
//   MEMBRAL_DIFFRUN_SELFTEST_PERTURB=1  appends a marker to every preamble.txt (self-test only)

import fs from "node:fs";
import path from "node:path";
import { claudeCodeParser, opencodeParser } from "@membral/core";
import { type LlmRecording, llmRequestKey, parseLlmJsonl } from "@membral/test-kit";
import { afterEach, describe, it, vi } from "vitest";
import { fixtureDir, type PipelineFixture, runPipeline, USER_ID, vectorAtCosine } from "../pipeline/harness";
import { NEW_DECISION, richScript, SEEDED_BLOCKER, SEEDED_DECISION } from "../pipeline/script";

// Ids: a counter, reset per session (globalThis, because the factory is hoisted above
// every binding in this file), so a bundle does not depend on which sessions ran before it.
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  const randomUUID = () => {
    const g = globalThis as { __diffRunUuid?: number };
    g.__diffRunUuid = (g.__diffRunUuid ?? 0) + 1;
    return `7e5e0000-0000-4000-8000-${String(g.__diffRunUuid).padStart(12, "0")}`;
  };
  return { ...actual, default: { ...actual, randomUUID }, randomUUID };
});

/** Frozen clock for a corpus session whose transcript carries no usable end time. */
const FALLBACK_NOW = "2026-10-01T00:00:00.000Z";
const PIPELINE_DIR = fixtureDir("");
const WORKTREE_ROOT = path.resolve(__dirname, "../../../../..");
const PERTURB_MARKER = "\n[diff-run self-test perturbation]\n";

interface Job {
  /** Bundle directory, relative to the output root. */
  id: string;
  fx: PipelineFixture;
  /** "replay": the fixture's own llm.jsonl through the harness; "store": the replay store, misses recorded. */
  kind: "replay" | "store";
}

// --- the committed golden fixtures (same definitions as pipeline.golden.test.ts) -------------

const PRIOR_SESSION_ID = "66666666-6666-4666-8666-666666666666";

function builtinJobs(): Job[] {
  const fixtures: PipelineFixture[] = [
    {
      name: "claude-code-small",
      source: "claude-code",
      inputFile: "input.jsonl",
      sourceSessionId: "22222222-2222-4222-8222-222222222222",
      nowIso: "2026-01-02T00:00:00.000Z",
      precontext: {
        conversationId: "c0a70000-0000-4000-8000-000000000001",
        title: "CodeHub API uptime checks",
        firstMessage: "How should a health check endpoint report database connectivity for the CodeHub API?",
      },
    },
    {
      name: "opencode-small",
      source: "opencode",
      inputFile: "input.json",
      sourceSessionId: "ses_1403d271dffeWEmI9XDZ6bdCGT",
      nowIso: "2026-06-14T00:00:00.000Z",
    },
    {
      name: "claude-code-rich",
      source: "claude-code",
      inputFile: "input.jsonl",
      sourceSessionId: "77777777-7777-4777-8777-777777777777",
      nowIso: "2026-01-06T00:00:00.000Z",
      scripted: richScript,
      seed: async ({ db, importPrior }) => {
        const prior = await importPrior("input-prior.jsonl", PRIOR_SESSION_ID);
        const base = {
          user_id: USER_ID,
          code_session_id: prior.sessionId,
          code_project_id: prior.codeProjectId,
          agent_id: null,
          source: "extractor",
          turn_role: "assistant",
          ref: null,
          ref_kind: null,
          branch: "feature/health-check",
          head_sha: null,
          thread: null,
          verified: true,
          durable: true,
          scope: "project",
          confidence: 0.9,
          priority: false,
          extraction_pass: null,
          recurs_of: null,
          supersedes: null,
          retired_at: null,
          retire_reason: null,
          created_at: "2025-12-20T00:01:00.000Z",
        };
        db.seed("session_memories", [
          {
            ...base,
            id: "5eed0000-0000-4000-8000-000000000001",
            kind: "decision",
            text: SEEDED_DECISION,
            quote: "Health checks will run a SELECT 1 query against the primary database.",
            turn_idx: 1,
            paths: ["src/routes/health.ts"],
            content_hash: "seed-decision",
            embedding: vectorAtCosine(NEW_DECISION, SEEDED_DECISION, 0.92),
          },
          {
            ...base,
            id: "5eed0000-0000-4000-8000-000000000002",
            kind: "blocker",
            text: SEEDED_BLOCKER,
            quote: "The /health endpoint times out when the database is slow",
            turn_idx: 4,
            paths: ["src/routes/health.ts"],
            content_hash: "seed-blocker",
            embedding: vectorAtCosine(SEEDED_BLOCKER, SEEDED_BLOCKER, 1),
          },
        ]);
      },
    },
  ];
  // The golden replays a scripted fixture from its llm.jsonl too: `scripted` only matters when recording.
  return fixtures.map((fx) => ({ id: `builtin/${fx.name}`, fx, kind: "replay" as const }));
}

// --- corpus transcripts ---------------------------------------------------------------------

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.isFile() && /\.jsonl?$/.test(e.name)) out.push(p);
  }
  return out;
}

function endPlusHour(endedAt: string | undefined): string {
  const t = endedAt ? Date.parse(endedAt) : Number.NaN;
  return Number.isFinite(t) ? new Date(t + 3_600_000).toISOString() : FALLBACK_NOW;
}

/** A transcript the harness can import, or null (not a Claude Code / opencode session). */
function corpusJob(root: string, file: string, label: string): Job | null {
  const rel = path.relative(root, file);
  const base = {
    // The harness reads `fixtureDir(name)/inputFile`; a relative name points it at the corpus.
    name: path.relative(PIPELINE_DIR, path.dirname(file)),
    inputFile: path.basename(file),
  };
  const raw = fs.readFileSync(file, "utf8");
  let fx: PipelineFixture;
  if (file.endsWith(".jsonl")) {
    // Claude Code transcript lines carry sessionId; other .jsonl (MCP logs, caches) are not sessions.
    const sid = raw.match(/"sessionId"\s*:\s*"([^"]+)"/)?.[1];
    if (!sid) return null;
    let nowIso = FALLBACK_NOW;
    try {
      nowIso = endPlusHour(
        claudeCodeParser.parse({ source: "claude-code", sourceSessionId: sid, path: "n/a" }, raw).endedAt,
      );
    } catch {
      // The run records the parse failure itself.
    }
    fx = { ...base, source: "claude-code", sourceSessionId: sid, nowIso };
  } else {
    let sid: unknown;
    try {
      sid = (JSON.parse(raw) as { session?: { id?: unknown } }).session?.id;
    } catch {
      return null;
    }
    if (typeof sid !== "string") return null;
    let nowIso = FALLBACK_NOW;
    try {
      nowIso = endPlusHour(
        opencodeParser.parse({ source: "opencode", sourceSessionId: sid, path: "n/a" }, raw).endedAt,
      );
    } catch {
      // As above.
    }
    fx = { ...base, source: "opencode", sourceSessionId: sid, nowIso };
  }
  return { id: `${label}/${rel}`, fx, kind: "store" };
}

function corpusJobs(entries: string[]): Job[] {
  const jobs: Job[] = [];
  entries.forEach((entry, i) => {
    if (entry === "builtin") {
      jobs.push(...builtinJobs());
      return;
    }
    if (!fs.existsSync(entry)) return;
    const label = `corpus${i}-${path.basename(entry)}`;
    for (const f of walk(entry)) {
      const j = corpusJob(entry, f, label);
      if (j) jobs.push(j);
    }
  });
  return jobs;
}

// --- replay store ----------------------------------------------------------------------------

/**
 * An in-process responder for the harness's scripted path (never the network): serves
 * replay-store/<job id>/llm.jsonl by request key; a miss is recorded and thrown, which the
 * pipeline swallows exactly as it swallows any LLM error.
 */
function storeResponder(storeDir: string, jobId: string, misses: string[]) {
  const file = path.join(storeDir, jobId, "llm.jsonl");
  const byKey = new Map<string, LlmRecording[]>();
  if (fs.existsSync(file)) {
    for (const r of parseLlmJsonl(fs.readFileSync(file, "utf8"))) {
      const list = byKey.get(r.key) ?? [];
      list[r.n] = r;
      byKey.set(r.key, list);
    }
  }
  const seen = new Map<string, number>();
  return (body: { messages: Array<{ role: string; content: string }> }): string => {
    const key = llmRequestKey(body as Parameters<typeof llmRequestKey>[0]);
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    const hit = byKey.get(key)?.[n];
    if (hit && hit.content !== null) return hit.content;
    const user = body.messages.find((m) => m.role === "user")?.content ?? "";
    const msg = `MISS key=${key} n=${n} user_head=${JSON.stringify(user.slice(0, 120))}`;
    misses.push(msg);
    throw new Error(msg);
  };
}

// --- the run ---------------------------------------------------------------------------------

const outRoot = process.env.MEMBRAL_DIFFRUN_OUT;
const entries = JSON.parse(process.env.MEMBRAL_DIFFRUN_CORPUS ?? '["builtin"]') as string[];
const storeDir = process.env.MEMBRAL_DIFFRUN_STORE ?? path.join(__dirname, "replay-store");
const limit = Number(process.env.MEMBRAL_DIFFRUN_LIMIT ?? "0");
const perturb = process.env.MEMBRAL_DIFFRUN_SELFTEST_PERTURB === "1";

const allJobs = outRoot ? corpusJobs(entries) : [];
const jobs = limit > 0 ? allJobs.slice(0, limit) : allJobs;

/** Worktree paths differ per SHA; an error message must not. */
const scrub = (s: string) => s.split(WORKTREE_ROOT).join("<worktree>");

function write(dir: string, name: string, text: string) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), text);
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe.skipIf(!outRoot)("diff-run corpus", () => {
  it("has sessions", () => {
    if (jobs.length === 0) throw new Error(`diff-run: no sessions in ${JSON.stringify(entries)}`);
  });
  for (const job of jobs) {
    it(job.id, { timeout: 120_000 }, async () => {
      const dir = path.join(outRoot as string, job.id);
      (globalThis as { __diffRunUuid?: number }).__diffRunUuid = 0;
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(job.fx.nowIso));
      vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "golden-recall-token-secret");

      const storeMisses: string[] = [];
      const fx = job.kind === "store" ? { ...job.fx, scripted: storeResponder(storeDir, job.id, storeMisses) } : job.fx;
      try {
        // "record" + scripted is the harness's in-process path: the responder above is the only model.
        const { artefacts, replay } = await runPipeline(fx, job.kind === "store" ? "record" : "replay");
        const misses = job.kind === "store" ? storeMisses : replay.misses;
        write(dir, "db-oplog.json", artefacts["db-oplog.json"]);
        write(dir, "db-final.json", artefacts["db-final.json"]);
        write(dir, "preamble.txt", artefacts["preamble.txt"] + (perturb ? PERTURB_MARKER : ""));
        write(dir, "threads.json", artefacts["threads.json"]);
        write(dir, "llm.jsonl", artefacts["llm.jsonl"]);
        write(dir, "misses.json", `${JSON.stringify(misses, null, 2)}\n`);
      } catch (e) {
        write(dir, "error.txt", `${scrub(e instanceof Error ? e.message : String(e))}\n`);
        if (perturb) write(dir, "preamble.txt", PERTURB_MARKER);
      }
    });
  }
});
