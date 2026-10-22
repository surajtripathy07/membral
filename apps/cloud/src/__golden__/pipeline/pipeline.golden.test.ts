// G0 step 0.3 — pipeline golden. Test-only: no production seam is used.
// Replays by default (always under CI=true). `MEMBRAL_GOLDEN_RECORD=1` (or a
// comma list of fixture names) re-records: against the model in
// apps/cloud/.env.local, or, for a scripted fixture, against script.ts ($0).
// `MEMBRAL_GOLDEN_UPDATE=1` rewrites artefacts from a replay. See README.md.

import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fixtureDir,
  type PipelineArtefacts,
  type PipelineFixture,
  readRecordingCost,
  replayMode,
  runPipeline,
  USER_ID,
  vectorAtCosine,
} from "./harness";
import { NEW_DECISION, richScript, SEEDED_BLOCKER, SEEDED_DECISION } from "./script";

// Ids: every randomUUID the pipeline draws (tail-capture.ts:402, the rederive
// lock's run id) comes from a counter.
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  let n = 0;
  const randomUUID = () => {
    n += 1;
    return `7e5e0000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  };
  return { ...actual, default: { ...actual, randomUUID }, randomUUID };
});

const PRIOR_SESSION_ID = "66666666-6666-4666-8666-666666666666";

const FIXTURES: PipelineFixture[] = [
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
    // Seed -> run: a prior session left a live decision and an open blocker in
    // this project; this session supersedes the decision, adds a learning and
    // resolves the blocker. The model is script.ts ($0, no network).
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
          // cosine 0.92 to the new decision: under the 0.94 cross-session drop, over the 0.9 supersede and 0.8 merge floors.
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
          // #436: inside BLOCKER_FRESH_DAYS (7) of nowIso, so a later session may still resolve it.
          created_at: "2026-01-01T00:01:00.000Z",
        },
      ]);
    },
  },
  {
    // v24 (box 9): a prior session's outcome was served into this one by the
    // preamble; the agent finds it stale (the PR merged) and the user says the
    // hook was slow. Expected: two feedback rows, one contradicted verdict, no
    // decision/learning about Membral. Recorded through the local claude-code
    // provider ($0, D-072).
    name: "claude-code-feedback",
    source: "claude-code",
    inputFile: "input.jsonl",
    sourceSessionId: "99999999-9999-4999-8999-999999999999",
    nowIso: "2026-02-05T00:00:00.000Z",
    seed: async ({ db, importPrior }) => {
      const prior = await importPrior("input-prior.jsonl", "88888888-8888-4888-8888-888888888888");
      db.seed("session_memories", [
        {
          id: "5eed0000-0000-4000-8000-0000000000f1",
          user_id: USER_ID,
          code_session_id: prior.sessionId,
          code_project_id: prior.codeProjectId,
          agent_id: null,
          source: "extractor",
          kind: "outcome",
          text: "Opened PR #41 for the CodeHub API rate limiter; it is waiting on review.",
          quote: "Opened PR #41 for the CodeHub API rate limiter; it is waiting on review.",
          turn_idx: 1,
          turn_role: "assistant",
          ref: "#41",
          ref_kind: "pr",
          branch: "feature/rate-limit",
          head_sha: null,
          thread: "rate limiter",
          paths: [],
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
          content_hash: "seed-outcome-pr41",
          embedding: null,
          created_at: "2026-02-01T00:01:00.000Z",
        },
      ]);
      db.seed("memory_recall_events", [
        {
          id: "5eed0000-0000-4000-8000-0000000000e1",
          user_id: USER_ID,
          tool: "preamble",
          surface: "preamble",
          recall_token: null,
          query: null,
          record_ids: ["5eed0000-0000-4000-8000-0000000000f1"],
          served_at: "2026-02-03T23:59:58.000Z",
          code_session_id: null,
          harness_session_id: "99999999-9999-4999-8999-999999999999",
          matched_turn_idx: null,
          influenced_edit: false,
          influenced_quote: false,
          influence_checked_at: null,
        },
      ]);
    },
  },
];

const ARTEFACTS: Array<keyof PipelineArtefacts> = [
  "llm.jsonl",
  "db-oplog.json",
  "db-final.json",
  "preamble.txt",
  "threads.json",
];

const updateAll = process.env.CI !== "true" && process.env.MEMBRAL_GOLDEN_UPDATE === "1";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("pipeline golden", () => {
  for (const fx of FIXTURES) {
    const mode = replayMode(fx.name);
    const update = mode === "record" || updateAll;
    it(`${fx.name} (${mode})`, { timeout: mode === "record" ? 600_000 : 30_000 }, async () => {
      // The only clock: write.ts, tail-capture.ts and preamble.ts read the global Date.
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(fx.nowIso));
      // The served-record verdict call is off unless local / explicit (tail-capture servedVerdictsEnabled).
      vi.stubEnv("MEMBRAL_SERVED_VERDICTS", "1");
      // recall-token.ts signs the preamble's recall_token with this secret.
      vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "golden-recall-token-secret");

      const { artefacts, replay, cost } = await runPipeline(fx, mode);
      const dir = fixtureDir(fx.name);

      expect(replay.misses).toEqual([]);
      if (mode === "record") {
        fs.writeFileSync(path.join(dir, "recording-cost.json"), `${JSON.stringify(cost, null, 2)}\n`);
      } else {
        expect(replay.unused().map((r) => r.user_head)).toEqual([]);
        // Replayed usage prices to exactly what was recorded.
        expect(cost).toEqual(readRecordingCost(fx.name));
      }

      for (const name of ARTEFACTS) {
        const file = path.join(dir, name);
        if (update) {
          fs.writeFileSync(file, artefacts[name]);
          continue;
        }
        expect(fs.existsSync(file), `${fx.name}/${name} is committed`).toBe(true);
        expect(artefacts[name], `${fx.name}/${name}`).toBe(fs.readFileSync(file, "utf8"));
      }
      if (fx.name === "claude-code-feedback") {
        // Box 9: two feedback rows, one contradicted verdict, no record about Membral.
        const final = JSON.parse(artefacts["db-final.json"]) as Record<string, Array<Record<string, unknown>>>;
        expect((final.session_feedback ?? []).map((r) => r.sentiment).sort()).toEqual(["slow", "stale"]);
        expect((final.served_record_verdicts ?? []).map((r) => r.verdict)).toEqual(["contradicted"]);
        // No stored record is about Membral itself (feedback lives in session_feedback only), and
        // the one engineering outcome of the session is still extracted.
        const memories = final.session_memories ?? [];
        for (const m of memories) {
          expect(`${m.text ?? ""} ${m.quote ?? ""}`, "a record about Membral").not.toMatch(
            /membral|recall|memory_search|preamble|injected|prompt hook/i,
          );
        }
        expect(memories.map((m) => m.kind)).toEqual(["outcome"]);
      }
    });
  }
});
