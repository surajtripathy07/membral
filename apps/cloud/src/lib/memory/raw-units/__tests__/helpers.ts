// Test doubles for the raw-unit write path: a code-sessions fake DB with an in-JS TWIN (not the SQL; a hand-kept
// mirror, whose semantics are pinned by scripts/sql-checks/replace-session-raw-units.sql) of migration 130's
// replace_session_raw_units (the SQL itself is checked by scripts/sql-checks/replace-session-raw-units.sql), and a
// deterministic embedder. Known differences from the SQL: no real transaction or advisory lock (JS is single-threaded
// between awaits), no owner trigger, no ::vector(1536) cast or int4range parsing of win, and the failure marker
// uses the JS clock where SQL uses now().
import { FakeSupabase } from "@membral/test-kit";
import { EMBEDDING_DIMENSIONS } from "@/lib/llm/embedding-client";
import { parseVector } from "@/lib/llm/vector";
import type { UnitEmbedder } from "../embed";
import { sha256Hex, type UnitTurn } from "../units";

export const USER = "user-1";
export const SESSION = "sess-1";

type Row = Record<string, unknown>;

export interface UnitsDb {
  db: FakeSupabase;
  client: unknown;
  rows: () => Row[];
  rpcCalls: Row[];
  /** Make the next replace_session_raw_units calls fail with this message (null = stop failing). */
  failReplace: (message: string | null) => void;
  /** Moves every failure marker `ms` into the past (the twin of waiting out the retry window). */
  ageFailures: (ms: number) => void;
  /** Rows staged by the chunked write (the twin of session_raw_unit_stage; readers = rows() never see them). */
  staged: () => Row[];
  /** Make the stage rpc fail on its Nth call from now (1-based; null = never): an interruption between chunks. */
  failStageOnCall: (n: number | null) => void;
  /** Calls to stage/commit, in order, as ["stage"|"commit", args]. */
  chunkCalls: Array<[string, Row]>;
}

export function makeUnitsDb(): UnitsDb {
  const db = new FakeSupabase();
  db.seed("code_sessions", [{ id: SESSION, user_id: USER, code_project_id: "proj-1", content_hash: "h" }]);
  return withUnitsRpc(db);
}

/** Wraps a code-sessions FakeSupabase so replace_session_raw_units works (a JS twin of migration 130). */
export function withUnitsRpc(db: FakeSupabase): UnitsDb {
  let fail: string | null = null;
  let stageFailAt: number | null = null;
  let stageCalls = 0;
  let stage: Row[] = [];
  const chunkCalls: Array<[string, Row]> = [];
  const rpcCalls: Row[] = [];
  const rows = () => db.getRows("session_raw_units");
  let seq = 0;
  const client = {
    from: (t: string) => db.from(t),
    rpc: (name: string, args: Record<string, unknown>) => {
      if (name === "raw_units_retry_due") {
        const cutoff = Date.now() - (args.p_retry_seconds as number) * 1000;
        return Promise.resolve({
          data: rows().some(
            (r) =>
              r.code_session_id === args.p_code_session_id &&
              r.embedding == null &&
              Date.parse(String(r.embedding_failed_at)) <= cutoff,
          ),
          error: null,
        });
      }
      if (name === "stage_session_raw_units") {
        chunkCalls.push(["stage", args]);
        stageCalls++;
        if (stageFailAt !== null && stageCalls === stageFailAt) {
          return Promise.resolve({ data: null, error: { message: "stage interrupted" } });
        }
        const part = args.p_rows as Row[];
        for (const r of part) stage.push({ ...r, run_id: args.p_run_id, code_session_id: args.p_code_session_id });
        return Promise.resolve({ data: part.length, error: null });
      }
      if (name === "commit_session_raw_units") {
        chunkCalls.push(["commit", args]);
        const sess = db
          .getRows("code_sessions")
          .find((c) => c.id === args.p_code_session_id && c.user_id === args.p_user_id);
        if (!sess) return Promise.resolve({ data: null, error: { message: "commit: session not found" } });
        if (args.p_content_hash != null && sess.content_hash !== args.p_content_hash) {
          stage = stage.filter((r) => r.run_id !== args.p_run_id);
          return Promise.resolve({ data: -2, error: null });
        }
        const mine = stage.filter((r) => r.run_id === args.p_run_id && r.code_session_id === args.p_code_session_id);
        if (mine.length !== args.p_expected_count) return Promise.resolve({ data: -3, error: null });
        const existing = rows().filter((r) => r.code_session_id === args.p_code_session_id);
        if (mine.length > 0 && existing.length === mine.length) {
          // Same predicate as replace (and the SQL): a failed incoming embed never overwrites a stored good vector.
          const same = mine.filter((s) =>
            existing.some(
              (u) =>
                u.unit === s.unit &&
                u.ord === s.ord &&
                u.source_hash === args.p_source_hash &&
                u.units_version === args.p_units_version &&
                u.text_hash === s.text_hash &&
                ((u.embedding != null && (u.embedding_model ?? null) === (s.embedding_model ?? null)) ||
                  (u.embedding == null && (s.embedding_failed === true || s.embedding == null))),
            ),
          );
          if (same.length === mine.length) {
            for (const u of existing) if (u.embedding == null) u.embedding_failed_at = new Date().toISOString();
            stage = stage.filter((r) => r.code_session_id !== args.p_code_session_id);
            return Promise.resolve({ data: -1, error: null });
          }
        }
        db.setRows(
          "session_raw_units",
          rows().filter((r) => r.code_session_id !== args.p_code_session_id),
        );
        for (const r of mine) {
          const failed = r.embedding_failed === true || r.embedding == null;
          const { embedding_failed: _f, run_id: _r, ...rest } = r;
          db.getRows("session_raw_units").push({
            ...rest,
            id: `unit-${++seq}`,
            user_id: args.p_user_id,
            embedding: failed ? null : r.embedding,
            embedding_model: failed ? null : (r.embedding_model ?? null),
            embedding_failed_at: failed ? new Date().toISOString() : null,
            units_version: args.p_units_version,
            source_hash: args.p_source_hash,
          });
        }
        stage = stage.filter((r) => r.code_session_id !== args.p_code_session_id); // this run and any orphans
        return Promise.resolve({ data: mine.length, error: null });
      }
      if (name !== "replace_session_raw_units") return db.rpc(name, args);
      rpcCalls.push(args);
      if (fail) return Promise.resolve({ data: null, error: { message: fail } });
      const session = db
        .getRows("code_sessions")
        .find((c) => c.id === args.p_code_session_id && c.user_id === args.p_user_id);
      if (!session) {
        return Promise.resolve({ data: null, error: { message: "replace_session_raw_units: session not found" } });
      }
      // Race guard (SQL: p_content_hash vs code_sessions.content_hash; "" = pending sentinel). Null skips the check.
      if (args.p_content_hash != null && session.content_hash !== args.p_content_hash) {
        return Promise.resolve({ data: -2, error: null });
      }
      const incoming = args.p_rows as Row[];
      const existing = rows().filter((r) => r.code_session_id === args.p_code_session_id);
      if (incoming.length > 0 && existing.length === incoming.length) {
        const same = incoming.filter((r) =>
          existing.some(
            (u) =>
              u.unit === r.unit &&
              u.ord === r.ord &&
              u.source_hash === args.p_source_hash &&
              u.units_version === args.p_units_version &&
              u.text_hash === r.text_hash &&
              ((u.embedding != null && (u.embedding_model ?? null) === (r.embedding_model ?? null)) ||
                (u.embedding == null && (r.embedding_failed === true || r.embedding == null))),
          ),
        );
        if (same.length === incoming.length) {
          for (const u of existing) if (u.embedding == null) u.embedding_failed_at = new Date().toISOString();
          return Promise.resolve({ data: -1, error: null });
        }
      }
      stage = stage.filter((r) => r.code_session_id !== args.p_code_session_id); // orphans of an interrupted chunked write
      db.setRows(
        "session_raw_units",
        rows().filter((r) => r.code_session_id !== args.p_code_session_id),
      );
      for (const r of incoming) {
        const failed = r.embedding_failed === true || r.embedding == null;
        const { embedding_failed: _f, ...rest } = r;
        db.getRows("session_raw_units").push({
          ...rest,
          id: `unit-${++seq}`,
          user_id: args.p_user_id,
          code_session_id: args.p_code_session_id,
          embedding: failed ? null : r.embedding,
          embedding_model: failed ? null : (r.embedding_model ?? null),
          embedding_failed_at: failed ? new Date().toISOString() : null,
          units_version: args.p_units_version,
          source_hash: args.p_source_hash,
        });
      }
      return Promise.resolve({ data: incoming.length, error: null });
    },
  };
  return {
    db,
    client,
    rows,
    rpcCalls,
    failReplace: (m) => (fail = m),
    staged: () => stage,
    failStageOnCall: (n) => {
      stageFailAt = n === null ? null : stageCalls + n;
    },
    chunkCalls,
    ageFailures: (ms) => {
      for (const r of rows())
        if (r.embedding_failed_at)
          r.embedding_failed_at = new Date(Date.parse(String(r.embedding_failed_at)) - ms).toISOString();
    },
  };
}

/** Stores a session's turns as code_session_turns rows (what the sweep reads). */
export function seedTurns(db: FakeSupabase, turns: UnitTurn[]): void {
  db.setRows(
    "code_session_turns",
    turns.map((t) => ({
      id: `t-${t.idx}`,
      user_id: USER,
      session_id: SESSION,
      idx: t.idx,
      role: t.role,
      kind: t.kind,
      text: t.text ?? null,
    })),
  );
}

export interface FakeEmbedder extends UnitEmbedder {
  calls: string[][];
  failing: boolean;
}

/** Deterministic non-zero 1536-d vector per input string; `failing` makes every call throw. */
export function fakeEmbedder(family = "nomic-embed-text"): FakeEmbedder {
  const e: FakeEmbedder = {
    family,
    calls: [],
    failing: false,
    embedBatch: async (texts) => {
      e.calls.push(texts);
      if (e.failing) throw new Error("embedder down");
      return texts.map((t) => {
        const v = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
        const h = sha256Hex(t);
        v[Number.parseInt(h.slice(0, 6), 16) % EMBEDDING_DIMENSIONS] = 1;
        v[0] += 0.5;
        return v;
      });
    },
  };
  return e;
}

export const vectorOf = (row: Row): number[] => parseVector(row.embedding);

export const TURNS: UnitTurn[] = [
  { idx: 0, role: "user", kind: "prose", text: "Add a retry to the CodeHub sync client." },
  { idx: 1, role: "assistant", kind: "tool_use", text: "Read src/sync/client.ts" },
  { idx: 2, role: "assistant", kind: "prose", text: "Done: sync() now retries three times." },
];
