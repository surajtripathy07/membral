// Builds a throwaway `opencode.db` SQLite file from
// fixtures/sessions/opencode/small-session.json so `membral sessions
// --source opencode` has a real database to read (the CLI reads SQLite for
// opencode, not JSON — see packages/cli/src/opencode-export.ts). Schema
// mirrors packages/cli/src/__tests__/opencode-export.test.ts's own seedDb
// helper exactly (session/message/part tables), extended to also insert the
// `part` rows the fixture carries (the test helper only seeds one message
// per session; this needs the real messages+parts so the imported session
// has real turns/tool calls to render on /code/session/<id>).
//
// Requires Node >= 22.5 (node:sqlite) — same requirement as the CLI's own
// opencode import path (packages/cli/package.json declares this engine).
import { readFileSync } from "node:fs";
import { shiftOpencodeFixture } from "./shift-fixture-time.mjs";

const SCHEMA = `
  CREATE TABLE session (
    id TEXT PRIMARY KEY,
    parent_id TEXT,
    directory TEXT NOT NULL,
    title TEXT NOT NULL,
    agent TEXT,
    model TEXT,
    time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL,
    cost REAL DEFAULT 0 NOT NULL,
    tokens_input INTEGER DEFAULT 0 NOT NULL,
    tokens_output INTEGER DEFAULT 0 NOT NULL,
    tokens_reasoning INTEGER DEFAULT 0 NOT NULL,
    tokens_cache_read INTEGER DEFAULT 0 NOT NULL,
    tokens_cache_write INTEGER DEFAULT 0 NOT NULL
  );
  CREATE TABLE message (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    time_created INTEGER NOT NULL,
    data TEXT NOT NULL
  );
  CREATE TABLE part (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    time_created INTEGER NOT NULL,
    data TEXT NOT NULL
  );
`;

/**
 * Reads `fixtureJsonPath` (the same shape as
 * fixtures/sessions/opencode/small-session.json — {session, messages, parts}),
 * shifts every timestamp it carries to land a few days before "now" (see
 * shift-fixture-time.mjs — /code/stats hardcodes a 30-day window with no
 * override, so a fixture dated on its original fixed historical date would
 * import fine but never show up on that page), and writes a fresh
 * opencode.db at `<dbDir>/opencode.db`. Returns the session id it wrote, so
 * the caller can look it up in code_sessions later.
 */
export async function buildOpencodeFixtureDb(fixtureJsonPath, dbDir) {
  const { DatabaseSync } = await import("node:sqlite");
  const fixture = shiftOpencodeFixture(JSON.parse(readFileSync(fixtureJsonPath, "utf8")));
  const { session, messages, parts } = fixture;

  const dbPath = `${dbDir}/opencode.db`;
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(SCHEMA);

    db.prepare(
      `INSERT INTO session
         (id, parent_id, directory, title, agent, model, time_created, time_updated,
          cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      session.id,
      session.parentId ?? null,
      session.directory,
      session.title,
      session.agent ?? null,
      session.modelRaw ?? null,
      session.timeCreated,
      session.timeUpdated,
      session.cost ?? 0,
      session.tokensInput ?? 0,
      session.tokensOutput ?? 0,
      session.tokensReasoning ?? 0,
      session.tokensCacheRead ?? 0,
      session.tokensCacheWrite ?? 0,
    );

    const insertMessage = db.prepare("INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)");
    for (const m of messages) {
      let timeCreated = session.timeCreated;
      try {
        const parsed = JSON.parse(m.data);
        if (typeof parsed?.time?.created === "number") timeCreated = parsed.time.created;
      } catch {
        // malformed data blob — fall back to the session's own timestamp,
        // same "degrade, don't fail the fixture build" posture as the real
        // reader's per-row try/catch.
      }
      insertMessage.run(m.id, session.id, timeCreated, m.data);
    }

    const insertPart = db.prepare(
      "INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)",
    );
    parts.forEach((p, i) => {
      insertPart.run(`${p.messageId}-part-${i}`, p.messageId, session.id, session.timeCreated + i, p.data);
    });
  } finally {
    db.close();
  }

  return session.id;
}
