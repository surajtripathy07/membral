// Generates the fictional claude-mem store checked in at
// src/__tests__/fixtures/claude-mem/claude-mem.db. Run: node scripts/make-claude-mem-fixture.mjs
// Schema follows claude-mem's SessionStore (sdk_sessions, observations, session_summaries); all
// content is invented (CodeHub projects). Needs Node >= 22.5 (node:sqlite).
import { mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURE_PATH = resolve(here, "../src/__tests__/fixtures/claude-mem/claude-mem.db");

/** Verbatim sentence the router test fixture transcript also contains (exact-match re-anchor). */
export const ANCHORED_NARRATIVE = "The retry queue drops jobs when the worker restarts before the ack is written.";

const SESSIONS = [
  // [content_session_id, memory_session_id, project, started_at_epoch]
  ["cs-codehub-queue-01", "mem-queue-01", "codehub-queue", 1760000000000],
  ["cs-codehub-queue-02", "mem-queue-02", "codehub-queue", 1760100000000],
  ["cs-codehub-docs-01", "mem-docs-01", "codehub-docs", 1760200000000],
  ["cs-codehub-gone-01", "mem-gone-01", "codehub-gateway", 1760300000000],
];

const OBSERVATIONS = [
  // [memory_session_id, type, title, narrative, text, prompt_number, created_at_epoch]
  ["mem-queue-01", "bugfix", "Retry queue loses jobs on restart", ANCHORED_NARRATIVE, null, 2, 1760000100000],
  ["mem-queue-01", "decision", "Ack before dequeue", "Switched the worker to write the ack row before removing the job from the queue.", null, 3, 1760000200000],
  ["mem-queue-01", "discovery", "Backoff table lives in queue/config.ts", "The backoff table is defined in queue/config.ts and read once at boot.", null, 4, 1760000300000],
  ["mem-queue-02", "feature", "Dead-letter listing command", "Added a dead-letter listing subcommand that prints job id, attempts and last error.", null, 1, 1760100100000],
  ["mem-queue-02", "refactor", "Split worker loop", "Split the worker loop into poll, run and settle steps so each can be tested alone.", null, 2, 1760100200000],
  ["mem-docs-01", "change", "Docs sidebar order", "Moved the install guide above the configuration reference in the docs sidebar.", null, 1, 1760200100000],
  ["mem-docs-01", "discovery", "Broken anchor links", "Three anchor links in the troubleshooting page pointed at headings that were renamed.", null, 2, 1760200200000],
  ["mem-docs-01", "decision", "Keep markdown tables", "Keep reference tables as markdown rather than a generated component.", "Keep reference tables as markdown rather than a generated component.", 3, 1760200300000],
  ["mem-gone-01", "bugfix", "Gateway timeout default", "The gateway timeout default was 5 seconds and cut off slow health checks.", null, 1, 1760300100000],
  ["mem-gone-01", "gotcha", "Odd type from a newer version", "A newer claude-mem type value that the importer has no mapping for.", null, 2, 1760300200000],
];

const SUMMARIES = [
  // [memory_session_id, project, request, completed, next_steps, created_at_epoch]
  ["mem-queue-01", "codehub-queue", "Fix lost retries", "Ack ordering fixed", "Add a restart test", 1760000400000],
  ["mem-docs-01", "codehub-docs", "Tidy the docs", "Sidebar and anchors fixed", "Review the tables", 1760200400000],
];

export async function buildFixture(dbPath = FIXTURE_PATH) {
  const { DatabaseSync } = await import("node:sqlite");
  mkdirSync(dirname(dbPath), { recursive: true });
  rmSync(dbPath, { force: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE sdk_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content_session_id TEXT UNIQUE NOT NULL,
      memory_session_id TEXT UNIQUE,
      project TEXT NOT NULL,
      user_prompt TEXT,
      started_at TEXT NOT NULL,
      started_at_epoch INTEGER NOT NULL,
      completed_at TEXT,
      completed_at_epoch INTEGER,
      status TEXT NOT NULL DEFAULT 'active'
    );
    CREATE TABLE observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_session_id TEXT NOT NULL,
      project TEXT NOT NULL,
      text TEXT,
      type TEXT NOT NULL,
      title TEXT,
      subtitle TEXT,
      facts TEXT,
      narrative TEXT,
      concepts TEXT,
      files_read TEXT,
      files_modified TEXT,
      prompt_number INTEGER,
      discovery_tokens INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL
    );
    CREATE TABLE session_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_session_id TEXT NOT NULL,
      project TEXT NOT NULL,
      request TEXT,
      investigated TEXT,
      learned TEXT,
      completed TEXT,
      next_steps TEXT,
      created_at TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL
    );
  `);
  const iso = (ms) => new Date(ms).toISOString();
  const insSession = db.prepare(
    "INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, user_prompt, started_at, started_at_epoch, status) VALUES (?, ?, ?, ?, ?, ?, 'completed')",
  );
  for (const [c, m, p, t] of SESSIONS) insSession.run(c, m, p, "Fictional fixture prompt", iso(t), t);
  const insObs = db.prepare(
    "INSERT INTO observations (memory_session_id, project, text, type, title, narrative, prompt_number, created_at, created_at_epoch) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const projectOf = new Map(SESSIONS.map(([, m, p]) => [m, p]));
  for (const [m, type, title, narrative, text, pn, t] of OBSERVATIONS) {
    insObs.run(m, projectOf.get(m), text, type, title, narrative, pn, iso(t), t);
  }
  const insSum = db.prepare(
    "INSERT INTO session_summaries (memory_session_id, project, request, completed, next_steps, created_at, created_at_epoch) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  for (const [m, p, r, c, n, t] of SUMMARIES) insSum.run(m, p, r, c, n, iso(t), t);
  db.close();
  return dbPath;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = await buildFixture();
  console.log(`wrote ${out}`);
}
