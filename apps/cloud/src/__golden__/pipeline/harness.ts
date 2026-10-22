// Pipeline golden harness (G0 step 0.3): one fixture session through
// parse -> wire payload -> importCodeSession -> runTailCaptureForSession (LLM
// replayed) -> buildPreamble + listOpenThreads, over the @membral/test-kit
// fake DB, with every nondeterminism source fixed:
//   - clock: the test freezes the global Date (vi.useFakeTimers + setSystemTime);
//     no production seam is used (G0 is test-only),
//   - ids: `node:crypto` randomUUID is mocked in the test; rows get the fake's
//     counter ids,
//   - LLM: LlmReplay keyed by sha256 of the full request body; embeddings are
//     hash vectors, never recorded. A `scripted` fixture records from a
//     hand-written in-process responder (script.ts), never the network,
//   - windows.ts:125 unordered `.limit()`: the fixture seeds at most ONE
//     code_cross_links candidate, so the fake's row order cannot matter.
//
// The golden locks the FAKE's row order and query semantics, not Postgres'.

import fs from "node:fs";
import path from "node:path";
import { claudeCodeParser, opencodeParser, type RawCodeSession } from "@membral/core";
import {
  type ChatUpstream,
  createFixedClock,
  createIdSequence,
  FakeDb,
  hashEmbedding,
  type LlmRecording,
  LlmReplay,
  parseLlmJsonl,
  type ReplayMode,
  type Row,
  toLlmJsonl,
} from "@membral/test-kit";
import type { SupabaseClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import { importCodeSession } from "@/lib/code-sessions/import";
import { RawCodeSessionSchema } from "@/lib/code-sessions/payload";
import { extractJsonText, runClaudeCode } from "@/lib/llm/claude-code-provider";
import { LlmClient } from "@/lib/llm/client";
import type { ModelConfig } from "@/lib/llm/config";
import { resolveSessionBudgetUsd } from "@/lib/memory/budget";
import { buildPreamble } from "@/lib/memory/preamble";
import { runTailCaptureForSession } from "@/lib/memory/tail-capture";
import { listOpenThreads } from "@/lib/threads/queries";
import { sessionForWire } from "../../../../../packages/cli/src/code-session-upload";

export const USER_ID = "0a0a0000-0000-4000-8000-000000000001";
/**
 * Per-run hard cap handed to LlmClient. The queue computes
 * min(perRunCap, sessionBudget, remaining allowance) (extraction-queue.ts:590-596);
 * this fixed cap never binds here, so budget cuts and the deadline path are not locked.
 */
const CAP_USD = 0.15;
/** Priced model id a scripted fixture's calls are made under (usage is null, so cost is 0). */
const SCRIPTED_MODEL = "gpt-4o-mini";
const EMBED_MODEL = "text-embedding-3-small";
/** Model label a claude-code recording is made and replayed under ($0 in CHAT_PRICING). */
const CLAUDE_CODE_GOLDEN_MODEL = "claude-code/sonnet";

/**
 * Record-mode upstream that answers each chat call with one turn of the local
 * `claude` CLI (W7 D-072, the maintainer's own login, $0) instead of an HTTP
 * API. It has the chat.completions shape LlmReplay records through, so the
 * request key and llm.jsonl are the same as for an OpenAI recording, and
 * replay never needs the CLI. Selected by MEMBRAL_GOLDEN_PROVIDER=claude-code.
 * runClaudeCode refuses unless MEMBRAL_LOCAL=1 (set here, for this child only)
 * and CLAUDE_CODE_OAUTH_TOKEN is in the environment; it never falls back to a key.
 */
function claudeCodeUpstream(): ChatUpstream {
  return {
    chat: {
      completions: {
        create: async (body) => {
          const systemPrompt = body.messages.find((m) => m.role === "system")?.content ?? "";
          const userPrompt = body.messages.find((m) => m.role === "user")?.content ?? "";
          const r = await runClaudeCode(
            { systemPrompt, userPrompt, model: body.model },
            { ...process.env, MEMBRAL_LOCAL: "1", VERCEL: undefined },
          );
          if (r.kind !== "ok") throw new Error(`golden claude-code record: ${r.kind}`);
          return {
            choices: [{ message: { content: extractJsonText(r.text) } }],
            usage: { prompt_tokens: r.tokensIn, completion_tokens: r.tokensOut },
          };
        },
      },
    },
  };
}

export interface PipelineFixture {
  /** Directory name under this folder. */
  name: string;
  source: "claude-code" | "opencode";
  inputFile: string;
  sourceSessionId: string;
  /** Frozen wall-clock for the whole run. */
  nowIso: string;
  /** One chat conversation linked to the project (the single windows.ts:125 candidate), or none. */
  precontext?: { conversationId: string; title: string; firstMessage: string };
  /** Hand-written responder: the fixture never calls a real model, recording costs $0. */
  scripted?: (body: { messages: Array<{ role: string; content: string }> }) => string;
  /** Runs before the fixture's own import: prior sessions and memories. */
  seed?: (ctx: SeedContext) => Promise<void>;
}

export interface SeedContext {
  db: FakeDb;
  supabase: SupabaseClient;
  /** Imports a transcript from the fixture dir exactly as the main session is imported. */
  importPrior: (inputFile: string, sourceSessionId: string) => Promise<{ sessionId: string; codeProjectId: string }>;
}

export interface PipelineArtefacts {
  "llm.jsonl": string;
  "db-oplog.json": string;
  "db-final.json": string;
  "preamble.txt": string;
  "threads.json": string;
}

export interface RecordingCost {
  model: string;
  scripted?: true;
  calls: number;
  tokens_in: number;
  tokens_out: number;
  usd: number;
}

export function fixtureDir(name: string): string {
  return path.join(__dirname, name);
}

/**
 * Record only when asked, never under CI. `MEMBRAL_GOLDEN_RECORD=1` records every
 * fixture; a comma list (`claude-code-rich,opencode-small`) records just those.
 */
export function replayMode(name: string, env: Record<string, string | undefined> = process.env): ReplayMode {
  if (env.CI === "true") return "replay";
  const want = (env.MEMBRAL_GOLDEN_RECORD ?? "").split(",").map((s) => s.trim());
  return want.includes("1") || want.includes(name) ? "record" : "replay";
}

function parseFixture(
  fx: Pick<PipelineFixture, "name" | "source">,
  inputFile: string,
  sourceSessionId: string,
): RawCodeSession {
  const raw = fs.readFileSync(path.join(fixtureDir(fx.name), inputFile), "utf8");
  const ref = { source: fx.source, sourceSessionId, path: "n/a" };
  return fx.source === "claude-code" ? claudeCodeParser.parse(ref, raw) : opencodeParser.parse(ref, raw);
}

/** Exactly what the route receives: the CLI's wire form, through JSON, through the route's schema. */
function wirePayload(fx: Pick<PipelineFixture, "name" | "source">, inputFile: string, sourceSessionId: string) {
  const wire = JSON.parse(JSON.stringify(sessionForWire(parseFixture(fx, inputFile, sourceSessionId))));
  return RawCodeSessionSchema.parse(wire);
}

// --- memory_semantic_duplicates (migration 101), ported to the fake ----------

function parseStoredVector(v: unknown): number[] | null {
  if (Array.isArray(v)) return v as number[];
  if (typeof v === "string" && v.startsWith("[")) return JSON.parse(v) as number[];
  return null;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/** The SQL of supabase/migrations/101_memory_semantic_duplicates.sql over the fake's rows (same joins, filters, order). */
function semanticDuplicatesRpc(db: FakeDb) {
  return (args: Record<string, unknown>) => {
    const ids = (args.p_record_ids as string[] | null) ?? null;
    const minSim = Number(args.p_min_sim ?? 0.8);
    const kinds = (args.p_kinds as string[] | undefined) ?? ["learning", "blocker", "decision", "preference"];
    const rows = db.getRows("session_memories");
    const older = (e: Row, n: Row) =>
      String(e.created_at) < String(n.created_at) || (e.created_at === n.created_at && String(e.id) < String(n.id));
    const out: Row[] = [];
    for (const n of rows) {
      const nv = parseStoredVector(n.embedding);
      if (n.user_id !== args.p_user || n.retired_at != null || !nv || n.kind === "outcome" || !kinds.includes(n.kind))
        continue;
      for (const e of rows) {
        const ev = parseStoredVector(e.embedding);
        if (e.user_id !== n.user_id || e.kind !== n.kind || e.scope !== n.scope) continue;
        if (n.scope !== "global" && e.code_project_id !== n.code_project_id) continue;
        if (!older(e, n) || e.retired_at != null || !ev) continue;
        if (ids !== null && !ids.includes(n.id) && !ids.includes(e.id)) continue;
        const sim = cosine(nv, ev);
        if (sim < minSim) continue;
        out.push({
          new_id: n.id,
          existing_id: e.id,
          sim,
          kind: n.kind,
          new_created_at: n.created_at,
          existing_created_at: e.created_at,
        });
      }
    }
    out.sort((a, b) =>
      a.new_id !== b.new_id
        ? a.new_id < b.new_id
          ? -1
          : 1
        : b.sim - a.sim || (a.existing_id < b.existing_id ? -1 : 1),
    );
    return { data: out, error: null };
  };
}

/**
 * A pgvector literal whose cosine to `target`'s hash embedding is exactly `sim`
 * (the orthogonal part comes from `other`'s hash embedding), so a seeded row can
 * sit at a chosen distance from a text the run will embed.
 */
export function vectorAtCosine(target: string, other: string, sim: number): string {
  const t = hashEmbedding(target, 1536);
  const o = hashEmbedding(other, 1536);
  const dot = o.reduce((s, x, i) => s + x * t[i], 0);
  const orth = o.map((x, i) => x - dot * t[i]);
  const norm = Math.sqrt(orth.reduce((s, x) => s + x * x, 0));
  const k = Math.sqrt(1 - sim * sim);
  const v = t.map((x, i) => Math.round((sim * x + (k * orth[i]) / norm) * 1e6) / 1e6);
  return `[${v.join(",")}]`;
}

// --- fake DB client ----------------------------------------------------------

/** Embedded resources the pipeline selects (`code_projects(display_name, repo_identity)`), by foreign key. */
const EMBEDS: Record<string, string> = { code_projects: "code_project_id" };

/**
 * The one PostgREST projection feature the fake leaves out, applied on read
 * results only: `table(cols)` embeds (the fake returns whole rows for a select
 * list with an embed). Column lists, `alias:col->key` paths, filters,
 * ordering and writes are the fake's own.
 */
function projectingClient(db: FakeDb): SupabaseClient {
  const base = db.client;
  const project = (rows: Row[], cols: string): Row[] => {
    const embeds = [...cols.matchAll(/([a-z_]+)\(([^)]*)\)/g)].map((m) => m[1]).filter((t) => EMBEDS[t]);
    if (embeds.length === 0) return rows;
    return rows.map((r) => {
      const out: Row = { ...r };
      for (const t of embeds) out[t] = db.getRows(t).find((p) => p.id === r[EMBEDS[t]]) ?? null;
      return out;
    });
  };
  const post = (res: { data: unknown }, cols: string | null) => {
    if (cols === null || res.data === null || res.data === undefined) return res;
    if (Array.isArray(res.data)) return { ...res, data: project(res.data as Row[], cols) };
    return { ...res, data: project([res.data as Row], cols)[0] };
  };
  // biome-ignore lint/suspicious/noExplicitAny: wraps the fake's loosely typed query builder
  const wrap = (q: any): any => {
    let cols: string | null = null;
    let write = false;
    const proxy: unknown = new Proxy(q, {
      get(target, prop) {
        if (prop === "then") {
          return (ok?: (v: unknown) => unknown, bad?: (e: unknown) => unknown) =>
            target.then((r: { data: unknown }) => post(r, write ? null : cols)).then(ok, bad);
        }
        if (prop === "single" || prop === "maybeSingle") {
          return () => target[prop]().then((r: { data: unknown }) => post(r, write ? null : cols));
        }
        const v = Reflect.get(target, prop, target);
        if (typeof v !== "function") return v;
        return (...args: unknown[]) => {
          if (prop === "select") cols = typeof args[0] === "string" ? args[0] : "*";
          if (prop === "insert" || prop === "update" || prop === "upsert" || prop === "delete") write = true;
          const r = v.apply(target, args);
          return r === target ? proxy : r;
        };
      },
    });
    return proxy;
  };
  return { ...base, from: (t: string) => wrap(base.from(t)) } as unknown as SupabaseClient;
}

// --- serialisation -------------------------------------------------------------

/** Embedding vectors become a short digest; everything else is kept verbatim. */
function stripVectors(v: unknown): unknown {
  if (Array.isArray(v)) {
    if (v.length >= 64 && v.every((x) => typeof x === "number")) {
      let h = 0;
      for (const x of v) h = (Math.imul(h, 31) + Math.round((x as number) * 1e6)) | 0;
      return `<vector dims=${v.length} h=${(h >>> 0).toString(16)}>`;
    }
    return v.map(stripVectors);
  }
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = stripVectors(x);
    return out;
  }
  return v;
}

function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) out[k] = stable((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}

const json = (v: unknown) => `${JSON.stringify(stable(stripVectors(v)), null, 2)}\n`;

// --- the run -------------------------------------------------------------------

function loadEnvLocal(): Record<string, string> {
  const env: Record<string, string> = {};
  const file = path.resolve(__dirname, "../../../.env.local");
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
  }
  return env;
}

export function readRecordingCost(name: string): RecordingCost | null {
  const f = path.join(fixtureDir(name), "recording-cost.json");
  return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, "utf8")) as RecordingCost) : null;
}

export async function runPipeline(
  fx: PipelineFixture,
  mode: ReplayMode,
): Promise<{ artefacts: PipelineArtefacts; replay: LlmReplay; cost: RecordingCost }> {
  const clock = createFixedClock(fx.nowIso);
  const db = new FakeDb({ flavour: "db", clock: clock.iso, nextId: createIdSequence("fa4e0000") });
  db.rpcHandlers.memory_semantic_duplicates = semanticDuplicatesRpc(db);
  const supabase = projectingClient(db);

  let model: string;
  let replay: LlmReplay;
  if (mode === "record" && fx.scripted) {
    model = SCRIPTED_MODEL;
    const script = fx.scripted;
    const upstream: ChatUpstream = {
      chat: {
        completions: {
          create: async (body) => ({ choices: [{ message: { content: script(body) } }], usage: null }),
        },
      },
    };
    replay = new LlmReplay({ mode, upstream });
  } else if (mode === "record" && process.env.MEMBRAL_GOLDEN_PROVIDER?.trim() === "claude-code") {
    model = CLAUDE_CODE_GOLDEN_MODEL;
    replay = new LlmReplay({ mode, upstream: claudeCodeUpstream() });
  } else if (mode === "record") {
    const env = loadEnvLocal();
    model = env.MEMBRAL_MODEL?.trim() || "gpt-4o-mini";
    const upstream = new OpenAI({
      apiKey: env.OPENAI_API_KEY,
      baseURL: env.MEMBRAL_MODEL_BASE_URL?.trim() || undefined,
      maxRetries: 8,
      timeout: 60_000,
    });
    replay = new LlmReplay({ mode, upstream: upstream as never });
  } else {
    const recorded = readRecordingCost(fx.name);
    if (!recorded) throw new Error(`${fx.name}: no recording-cost.json; record with MEMBRAL_GOLDEN_RECORD=1`);
    model = recorded.model;
    const llmFile = path.join(fixtureDir(fx.name), "llm.jsonl");
    const recordings: LlmRecording[] = fs.existsSync(llmFile) ? parseLlmJsonl(fs.readFileSync(llmFile, "utf8")) : [];
    replay = new LlmReplay({ mode, recordings });
  }
  const config: ModelConfig = {
    model,
    baseURL: undefined,
    apiKey: "golden-replay",
    embedModel: EMBED_MODEL,
    embedDimensions: 1536,
  };
  const llm = new LlmClient(config, { client: replay.client, capUsd: CAP_USD });

  const importOne = async (inputFile: string, sourceSessionId: string) => {
    const r = await importCodeSession(supabase, USER_ID, wirePayload(fx, inputFile, sourceSessionId));
    if (r.status !== "imported" || !r.sessionId || !r.codeProjectId) {
      throw new Error(`${fx.name}/${inputFile}: import ${r.status}: ${r.error ?? ""}`);
    }
    return { sessionId: r.sessionId, codeProjectId: r.codeProjectId };
  };

  // 0. prior state (earlier sessions, their memories).
  if (fx.seed) await fx.seed({ db, supabase, importPrior: importOne });

  // 1. import, as the route does.
  const imported = await importOne(fx.inputFile, fx.sourceSessionId);

  // 2. the single windows.ts:125 candidate, if any.
  if (fx.precontext) {
    db.seed("conversations", [
      {
        id: fx.precontext.conversationId,
        user_id: USER_ID,
        title: fx.precontext.title,
        messages: [{ role: "user", content: fx.precontext.firstMessage }],
      },
    ]);
    db.seed("code_cross_links", [
      {
        id: "c1055000-0000-4000-8000-000000000001",
        user_id: USER_ID,
        code_project_id: imported.codeProjectId,
        conversation_id: fx.precontext.conversationId,
        dismissed_at: null,
      },
    ]);
  }

  // 3. tail capture, as the extraction queue calls it (extraction-queue.ts:618).
  await runTailCaptureForSession({ supabase, llm }, USER_ID, imported.sessionId, {
    runId: "golden-run",
    sessionBudgetUsd: resolveSessionBudgetUsd({}),
  });

  // 4. what a next session is served.
  const project = db.getRows("code_projects").find((p) => p.id === imported.codeProjectId);
  const preamble = await buildPreamble(supabase, USER_ID, { repo: String(project?.repo_identity ?? "") });
  const threads = await listOpenThreads(supabase, USER_ID, { now: clock.now() });

  const chat = llm.records.filter((r) => r.model === model);
  const cost: RecordingCost = {
    model,
    ...(fx.scripted ? { scripted: true as const } : {}),
    calls: chat.length,
    tokens_in: chat.reduce((s, r) => s + r.tokens_in, 0),
    tokens_out: chat.reduce((s, r) => s + r.tokens_out, 0),
    usd: Math.round(chat.reduce((s, r) => s + r.cost_usd, 0) * 1e8) / 1e8,
  };

  return {
    replay,
    cost,
    artefacts: {
      "llm.jsonl": toLlmJsonl(replay.calls),
      "db-oplog.json": json(db.oplog),
      "db-final.json": json(db.snapshot()),
      "preamble.txt": `${preamble.lines.join("\n")}\n---\n${json({ recall_token: preamble.recall_token, open_blockers: preamble.open_blockers })}`,
      "threads.json": json(threads),
    },
  };
}
