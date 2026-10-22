// I33 raw-unit backfill (docs/design/i33-port.md section 5 PR 3, section 7).
//
// Builds `session_raw_units` for every stored code session by calling the PR 2 sweep (sweepSessionRawUnits). The sweep
// is the only writer: it decides staleness by source_hash, embeds outside the transaction and swaps rows in atomically,
// so this script is crash-safe and re-runnable (a session killed mid-way keeps its old units and is simply stale
// again). No LLM or chat client is imported; embeddings go through the PR 2 embed path to the local Ollama model.
//
// usage (from apps/cloud):
//   npx tsx scripts/memory/backfill-raw-units.ts --user <uuid> [--apply] [--limit N] [--since <date>]
//     [--session <id>] [--concurrency 1] [--max-seconds N] [--json] [--allow-hosted] [--allow-hosted-db]
//   npx tsx scripts/memory/backfill-raw-units.ts --bench-embed [N]
//   (or: npm run memory:backfill-raw-units -- --user <uuid> ...)
//
// DEFAULT IS A DRY RUN. It reads sessions and turns, builds the units WITHOUT embedding, and prints per-user counts:
// sessions total / current / stale (would write) / sentinel-skipped (content_hash "") / missing turns, estimated units,
// characters, embedding payload bytes (an upper bound: no vector reuse is assumed), estimated storage and the sessions
// that need multi-chunk staged writes. Nothing is written. Real writes need --apply.
//
// --apply: classifies every session first, then calls the sweep for the STALE ones only, newest first. Progress every
// PROGRESS_EVERY sessions. Ctrl-C (or --max-seconds) lets the current session(s) finish, then prints the summary; a
// second Ctrl-C exits at once. Refuses to run unless the configured embedding provider is local (loopback base URL,
// e.g. Ollama) or --allow-hosted is passed; with no provider configured it always refuses.
//
// --apply also refuses (a) a Supabase URL that is not loopback (localhost, 127.x, ::1, host.docker.internal) unless
// --allow-hosted-db is passed (hosted stores no units, design section 7), and (b) a local store when the free disk space
// is below DISK_HEADROOM x the dry run's estimated storage (checked with fs.statfs on the working directory, the host
// disk; skipped with a note when the database is remote-but-allowed). It stops after OUTAGE_SESSIONS consecutive
// sessions that got no vector at all (an embedding outage) and exits non-zero.
//
// DEFERRED TO PR 4 (precondition, not built here): existing nomic records (session_memories) must be re-embedded with
// the `search_document:` prefix into unitEmbeddingModel(family) before the query side flips. This script writes units only.
//
// --limit N: the NEWEST N sessions (after --since/--session) are taken BEFORE classification, in dry-run and --apply
//   alike, so a dry run with the same flags predicts exactly what --apply touches. Current sessions count toward N.
// --since <date>: only sessions started on or after the date (anything Date.parse accepts, e.g. 2026-09-18).
// --session <id>: one session.
// --concurrency N: sessions swept at once (default 1: the embedder is the bottleneck, and Ollama crashed on parallel
//   batches in the lab).
// --bench-embed [N]: no database. Builds N (default 1000) units from the checked-in synthetic fixtures (varied by a
//   salt so none dedupe), embeds them through the real PR 2 embed path against local Ollama
//   (MEMBRAL_EMBEDDINGS_BASE_URL default http://localhost:11434/v1, model nomic-embed-text:latest) and prints units/s,
//   per-batch p50/p95, the batch size and the failed-embed count. Refuses a non-local base URL.
import { readFileSync, statfsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getServiceClient } from "../../src/lib/db/clients";
import type { Db } from "../../src/lib/db/types";
import { currentEmbeddingFamily, isLocalModelBaseURL, resolveEmbeddingConfig } from "../../src/lib/llm/embedding-client";
import {
  createDefaultUnitEmbedder,
  embedInput,
  embedUnitTexts,
  EMBED_RETRY_AFTER_SECONDS,
  UNIT_EMBED_BATCH_SIZE,
  type UnitEmbedder,
  unitEmbeddingModel,
} from "../../src/lib/memory/raw-units/embed";
import { serverSupabaseUrl } from "../../src/lib/supabase/url";
import { buildRawUnits, computeSourceHash, type RawUnit, UNITS_VERSION, type UnitTurn } from "../../src/lib/memory/raw-units/units";
import { chunkRows, sweepSessionRawUnits, unitsAreStale } from "../../src/lib/memory/raw-units/write";

export const PROGRESS_EVERY = 25;
/** Stop after this many consecutive swept sessions that got no vector at all (embedding outage). */
export const OUTAGE_SESSIONS = 5;
/** --apply needs this multiple of the estimated storage free on disk. */
export const DISK_HEADROOM = 1.5;
/** Design section 7: a stored vector is 1536 floats as text, about 6.2 KB; the HNSW index is the same order [U6]. */
export const VECTOR_ROW_BYTES = 6.2 * 1024;
export const INDEX_ROW_BYTES = 6.2 * 1024;
/** Assumed (design: "a few hundred MB" for 357 k units): text columns + fts + terms GIN cost this multiple of the raw text bytes. */
export const TEXT_OVERHEAD_FACTOR = 1.5;
const PAGE = 1000;

export interface Args {
  userId: string;
  apply: boolean;
  limit: number | undefined;
  since: string | undefined;
  sessionId: string | undefined;
  concurrency: number;
  maxSeconds: number | undefined;
  json: boolean;
  allowHosted: boolean;
  allowHostedDb: boolean;
  benchEmbed: number | undefined;
  help: boolean;
}

export const USAGE =
  "usage: npx tsx scripts/memory/backfill-raw-units.ts --user <uuid> [--apply] [--limit N] [--since <date>] [--session <id>] [--concurrency 1] [--max-seconds N] [--json] [--allow-hosted] [--allow-hosted-db]\n" +
  "       npx tsx scripts/memory/backfill-raw-units.ts --bench-embed [N]\n" +
  "Default is a dry run (no writes). --apply writes through the PR 2 sweep and needs a local embedding provider\n" +
  "(loopback base URL, e.g. Ollama) unless --allow-hosted is passed, and a local Supabase URL unless --allow-hosted-db is\n" +
  "passed. --apply also needs 1.5x the estimated storage free on disk and stops after 5 consecutive sessions with no\n" +
  "vector (embedding outage). --limit N takes the newest N sessions BEFORE classification (current ones count toward N).\n" +
  "--limit and --concurrency must be positive integers. No LLM calls in any mode.\n" +
  "Deferred to PR 4 precondition: nomic records must be re-embedded with the `search_document:` prefix into\n" +
  "unitEmbeddingModel(family) before the query side flips; this script writes units only.";

const VALUE_FLAGS = ["--user", "--limit", "--since", "--session", "--concurrency", "--max-seconds"];

export function parseArgs(argv: string[]): Args | { error: string } {
  for (const f of VALUE_FLAGS) {
    const i = argv.indexOf(f);
    if (i >= 0 && (argv[i + 1] === undefined || argv[i + 1].startsWith("--"))) return { error: `${f} needs a value` };
  }
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const posInt = (flag: string): number | undefined | "bad" => {
    const raw = get(flag);
    if (raw === undefined) return undefined;
    return /^[1-9]\d*$/.test(raw) ? Number(raw) : "bad";
  };
  const help = argv.includes("--help") || argv.includes("-h");
  const benchIdx = argv.indexOf("--bench-embed");
  let benchEmbed: number | undefined;
  if (benchIdx >= 0) {
    const next = argv[benchIdx + 1];
    benchEmbed = next && !next.startsWith("--") ? Number(next) : 1000;
    if (!Number.isInteger(benchEmbed) || benchEmbed <= 0) return { error: "--bench-embed needs a positive integer" };
  }
  const userId = get("--user");
  if (!help && benchEmbed === undefined && !userId) return { error: "--user <uuid> is required" };
  const limit = posInt("--limit");
  const concurrency = posInt("--concurrency");
  if (limit === "bad" || concurrency === "bad") return { error: "--limit and --concurrency need positive integers" };
  const maxSecondsRaw = get("--max-seconds");
  const maxSeconds = maxSecondsRaw === undefined ? undefined : Number(maxSecondsRaw);
  if (maxSeconds !== undefined && !(Number.isFinite(maxSeconds) && maxSeconds > 0))
    return { error: "--max-seconds needs a positive number" };
  const since = get("--since");
  if (since !== undefined && Number.isNaN(Date.parse(since))) return { error: `--since: cannot parse "${since}"` };
  return {
    userId: userId ?? "",
    apply: argv.includes("--apply"),
    limit,
    since,
    sessionId: get("--session"),
    concurrency: concurrency ?? 1,
    maxSeconds,
    json: argv.includes("--json"),
    allowHosted: argv.includes("--allow-hosted"),
    allowHostedDb: argv.includes("--allow-hosted-db"),
    benchEmbed,
    help,
  };
}

// ---------- provider guard ----------

export interface ProviderCheck {
  ok: boolean;
  local: boolean;
  configured: boolean;
  model: string;
  baseURL: string | undefined;
  reason?: string;
}

/** --apply is allowed only against a configured, local (loopback) embedding provider, unless --allow-hosted. */
export function checkProvider(
  allowHosted: boolean,
  env: Record<string, string | undefined> = process.env,
): ProviderCheck {
  const cfg = resolveEmbeddingConfig(env);
  const configured = Boolean(cfg.apiKey);
  const local = isLocalModelBaseURL(cfg.baseURL);
  const base = { local, configured, model: cfg.model, baseURL: cfg.baseURL };
  if (!configured) {
    return {
      ...base,
      ok: false,
      reason:
        "no embedding provider is configured (set MEMBRAL_EMBEDDINGS_BASE_URL to the local Ollama /v1 URL and MEMBRAL_EMBEDDING_MODEL); refusing to write units without vectors",
    };
  }
  if (!local && !allowHosted) {
    return {
      ...base,
      ok: false,
      reason: `the embedding provider is not local (base URL ${cfg.baseURL ?? "api.openai.com"}); hosted embeddings are paid. Point MEMBRAL_EMBEDDINGS_BASE_URL at the local Ollama, or pass --allow-hosted to accept the cost`,
    };
  }
  return { ...base, ok: true };
}

// ---------- database and disk guards ----------

export interface DbTargetCheck {
  ok: boolean;
  local: boolean;
  /** The URL the client really uses (credentials stripped), for printing. */
  url: string | undefined;
  reason?: string;
}

/** A URL safe to print: credentials cleared, or "<unparseable>" for text that is not a URL. */
export function redactUrl(raw: string | undefined): string {
  if (!raw) return "<unset>";
  try {
    const u = new URL(raw);
    u.username = "";
    u.password = "";
    return u.toString();
  } catch {
    return "<unparseable>";
  }
}

/**
 * --apply writes only to a loopback Supabase (hosted stores no units, design section 7) unless --allow-hosted-db.
 * The client talks to serverSupabaseUrl() (SUPABASE_INTERNAL_URL wins over NEXT_PUBLIC_SUPABASE_URL), so that
 * effective URL AND each env URL that is set must be loopback; the refusal names the variable that tripped it.
 */
export function checkDbTarget(
  allowHostedDb: boolean,
  env: Record<string, string | undefined> = process.env,
): DbTargetCheck {
  const internal = env.SUPABASE_INTERNAL_URL?.trim() || undefined;
  const pub = env.NEXT_PUBLIC_SUPABASE_URL?.trim() || undefined;
  const effective = env === process.env ? serverSupabaseUrl() : internal || pub;
  const shown = redactUrl(effective);
  if (!effective) return { ok: false, local: false, url: undefined, reason: "NEXT_PUBLIC_SUPABASE_URL is not set" };
  const candidates: Array<[string, string | undefined]> = [
    [internal === effective ? "SUPABASE_INTERNAL_URL" : "NEXT_PUBLIC_SUPABASE_URL", effective],
    ["SUPABASE_INTERNAL_URL", internal],
    ["NEXT_PUBLIC_SUPABASE_URL", pub],
  ];
  for (const [name, value] of candidates) {
    if (!value) continue;
    let parseable = true;
    try {
      new URL(value);
    } catch {
      parseable = false;
    }
    if (!parseable) {
      return { ok: false, local: false, url: shown, reason: `${name} is not a parseable URL (${redactUrl(value)})` };
    }
    if (!isLocalModelBaseURL(value) && !allowHostedDb) {
      return {
        ok: false,
        local: false,
        url: shown,
        reason: `${name} (${new URL(redactUrl(value)).host}) is not loopback; hosted stores no raw units (design section 7). Pass --allow-hosted-db to write there anyway`,
      };
    }
  }
  return { ok: true, local: candidates.every(([, v]) => !v || isLocalModelBaseURL(v)), url: shown };
}

export interface DiskCheck {
  ok: boolean;
  skipped: boolean;
  freeBytes?: number;
  neededBytes: number;
  note: string;
}

/**
 * Free-disk preflight: refuse when free space is below DISK_HEADROOM x the estimate. Skipped for a remote database. */
export function checkDisk(
  estimateBytes: number,
  dbIsLocal: boolean,
  freeBytes: () => number,
): DiskCheck {
  const neededBytes = Math.ceil(estimateBytes * DISK_HEADROOM);
  if (!dbIsLocal) {
    return { ok: true, skipped: true, neededBytes, note: "disk preflight skipped: the database is remote (--allow-hosted-db)" };
  }
  const free = freeBytes();
  const gb = (n: number) => `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (free < neededBytes) {
    return {
      ok: false,
      skipped: false,
      freeBytes: free,
      neededBytes,
      note: `only ${gb(free)} free on this host's disk; ${gb(neededBytes)} needed (${DISK_HEADROOM}x the ${gb(estimateBytes)} estimate)`,
    };
  }
  return { ok: true, skipped: false, freeBytes: free, neededBytes, note: `disk ok: ${gb(free)} free, ${gb(neededBytes)} needed` };
}

/**
 * Free bytes on the filesystem holding `path`: the HOST disk. Under Colima the Postgres volume lives in the VM's own
 * disk image, which has a fixed size that this number does not measure (the Mac can have 200 GB free while the VM is full).
 */
export function freeBytesOf(path: string): number {
  const st = statfsSync(path);
  return Number(st.bavail) * Number(st.bsize);
}

// ---------- store reads ----------

interface SessionRow {
  id: string;
  content_hash: string;
  started_at: string | null;
}

interface StoredState {
  source_hash: string;
  units_version: number;
  embedding_model: string | null;
  embedding_failed_at: string | null;
}

async function readAll<T>(
  page: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const rows = (data as T[] | null) ?? [];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

/** The user's sessions, newest first (extraction recency convention), after --since/--session/--limit. */
export async function listSessions(db: Db, args: Pick<Args, "userId" | "since" | "sessionId" | "limit">): Promise<SessionRow[]> {
  const rows = await readAll<SessionRow>((from, to) => {
    let q = db.from("code_sessions").select("id, content_hash, started_at").eq("user_id", args.userId);
    if (args.sessionId) q = q.eq("id", args.sessionId);
    if (args.since) q = q.gte("started_at", new Date(Date.parse(args.since)).toISOString());
    return q
      .order("started_at", { ascending: false, nullsFirst: false })
      .order("id", { ascending: true })
      .range(from, to);
  });
  // The query already orders (the id tiebreak keeps the pages stable); the sort is cheap and makes "newest first" a
  // property of this function rather than of the client.
  const ts = (r: SessionRow) => (r.started_at ? Date.parse(r.started_at) : Number.NEGATIVE_INFINITY);
  rows.sort((a, b) => ts(b) - ts(a) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return args.limit ? rows.slice(0, args.limit) : rows;
}

// ---------- classification (dry-run counts; also what --apply sweeps) ----------

export type SessionClass = "current" | "stale" | "sentinel" | "no_turns";

export interface SessionEstimate {
  id: string;
  cls: SessionClass;
  units: number;
  chars: number;
  payloadBytes: number;
  storageBytes: number;
  chunks: number;
}

const empty = (id: string, cls: SessionClass): SessionEstimate => ({
  id,
  cls,
  units: 0,
  chars: 0,
  payloadBytes: 0,
  storageBytes: 0,
  chunks: 0,
});

function textBytes(u: RawUnit): number {
  const b = (s: string | null) => (s ? Buffer.byteLength(s) : 0);
  return b(u.text) + b(u.full_text) + b(u.turn_text);
}

/** The same question ensureSessionRawUnits asks: is a failed embedding old enough to retry? (Postgres' clock, not ours.) */
async function retryDue(db: Db, userId: string, sessionId: string): Promise<boolean> {
  try {
    const { data, error } = await db.rpc("raw_units_retry_due", {
      p_user_id: userId,
      p_code_session_id: sessionId,
      p_retry_seconds: EMBED_RETRY_AFTER_SECONDS,
    });
    return !error && data === true;
  } catch {
    return false;
  }
}

/** Reads one session's turns and stored unit state, builds the units (no embedding) and classifies the session. */
export async function classifySession(
  db: Db,
  userId: string,
  s: SessionRow,
  model: string | null,
  family: string,
): Promise<SessionEstimate> {
  if (s.content_hash === "") return empty(s.id, "sentinel");
  const turns = await readAll<UnitTurn>((from, to) =>
    db
      .from("code_session_turns")
      .select("idx, role, kind, text")
      .eq("user_id", userId)
      .eq("session_id", s.id)
      .order("idx")
      .range(from, to),
  );
  const stored = await readAll<StoredState>((from, to) =>
    db
      .from("session_raw_units")
      .select("source_hash, units_version, embedding_model, embedding_failed_at")
      .eq("user_id", userId)
      .eq("code_session_id", s.id)
      .order("id")
      .range(from, to),
  );
  if (turns.length === 0 && stored.length === 0) return empty(s.id, "no_turns");
  const sorted = [...turns].sort((a, b) => a.idx - b.idx);
  const units = buildRawUnits(sorted);
  const stale =
    (units.length === 0 && stored.length > 0) ||
    (units.length > 0 &&
      (unitsAreStale(stored, {
        sourceHash: computeSourceHash(sorted, UNITS_VERSION),
        unitsVersion: UNITS_VERSION,
        model,
        count: units.length,
      }) ||
        (stored.some((u) => u.embedding_failed_at) && (await retryDue(db, userId, s.id)))));
  if (!stale) return { ...empty(s.id, "current"), units: units.length };
  const embedded = units.map((u) => embedInput(u.text, family));
  const chars = units.reduce((n, u) => n + u.text.length, 0);
  const payloadBytes = embedded.reduce((n, t) => n + Buffer.byteLength(t), 0);
  const storageBytes = units.reduce(
    (n, u) => n + VECTOR_ROW_BYTES + INDEX_ROW_BYTES + textBytes(u) * TEXT_OVERHEAD_FACTOR,
    0,
  );
  const parts = chunkRows(units);
  return {
    id: s.id,
    cls: "stale",
    units: units.length,
    chars,
    payloadBytes,
    storageBytes,
    chunks: parts.length > 1 ? parts.length : 0,
  };
}

// ---------- run ----------

export interface Summary {
  mode: "dry-run" | "apply";
  user: string;
  sessions_total: number;
  sessions_examined: number;
  current: number;
  stale: number;
  sentinel_skipped: number;
  missing_turns: number;
  units_current: number;
  est_units: number;
  est_chars: number;
  est_embedding_payload_bytes: number;
  est_storage_bytes: number;
  multi_chunk_sessions: number;
  stopped_early: string | null;
  /** Failed sessions (classification or sweep errors), both modes. */
  failed: number;
  errors: string[];
  /** True when the run stopped on the cross-session embedding-outage breaker. */
  outage: boolean;
  written?: number;
  already_current?: number;
  superseded?: number;
  units_written?: number;
  embedded?: number;
  reused?: number;
  unembedded?: number;
}

export interface RunDeps {
  db: Db;
  embedder?: UnitEmbedder | null;
  sweep?: typeof sweepSessionRawUnits;
  now?: () => number;
  log?: (line: string) => void;
  /** Returns a reason when the run should stop taking new sessions (Ctrl-C). */
  stopRequested?: () => string | null;
}

export async function run(args: Args, deps: RunDeps): Promise<Summary> {
  const log = deps.log ?? (() => {});
  const now = deps.now ?? Date.now;
  const sweep = deps.sweep ?? sweepSessionRawUnits;
  const family = deps.embedder?.family ?? currentEmbeddingFamily();
  const model = unitEmbeddingModel(family);
  const started = now();
  const sessions = await listSessions(deps.db, args);
  const s: Summary = {
    mode: args.apply ? "apply" : "dry-run",
    user: args.userId,
    sessions_total: sessions.length,
    sessions_examined: 0,
    current: 0,
    stale: 0,
    sentinel_skipped: 0,
    missing_turns: 0,
    units_current: 0,
    est_units: 0,
    est_chars: 0,
    est_embedding_payload_bytes: 0,
    est_storage_bytes: 0,
    multi_chunk_sessions: 0,
    stopped_early: null,
    failed: 0,
    errors: [],
    outage: false,
  };
  if (args.apply) Object.assign(s, { written: 0, already_current: 0, superseded: 0, units_written: 0, embedded: 0, reused: 0, unembedded: 0 });
  log(`[backfill-raw-units] ${s.mode}: ${sessions.length} session(s), newest first, concurrency ${args.concurrency}`);

  let next = 0;
  let noVector = 0;
  const worker = async () => {
    while (true) {
      if (s.stopped_early) return; // outage breaker (or another worker's stop)
      const stop = deps.stopRequested?.() ?? null;
      if (stop) {
        s.stopped_early ??= stop;
        return;
      }
      if (args.maxSeconds && now() - started >= args.maxSeconds * 1000) {
        s.stopped_early ??= `--max-seconds ${args.maxSeconds} reached`;
        return;
      }
      const i = next++;
      if (i >= sessions.length) return;
      let est: SessionEstimate;
      try {
        est = await classifySession(deps.db, args.userId, sessions[i], model, family);
      } catch (err) {
        s.failed++;
        s.errors.push(`${sessions[i].id}: ${err instanceof Error ? err.message : String(err)}`);
        s.sessions_examined++;
        continue;
      }
      s.sessions_examined++;
      if (est.cls === "current") {
        s.current++;
        s.units_current += est.units;
      } else if (est.cls === "sentinel") s.sentinel_skipped++;
      else if (est.cls === "no_turns") s.missing_turns++;
      else {
        s.stale++;
        s.est_units += est.units;
        s.est_chars += est.chars;
        s.est_embedding_payload_bytes += est.payloadBytes;
        s.est_storage_bytes += est.storageBytes;
        if (est.chunks > 0) s.multi_chunk_sessions++;
        if (args.apply) {
          const r = await sweep(deps.db, args.userId, est.id, { embedder: deps.embedder });
          if (r.status === "written") {
            s.written = (s.written ?? 0) + 1;
            s.units_written = (s.units_written ?? 0) + (r.units ?? 0);
            s.embedded = (s.embedded ?? 0) + (r.embedded ?? 0);
            s.reused = (s.reused ?? 0) + (r.reused ?? 0);
            s.unembedded = (s.unembedded ?? 0) + (r.unembedded ?? 0);
          } else if (r.status === "current") s.already_current = (s.already_current ?? 0) + 1;
          else if (r.status === "superseded") s.superseded = (s.superseded ?? 0) + 1;
          else {
            s.failed++;
            s.errors.push(`${est.id}: ${r.error ?? "failed"}`);
          }
          // Cross-session outage breaker: the sweep never throws, a down embedder shows only as sessions with no vector.
          if (r.status === "written" && (r.embedded ?? 0) === 0 && (r.unembedded ?? 0) > 0) {
            if (++noVector >= OUTAGE_SESSIONS) {
              s.outage = true;
              s.stopped_early ??= `embedding outage: ${OUTAGE_SESSIONS} consecutive sessions got no vector`;
            }
          } else if (r.status === "written" || r.status === "current") noVector = 0;
        }
      }
      if (s.sessions_examined % PROGRESS_EVERY === 0) {
        log(
          `[backfill-raw-units] ${s.sessions_examined}/${sessions.length} examined, ${s.stale} stale${args.apply ? `, ${s.written} written, ${s.failed} failed` : ""}`,
        );
      }
    }
  };
  await Promise.all(Array.from({ length: args.concurrency }, worker));
  return s;
}

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

export function formatSummary(s: Summary): string {
  const lines = [
    `[backfill-raw-units] ${s.mode} summary for user ${s.user}${s.stopped_early ? ` (stopped early: ${s.stopped_early})` : ""}`,
    `  sessions total:            ${s.sessions_total} (examined ${s.sessions_examined})`,
    `  already current:           ${s.current} (${s.units_current} units)`,
    `  stale (${s.mode === "apply" ? "swept" : "would write"}):${" ".repeat(s.mode === "apply" ? 8 : 1)}${s.stale}`,
    `  sentinel-skipped:          ${s.sentinel_skipped} (content_hash "")`,
    `  missing turns:             ${s.missing_turns}`,
    `  estimated units:           ${s.est_units}`,
    `  estimated characters:      ${s.est_chars}`,
    `  est. embedding payload:    ${mb(s.est_embedding_payload_bytes)} (upper bound, no vector reuse)`,
    `  est. storage:              ${mb(s.est_storage_bytes)} (vectors + index ${((VECTOR_ROW_BYTES + INDEX_ROW_BYTES) / 1024).toFixed(1)} KB/unit, text x${TEXT_OVERHEAD_FACTOR})`,
    `  multi-chunk staged writes: ${s.multi_chunk_sessions} session(s)`,
    `  failed sessions:           ${s.failed}`,
  ];
  if (s.mode === "apply") {
    lines.push(
      `  written: ${s.written}, already current: ${s.already_current}, superseded: ${s.superseded}`,
      `  units written: ${s.units_written} (embedded ${s.embedded}, reused ${s.reused}, without vector ${s.unembedded})`,
    );
  }
  for (const e of s.errors.slice(0, 10)) lines.push(`  error: ${e}`);
  return lines.join("\n");
}

// ---------- --bench-embed ----------

const FIXTURES = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../src/lib/memory/raw-units/__tests__/fixtures/unit-fixtures.json",
);

/** N synthetic unit texts: the fixtures' turns, each pass salted so no text repeats (and none dedupes in the embed map). */
export function syntheticUnitTexts(n: number, fixtures: Array<{ turns: UnitTurn[] }>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (let variant = 0; out.length < n; variant++) {
    const before = out.length;
    for (const f of fixtures) {
      const turns = f.turns.map((t) => ({
        ...t,
        text: t.text && variant > 0 ? `${t.text}\n(variant ${variant})` : t.text,
      }));
      for (const u of buildRawUnits(turns)) {
        if (seen.has(u.text)) continue; // the embed map dedupes by text; a repeat would not be embedded
        seen.add(u.text);
        out.push(u.text);
        if (out.length >= n) return out;
      }
    }
    if (out.length === before && variant > 0) throw new Error("fixtures produce no new units");
  }
  return out;
}

const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;

export interface BenchResult {
  n: number;
  model: string;
  base_url: string | undefined;
  batch_size: number;
  batches: number;
  seconds: number;
  units_per_s: number;
  batch_ms_p50: number;
  batch_ms_p95: number;
  failed_embeds: number;
  max_chars: number;
  chars_over_2000: number;
  context_note: string;
}

export async function bench(n: number, embedder: UnitEmbedder, fixtures: Array<{ turns: UnitTurn[] }>, cfg: { model: string; baseURL: string | undefined }): Promise<BenchResult> {
  const texts = syntheticUnitTexts(n, fixtures);
  const times: number[] = [];
  const timed: UnitEmbedder = {
    family: embedder.family,
    embedBatch: async (batch) => {
      const t0 = performance.now();
      try {
        return await embedder.embedBatch(batch);
      } finally {
        times.push(performance.now() - t0);
      }
    },
  };
  const t0 = performance.now();
  const res = await embedUnitTexts(texts, timed, embedder.family, []);
  const seconds = (performance.now() - t0) / 1000;
  const sorted = [...times].sort((a, b) => a - b);
  const maxChars = texts.reduce((m, t) => Math.max(m, t.length), 0);
  return {
    n: texts.length,
    model: cfg.model,
    base_url: cfg.baseURL,
    batch_size: UNIT_EMBED_BATCH_SIZE,
    batches: times.length,
    seconds: Number(seconds.toFixed(2)),
    units_per_s: Number((res.embedded / seconds).toFixed(1)),
    batch_ms_p50: Math.round(pct(sorted, 50)),
    batch_ms_p95: Math.round(pct(sorted, 95)),
    failed_embeds: res.failed,
    max_chars: maxChars,
    chars_over_2000: texts.filter((t) => t.length > 2000).length,
    context_note: "",
  };
}

/** Best-effort: the model's context length from Ollama's read-only /api/show (the default; this script never changes it). */
async function ollamaContext(baseURL: string, model: string): Promise<string> {
  try {
    const root = baseURL.replace(/\/v1\/?$/, "");
    const res = await fetch(`${root}/api/show`, { method: "POST", body: JSON.stringify({ model }) });
    const j = (await res.json()) as { model_info?: Record<string, unknown>; parameters?: string };
    const ctx = Object.entries(j.model_info ?? {}).find(([k]) => k.endsWith(".context_length"))?.[1];
    const num = /num_ctx\s+(\d+)/.exec(j.parameters ?? "")?.[1];
    return `model context_length ${ctx ?? "unknown"}, Modelfile num_ctx ${num ?? "not set (server default)"}`;
  } catch (err) {
    return `context length unavailable (${err instanceof Error ? err.message : String(err)})`;
  }
}

async function runBench(n: number, json: boolean): Promise<number> {
  process.env.MEMBRAL_EMBEDDINGS_BASE_URL ||= "http://localhost:11434/v1";
  process.env.MEMBRAL_EMBEDDING_MODEL ||= "nomic-embed-text:latest";
  const cfg = resolveEmbeddingConfig();
  if (!isLocalModelBaseURL(cfg.baseURL)) {
    console.error(`--bench-embed refuses a non-local embedding base URL (${cfg.baseURL ?? "api.openai.com"})`);
    return 1;
  }
  const embedder = createDefaultUnitEmbedder();
  if (!embedder) {
    console.error("--bench-embed: no embedding provider configured");
    return 1;
  }
  const fixtures = JSON.parse(readFileSync(FIXTURES, "utf8")) as Array<{ turns: UnitTurn[] }>;
  const r = await bench(n, embedder, fixtures, { model: cfg.model, baseURL: cfg.baseURL });
  r.context_note = await ollamaContext(cfg.baseURL as string, cfg.model);
  console.log(
    json
      ? JSON.stringify(r)
      : [
          `[backfill-raw-units] bench-embed: ${r.n} synthetic units, model ${r.model} at ${r.base_url}`,
          `  units/s: ${r.units_per_s} (${r.seconds}s total)`,
          `  batch size: ${r.batch_size}, embed calls (incl. split retries): ${r.batches}, per-batch p50 ${r.batch_ms_p50} ms, p95 ${r.batch_ms_p95} ms`,
          `  failed embeds: ${r.failed_embeds}`,
          `  longest unit text: ${r.max_chars} chars; over 2000 chars: ${r.chars_over_2000}`,
          `  ${r.context_note}`,
        ].join("\n"),
  );
  return r.failed_embeds > 0 ? 2 : 0;
}

// ---------- main ----------

async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    console.error(`${parsed.error}\n${USAGE}`);
    return 1;
  }
  if (parsed.help) {
    console.log(USAGE);
    return 0;
  }
  const { config } = await import("dotenv");
  config({ path: ".env.local" });
  if (parsed.benchEmbed !== undefined) return runBench(parsed.benchEmbed, parsed.json);

  let embedder: UnitEmbedder | null | undefined;
  let dbLocal = true;
  if (parsed.apply) {
    const p = checkProvider(parsed.allowHosted);
    if (!p.ok) {
      console.error(`[backfill-raw-units] refusing --apply: ${p.reason}`);
      return 1;
    }
    const t = checkDbTarget(parsed.allowHostedDb);
    if (!t.ok) {
      console.error(`[backfill-raw-units] refusing --apply: ${t.reason}`);
      return 1;
    }
    dbLocal = t.local;
    embedder = createDefaultUnitEmbedder();
  }
  let stop: string | null = null;
  process.on("SIGINT", () => {
    if (stop) process.exit(130);
    stop = "interrupted (Ctrl-C); finishing the current session";
    console.error(`\n[backfill-raw-units] ${stop}`);
  });
  let db: Db;
  try {
    db = getServiceClient();
  } catch (e) {
    console.error(`[backfill-raw-units] ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  const startedAt = Date.now();
  let apply = parsed;
  if (parsed.apply) {
    // Preflight: a dry pass over the same sessions gives the storage estimate the disk check needs. It shares the
    // --max-seconds budget with the apply pass; an early stop makes the estimate partial, so the check is inconclusive.
    const pre = await run({ ...parsed, apply: false }, { db, embedder, log: (l) => console.error(l), stopRequested: () => stop });
    if (pre.failed > 0) console.error(`[backfill-raw-units] preflight: ${pre.failed} session(s) failed to classify: ${pre.errors.slice(0, 3).join("; ")}`);
    if (pre.stopped_early) {
      console.error(`[backfill-raw-units] preflight stopped early (${pre.stopped_early}); the storage estimate is partial, so the disk check is inconclusive; refusing --apply`);
      return stop ? 130 : 1;
    }
    const disk = checkDisk(pre.est_storage_bytes, dbLocal, () => freeBytesOf(process.cwd()));
    console.error(`[backfill-raw-units] ${disk.note}`);
    if (dbLocal) console.error("[backfill-raw-units] disk check measured the host disk, not the Colima VM");
    if (!disk.ok) return 1;
    if (parsed.maxSeconds !== undefined) {
      const left = parsed.maxSeconds - (Date.now() - startedAt) / 1000;
      if (left <= 0) {
        console.error("[backfill-raw-units] --max-seconds spent by the preflight; nothing written");
        return 1;
      }
      apply = { ...parsed, maxSeconds: left };
    }
  }
  const summary = await run(apply, {
    db,
    embedder,
    log: (l) => console.error(l),
    stopRequested: () => stop,
  });
  console.log(parsed.json ? JSON.stringify(summary) : formatSummary(summary));
  return summary.failed > 0 || summary.outage ? 2 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
