// `membral import claude-mem [--db <path>]` — reads a claude-mem SQLite store
// (default ~/.claude-mem/claude-mem.db, opened read-only) and uploads its
// observations to POST /api/memory/import-claude-mem, which turns them into
// Membral memory records (source "claude-mem"). The server links each one to a
// Membral session by claude-mem's content_session_id == Membral's
// source_session_id and sets a quote only on an exact text match, so this file
// only reads, redacts (secrets, phone/email), caps field lengths and batches; it
// never invents a session link or a quote. The server redacts and caps again.
//
// Schema drift: claude-mem's column set varies by version, so the reader checks
// PRAGMA table_info and needs only the columns it cannot do without
// (sdk_sessions.content_session_id + memory_session_id, observations.
// memory_session_id + type, and one of narrative/text). Optional columns are
// read when present.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { redactPii, redactSecrets } from "@membral/core";
import { createUploadClient, resolveUploadConfig, type UploadFlags } from "./code-session-upload.js";
import type { ApiClient, ApiResult } from "./lib/api-client.js";
import { withoutSqliteExperimentalWarning } from "./opencode-export.js";

export const CLAUDE_MEM_BATCH_SIZE = 100;
/** The server rejects a request spanning more distinct sessions than this. */
export const CLAUDE_MEM_MAX_SESSIONS_PER_BATCH = 25;
/** Server caps (apps/cloud/src/lib/memory/import-claude-mem.ts). */
export const CLAUDE_MEM_MAX_TITLE_CHARS = 500;
export const CLAUDE_MEM_MAX_TEXT_CHARS = 4000;

export function defaultClaudeMemDbPath(): string {
  return join(homedir(), ".claude-mem", "claude-mem.db");
}

/** One observation as sent on the wire (the server's Zod schema mirrors this). */
export interface ClaudeMemObservation {
  contentSessionId: string;
  type: string;
  title: string | null;
  narrative: string | null;
  body: string | null;
  promptNumber: number | null;
  createdAt: string | null;
  /** sha256 hex of the raw (pre-redaction, pre-cap) title/narrative/body; the server's dedupe key. Never the text. */
  rawHash: string;
}

/** Deterministic over the raw fields, so rule or cap changes never change it. */
export function rawHashOf(title: string | null, narrative: string | null, body: string | null): string {
  return createHash("sha256")
    .update(`${title ?? ""}\0${narrative ?? ""}\0${body ?? ""}`)
    .digest("hex");
}

export interface ClaudeMemReadResult {
  observations: ClaudeMemObservation[];
  /** Observations whose memory_session_id has no sdk_sessions row (cannot be linked); never uploaded. */
  orphaned: number;
  /** Observations with neither narrative nor text. */
  empty: number;
  /** Fields cut to the server's length caps. */
  truncated: number;
}

export class ClaudeMemReadError extends Error {}

type Row = Record<string, unknown>;

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

/** Redact then cap one field; counts a cut so the report can say so. */
function clean(v: string | null, cap: number, onCut: () => void): string | null {
  if (v === null) return null;
  const out = redactPii(redactSecrets(v));
  if (out.length > cap) {
    onCut();
    return out.slice(0, cap);
  }
  return out;
}
const int = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);

export async function readClaudeMemDb(dbPath: string): Promise<ClaudeMemReadResult> {
  if (!existsSync(dbPath)) {
    throw new ClaudeMemReadError(`No claude-mem database at ${dbPath}. Pass --db <path> to point at claude-mem.db.`);
  }
  type SqliteModule = typeof import("node:sqlite");
  let DatabaseSync: SqliteModule["DatabaseSync"];
  try {
    ({ DatabaseSync } = await withoutSqliteExperimentalWarning(() => import("node:sqlite")));
  } catch {
    throw new ClaudeMemReadError("membral import claude-mem needs Node >= 22.5 (node:sqlite is unavailable here).");
  }
  let db: InstanceType<SqliteModule["DatabaseSync"]>;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch (err) {
    throw new ClaudeMemReadError(`Could not open ${dbPath}: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    const columns = (table: string): Set<string> =>
      new Set((db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[]).map((r) => r.name));
    const sessionCols = columns("sdk_sessions");
    const obsCols = columns("observations");
    const missing: string[] = [];
    for (const c of ["content_session_id", "memory_session_id"])
      if (!sessionCols.has(c)) missing.push(`sdk_sessions.${c}`);
    for (const c of ["memory_session_id", "type"]) if (!obsCols.has(c)) missing.push(`observations.${c}`);
    if (!obsCols.has("narrative") && !obsCols.has("text")) missing.push("observations.narrative or observations.text");
    if (missing.length > 0) {
      throw new ClaudeMemReadError(
        `${dbPath} does not look like a claude-mem database (missing ${missing.join(", ")}). Schema may have changed; please file an issue with your claude-mem version.`,
      );
    }
    const sel = (c: string) => (obsCols.has(c) ? `o.${c}` : `NULL`);
    const order = obsCols.has("created_at_epoch") ? "o.created_at_epoch, o.id" : "o.id";
    const rows = db
      .prepare(
        `SELECT s.content_session_id AS content_session_id, o.type AS type, ${sel("title")} AS title,
                ${sel("narrative")} AS narrative, ${sel("text")} AS body,
                ${sel("prompt_number")} AS prompt_number, ${sel("created_at")} AS created_at
           FROM observations o
           LEFT JOIN sdk_sessions s ON s.memory_session_id = o.memory_session_id
          ORDER BY ${order}`,
      )
      .all() as Row[];
    const observations: ClaudeMemObservation[] = [];
    let orphaned = 0;
    let empty = 0;
    let truncated = 0;
    const cut = () => {
      truncated++;
    };
    for (const r of rows) {
      const contentSessionId = str(r.content_session_id);
      if (!contentSessionId) {
        orphaned++;
        continue;
      }
      const narrative = clean(str(r.narrative), CLAUDE_MEM_MAX_TEXT_CHARS, cut);
      const body = clean(str(r.body), CLAUDE_MEM_MAX_TEXT_CHARS, cut);
      if (!narrative && !body) {
        empty++;
        continue;
      }
      observations.push({
        contentSessionId,
        type: str(r.type) ?? "unknown",
        title: clean(str(r.title), CLAUDE_MEM_MAX_TITLE_CHARS, cut),
        narrative,
        body,
        promptNumber: int(r.prompt_number),
        createdAt: str(r.created_at),
        rawHash: rawHashOf(str(r.title), str(r.narrative), str(r.body)),
      });
    }
    return { observations, orphaned, empty, truncated };
  } finally {
    db.close();
  }
}

export interface ClaudeMemImportOptions extends UploadFlags {
  db?: string;
}

/**
 * Split into server-sized requests: at most CLAUDE_MEM_BATCH_SIZE observations over at most
 * CLAUDE_MEM_MAX_SESSIONS_PER_BATCH distinct sessions. Observations are grouped by session first
 * (stable within a session) so a session's records stay together.
 */
export function batchObservations(all: ClaudeMemObservation[]): ClaudeMemObservation[][] {
  const bySession = new Map<string, ClaudeMemObservation[]>();
  for (const o of all) {
    const list = bySession.get(o.contentSessionId);
    if (list) list.push(o);
    else bySession.set(o.contentSessionId, [o]);
  }
  const batches: ClaudeMemObservation[][] = [];
  let cur: ClaudeMemObservation[] = [];
  let sessions = 0;
  for (const list of bySession.values()) {
    for (let i = 0; i < list.length; ) {
      if (cur.length >= CLAUDE_MEM_BATCH_SIZE || sessions >= CLAUDE_MEM_MAX_SESSIONS_PER_BATCH) {
        batches.push(cur);
        cur = [];
        sessions = 0;
      }
      const room = CLAUDE_MEM_BATCH_SIZE - cur.length;
      const take = list.slice(i, i + room);
      cur.push(...take);
      sessions++;
      i += take.length;
    }
  }
  if (cur.length > 0) batches.push(cur);
  return batches;
}

interface ImportReply {
  received?: number;
  inserted?: number;
  duplicates?: number;
  unmatched?: number;
  requoted?: number;
  invalid?: number;
  upgraded?: number;
}

export async function claudeMemImportCommand(opts: ClaudeMemImportOptions, client?: ApiClient): Promise<void> {
  const dbPath = opts.db ?? defaultClaudeMemDbPath();
  let read: ClaudeMemReadResult;
  try {
    read = await readClaudeMemDb(dbPath);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }
  console.log(`Read ${read.observations.length} claude-mem observation(s) from ${dbPath}`);
  if (read.observations.length === 0) {
    console.log("Nothing to import.");
    return;
  }

  const config = resolveUploadConfig(opts);
  if (!config.apiKey) {
    console.error("Missing API key. Run `membral login`, pass --api-key, or set MEMBRAL_API_KEY.");
    process.exitCode = 1;
    return;
  }
  const api = client ?? createUploadClient(config, { log: (l) => console.warn(l) });

  const total = { inserted: 0, duplicates: 0, unmatched: 0, requoted: 0, invalid: 0, upgraded: 0 };
  const batches = batchObservations(read.observations);
  const batchCount = batches.length;
  for (const [bi, batch] of batches.entries()) {
    const n = bi + 1;
    console.log(`Uploading batch ${n}/${batchCount} (${batch.length} observation(s))...`);
    const result = await api.call<ImportReply>("importClaudeMem", {
      json: { observations: batch },
      onRetry: (r) => console.warn(`  retrying (${r.kind}, attempt ${r.attempt}/${r.max})`),
    });
    if (!result.ok) {
      const detail = failureDetail(result);
      console.error(`  ! batch ${n} failed: ${detail}`);
      process.exitCode = 1;
      if (result.kind === "auth") break;
      continue;
    }
    const d = result.data ?? {};
    total.inserted += d.inserted ?? 0;
    total.duplicates += d.duplicates ?? 0;
    total.unmatched += d.unmatched ?? 0;
    total.requoted += d.requoted ?? 0;
    total.invalid += d.invalid ?? 0;
    total.upgraded += d.upgraded ?? 0;
  }

  console.log("");
  console.log(
    `{ inserted: ${total.inserted}, already imported: ${total.duplicates}, ` +
      `no matching Membral session: ${total.unmatched + read.orphaned}, quoted by exact match: ${total.requoted}` +
      `${total.upgraded > 0 ? `, upgraded to quoted on re-run: ${total.upgraded}` : ""}` +
      `${read.truncated > 0 ? `, fields truncated to length caps: ${read.truncated}` : ""}` +
      `${total.invalid + read.empty > 0 ? `, invalid: ${total.invalid + read.empty}` : ""} }`,
  );
  if (total.unmatched > 0) {
    console.log(
      "Observations whose claude-mem session has no uploaded Membral session were skipped; run `membral sessions` for those transcripts, then re-run this import.",
    );
  }
}

function failureDetail(result: Extract<ApiResult<unknown>, { ok: false }>): string {
  switch (result.kind) {
    case "auth":
      return result.status === 401
        ? "invalid or missing API key (401) — run `membral login` or pass --api-key"
        : "scoped API keys cannot import (403) — use a key scoped to all memories";
    case "http":
      return `${result.status} ${serverMessage(result.detail)}`;
    case "rate_limited":
      return `rate limited (429) after ${result.attempts} attempts`;
    case "network":
    case "timeout":
      return result.message;
    case "bad_json":
      return `${result.status} response was not JSON`;
    default:
      return "deferred past its deadline";
  }
}

/** The route answers { error, issues? } JSON; show those instead of a clipped raw body. */
export function serverMessage(detail: string): string {
  try {
    const j = JSON.parse(detail) as { error?: unknown; issues?: unknown };
    const issues = Array.isArray(j.issues) ? j.issues.map(String).join("; ") : "";
    const base = typeof j.error === "string" ? j.error : "";
    const msg = [base, issues].filter(Boolean).join(": ");
    if (msg) return msg;
  } catch {
    // not JSON: fall through to the raw text
  }
  return detail || "(empty response body)";
}
