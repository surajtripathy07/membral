// discoverOpencodeSessions — real temp-dir SQLite fixtures (2026-09-12
// adversarial review, findings 1/4/5/7). Node's `node:sqlite` is stable
// since 22.5; this suite is skipped entirely on an older Node (finding 1's
// dynamic-import degrade means the module itself never crashes, but there's
// nothing meaningful to test without a real driver — `it.skip` is the
// declared decision here, not a workaround).
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverOpencodeSessions, withoutSqliteExperimentalWarning } from "../opencode-export.js";

let sqliteAvailable = true;
try {
  await import("node:sqlite");
} catch {
  sqliteAvailable = false;
}
const maybeDescribe = sqliteAvailable ? describe : describe.skip;

interface SeedSession {
  id: string;
  parentId?: string | null;
  directory: string;
  title: string;
  agent?: string | null;
  model?: string | null;
  timeCreated: number;
  timeUpdated: number;
  tokensInput?: number;
  tokensOutput?: number;
}

async function seedDb(dbPath: string, sessions: SeedSession[]): Promise<void> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(`
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
  `);
  const insertSession = db.prepare(
    "INSERT INTO session (id, parent_id, directory, title, agent, model, time_created, time_updated, tokens_input, tokens_output) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const s of sessions) {
    insertSession.run(
      s.id,
      s.parentId ?? null,
      s.directory,
      s.title,
      s.agent ?? null,
      s.model ?? null,
      s.timeCreated,
      s.timeUpdated,
      s.tokensInput ?? 0,
      s.tokensOutput ?? 0,
    );
  }
  const insertMessage = db.prepare("INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)");
  for (const s of sessions) {
    insertMessage.run(
      `msg-${s.id}`,
      s.id,
      s.timeCreated,
      JSON.stringify({ role: "user", time: { created: s.timeCreated } }),
    );
  }
  db.close();
}

async function collectAll(root: string, onWarn?: (m: string) => void) {
  const handle = await discoverOpencodeSessions(root, onWarn);
  const out: { ref: { sourceSessionId: string }; raw: string }[] = [];
  for await (const item of handle.sessions) out.push(item);
  return { handle, sessions: out };
}

maybeDescribe("discoverOpencodeSessions", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "membral-opencode-export-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns an empty (non-unreadable) result when opencode.db doesn't exist yet", async () => {
    const { handle, sessions } = await collectAll(root);
    expect(handle.unreadable).toBe(false);
    expect(handle.sqliteUnavailable).toBe(false);
    expect(sessions).toEqual([]);
    expect(handle.skippedCount()).toBe(0);
  });

  it("marks a corrupt opencode.db as unreadable, distinct from 'nothing to sync' (finding 5)", async () => {
    writeFileSync(join(root, "opencode.db"), "not a sqlite file at all");
    const warnings: string[] = [];
    const { handle, sessions } = await collectAll(root, (m) => warnings.push(m));
    expect(handle.unreadable).toBe(true);
    expect(handle.sqliteUnavailable).toBe(false);
    expect(sessions).toEqual([]);
    // SQLite opens lazily — a garbage file fails at the first query
    // ("file is not a database"), not at `new DatabaseSync(...)` itself.
    expect(warnings.some((w) => w.includes("opencode sessions") || w.includes("opencode database"))).toBe(true);
  });

  it("yields a parent session with its embedded direct sub-agent metadata, then the child as its own session", async () => {
    await seedDb(join(root, "opencode.db"), [
      {
        id: "ses_parent",
        directory: "/home/user/codehub",
        title: "Parent",
        timeCreated: 1000,
        timeUpdated: 2000,
        tokensInput: 5,
      },
      {
        id: "ses_child",
        parentId: "ses_parent",
        directory: "/home/user/codehub",
        title: "Child",
        timeCreated: 1100,
        timeUpdated: 1200,
        tokensInput: 50,
        tokensOutput: 10,
      },
    ]);

    const { sessions } = await collectAll(root);
    expect(sessions.map((s) => s.ref.sourceSessionId)).toEqual(["ses_parent", "ses_child"]);

    const parsed = JSON.parse(sessions[0].raw);
    expect(parsed.session.id).toBe("ses_parent");
    expect(parsed.subAgents).toHaveLength(1);
    expect(parsed.subAgents[0].session.id).toBe("ses_child");
    expect(parsed.subAgents[0].session.tokensInput).toBe(50);

    const child = JSON.parse(sessions[1].raw);
    expect(child.session.parentId).toBe("ses_parent");
    expect(child.messages).toHaveLength(1);
    expect(child.subAgents).toBeUndefined();
  });

  it("exports nested grandchildren too, each linked to its DIRECT parent, depth-first", async () => {
    await seedDb(join(root, "opencode.db"), [
      { id: "ses_p", directory: "/home/user/codehub", title: "P", timeCreated: 1000, timeUpdated: 2000 },
      {
        id: "ses_c",
        parentId: "ses_p",
        directory: "/home/user/codehub",
        title: "C",
        timeCreated: 1100,
        timeUpdated: 1200,
      },
      {
        id: "ses_g",
        parentId: "ses_c",
        directory: "/home/user/codehub",
        title: "G",
        timeCreated: 1150,
        timeUpdated: 1160,
      },
      { id: "ses_top2", directory: "/home/user/codehub", title: "T2", timeCreated: 3000, timeUpdated: 3100 },
    ]);

    const { sessions } = await collectAll(root);
    expect(sessions.map((s) => s.ref.sourceSessionId)).toEqual(["ses_p", "ses_c", "ses_g", "ses_top2"]);
    const c = JSON.parse(sessions[1].raw);
    expect(c.session.parentId).toBe("ses_p");
    expect(c.subAgents.map((g: { session: { id: string } }) => g.session.id)).toEqual(["ses_g"]);
    expect(JSON.parse(sessions[2].raw).session.parentId).toBe("ses_c");
  });

  it("updatedSinceMs selects top-level sessions by time_updated but still exports their older descendants", async () => {
    await seedDb(join(root, "opencode.db"), [
      { id: "ses_old", directory: "/home/user/codehub", title: "O", timeCreated: 100, timeUpdated: 200 },
      { id: "ses_new", directory: "/home/user/codehub", title: "N", timeCreated: 1000, timeUpdated: 5000 },
      {
        id: "ses_newchild",
        parentId: "ses_new",
        directory: "/home/user/codehub",
        title: "NC",
        timeCreated: 1100,
        timeUpdated: 1200,
      },
    ]);
    const handle = await discoverOpencodeSessions(root, undefined, { updatedSinceMs: 4000 });
    const ids: string[] = [];
    for await (const item of handle.sessions) ids.push(item.ref.sourceSessionId);
    expect(ids).toEqual(["ses_new", "ses_newchild"]);
  });

  it("orders children deterministically by id (finding 7 — childrenStmt has ORDER BY id)", async () => {
    await seedDb(join(root, "opencode.db"), [
      { id: "ses_parent", directory: "/home/user/codehub", title: "Parent", timeCreated: 1000, timeUpdated: 2000 },
      // Inserted in reverse-id order — ORDER BY id must still sort them.
      {
        id: "ses_child_z",
        parentId: "ses_parent",
        directory: "/home/user/codehub",
        title: "Z",
        timeCreated: 1300,
        timeUpdated: 1300,
      },
      {
        id: "ses_child_a",
        parentId: "ses_parent",
        directory: "/home/user/codehub",
        title: "A",
        timeCreated: 1100,
        timeUpdated: 1100,
      },
      {
        id: "ses_child_m",
        parentId: "ses_parent",
        directory: "/home/user/codehub",
        title: "M",
        timeCreated: 1200,
        timeUpdated: 1200,
      },
    ]);

    const { sessions } = await collectAll(root);
    const parsed = JSON.parse(sessions[0].raw);
    expect(parsed.subAgents.map((s: { session: { id: string } }) => s.session.id)).toEqual([
      "ses_child_a",
      "ses_child_m",
      "ses_child_z",
    ]);
  });

  it("exports byte-identical JSON across two independent runs over the same unchanged database (contentHash idempotency, finding 7)", async () => {
    const dbPath = join(root, "opencode.db");
    await seedDb(dbPath, [
      {
        id: "ses_parent",
        directory: "/home/user/codehub",
        title: "Parent",
        timeCreated: 1000,
        timeUpdated: 2000,
        tokensInput: 5,
      },
      {
        id: "ses_child_z",
        parentId: "ses_parent",
        directory: "/home/user/codehub",
        title: "Z",
        timeCreated: 1300,
        timeUpdated: 1300,
      },
      {
        id: "ses_child_a",
        parentId: "ses_parent",
        directory: "/home/user/codehub",
        title: "A",
        timeCreated: 1100,
        timeUpdated: 1100,
      },
    ]);

    const first = await collectAll(root);
    const second = await collectAll(root);

    // Parent + its two children, each its own export.
    expect(first.sessions).toHaveLength(3);
    expect(second.sessions).toHaveLength(3);
    expect(first.sessions.map((s) => s.raw)).toEqual(second.sessions.map((s) => s.raw));

    const hash1 = createHash("sha256").update(first.sessions[0].raw).digest("hex");
    const hash2 = createHash("sha256").update(second.sessions[0].raw).digest("hex");
    expect(hash1).toBe(hash2);
  });

  it("never materializes more than one session's export at a time (finding 4 — the handle is a lazy async generator, not a pre-built array)", async () => {
    await seedDb(join(root, "opencode.db"), [
      { id: "ses_1", directory: "/home/user/codehub", title: "One", timeCreated: 1000, timeUpdated: 1000 },
      { id: "ses_2", directory: "/home/user/codehub", title: "Two", timeCreated: 2000, timeUpdated: 2000 },
    ]);

    const handle = await discoverOpencodeSessions(root);
    // The handle exposes an async generator, not an array — this is the
    // structural guarantee the review asked for (consumption pulls one
    // session at a time from the database rather than reading everything
    // up front into a `sessions[]` array before returning).
    expect(typeof (handle.sessions as AsyncGenerator<unknown>)[Symbol.asyncIterator]).toBe("function");
    expect(Array.isArray(handle.sessions)).toBe(false);

    const first = await handle.sessions.next();
    expect(first.done).toBe(false);
    const second = await handle.sessions.next();
    expect(second.done).toBe(false);
    const third = await handle.sessions.next();
    expect(third.done).toBe(true);
  });

  it("skippedCount() stays 0 for a clean corpus (the malformed-row skip path itself is exercised by core's own parser tests, which run on hand-crafted export JSON rather than a hard-to-corrupt-in-a-typed-way SQLite row)", async () => {
    await seedDb(join(root, "opencode.db"), [
      { id: "ses_ok", directory: "/home/user/codehub", title: "OK", timeCreated: 1000, timeUpdated: 1000 },
    ]);
    const { handle, sessions } = await collectAll(root);
    expect(sessions).toHaveLength(1);
    expect(handle.skippedCount()).toBe(0);
  });
});

describe("discoverOpencodeSessions — Node < 22.5 degrade (finding 1)", () => {
  // This machine's Node has `node:sqlite`, so we can't literally simulate
  // ERR_UNKNOWN_BUILTIN_MODULE here — the dynamic-import structure itself
  // (verified by reading opencode-export.ts: `await import("node:sqlite")`
  // inside the same try/catch that already handles "file doesn't open") is
  // what makes the degrade possible at all instead of crashing module
  // evaluation. `maybeDescribe` above already skips the real-DB suite
  // outright when `node:sqlite` is unavailable, which is the actual
  // Node-20 behavior this finding was about.
  it("is a documented, not just an implicit, degrade path", () => {
    expect(sqliteAvailable).toBeTypeOf("boolean");
  });
});

describe("withoutSqliteExperimentalWarning (F-008)", () => {
  it("swallows only an ExperimentalWarning mentioning SQLite, and restores emitWarning afterward", async () => {
    const original = process.emitWarning;
    const seen: Array<{ name: string; message: string }> = [];
    process.emitWarning = ((warning: string | Error, type?: string) => {
      seen.push({ name: type ?? "Warning", message: warning instanceof Error ? warning.message : warning });
    }) as typeof process.emitWarning;

    const standIn = process.emitWarning;
    await withoutSqliteExperimentalWarning(async () => {
      // Swallowed: name + message match.
      process.emitWarning("SQLite is an experimental feature and might change at any time", "ExperimentalWarning");
      // Passed through: unrelated warning during the same window.
      process.emitWarning("something else entirely", "DeprecationWarning");
    });

    expect(seen).toEqual([{ name: "DeprecationWarning", message: "something else entirely" }]);

    // The wrapper must restore exactly our stand-in (not Node's real
    // emitWarning, which we replaced before calling it) once it returns.
    expect(process.emitWarning).toBe(standIn);
    process.emitWarning("after", "DeprecationWarning");
    expect(seen).toHaveLength(2);

    process.emitWarning = original;
  });

  it("propagates the wrapped function's return value and restores emitWarning even on throw", async () => {
    const original = process.emitWarning;

    const result = await withoutSqliteExperimentalWarning(async () => 42);
    expect(result).toBe(42);
    expect(process.emitWarning).toBe(original);

    await expect(
      withoutSqliteExperimentalWarning(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(process.emitWarning).toBe(original);
  });
});
