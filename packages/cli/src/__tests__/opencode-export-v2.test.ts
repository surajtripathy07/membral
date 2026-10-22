// opencode v2 storage (`session_v2` + `session_message`) — fictional temp-dir SQLite fixtures.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_TURN_TEXT_CHARS, opencodeParser, type RawCodeSession } from "@membral/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sessionForWire } from "../code-session-upload.js";
import { discoverOpencodeSessions, v2ToLegacyRows } from "../opencode-export.js";

let sqliteAvailable = true;
try {
  await import("node:sqlite");
} catch {
  sqliteAvailable = false;
}
const maybeDescribe = sqliteAvailable ? describe : describe.skip;

const T0 = 1_800_000_000_000;
const SESSION_COLS = `id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT NOT NULL, title TEXT NOT NULL, agent TEXT, model TEXT,
  time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, cost REAL DEFAULT 0 NOT NULL,
  tokens_input INTEGER DEFAULT 0 NOT NULL, tokens_output INTEGER DEFAULT 0 NOT NULL, tokens_reasoning INTEGER DEFAULT 0 NOT NULL,
  tokens_cache_read INTEGER DEFAULT 0 NOT NULL, tokens_cache_write INTEGER DEFAULT 0 NOT NULL`;

type Db = InstanceType<typeof import("node:sqlite").DatabaseSync>;

async function openDb(path: string, tables: { legacy?: boolean; v2?: boolean }): Promise<Db> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path);
  if (tables.legacy) {
    db.exec(`CREATE TABLE session (${SESSION_COLS});
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL);`);
  }
  if (tables.v2) {
    db.exec(`CREATE TABLE session_v2 (${SESSION_COLS});
      CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL,
        time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE UNIQUE INDEX sm_seq ON session_message (session_id, seq);`);
  }
  return db;
}

function addSession(
  db: Db,
  table: "session" | "session_v2",
  id: string,
  o: { parent?: string; updated?: number; dir?: string } = {},
) {
  db.prepare(
    `INSERT INTO ${table} (id, parent_id, directory, title, agent, model, time_created, time_updated, tokens_input, tokens_output) VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    o.parent ?? null,
    o.dir ?? "/work/codehub-demo",
    `Title ${id}`,
    "build",
    null,
    T0,
    o.updated ?? T0 + 1000,
    10,
    5,
  );
}

let seq = 0;
function addMsg(db: Db, sid: string, type: string, data: string, n = seq++, updated = T0 + n) {
  db.prepare(
    "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?,?,?,?,?,?,?)",
  ).run(`msg_${sid}_${n}`, sid, type, n, T0 + n, updated, data);
}
const user = (text: string) => JSON.stringify({ text, time: { created: T0 } });
const assistant = (content: unknown[]) =>
  JSON.stringify({
    agent: "build",
    model: { providerID: "acme", id: "model-x" },
    content,
    finish: "stop",
    time: { created: T0 + 5, completed: T0 + 9 },
  });

async function collect(root: string, opts: { updatedSinceMs?: number } = {}) {
  const warns: string[] = [];
  const handle = await discoverOpencodeSessions(root, (m) => warns.push(m), opts);
  const out: { id: string; session: RawCodeSession }[] = [];
  for await (const { ref, raw } of handle.sessions)
    out.push({ id: ref.sourceSessionId, session: opencodeParser.parse(ref, raw) });
  return { handle, out, warns };
}

maybeDescribe("opencode v2 storage", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "membral-oc-v2-"));
    seq = 0;
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("reads a v2-only db: user, text, reasoning, paired tool, usage and model", async () => {
    const db = await openDb(join(root, "opencode.db"), { v2: true });
    addSession(db, "session_v2", "ses_a");
    addMsg(db, "ses_a", "system", JSON.stringify({ text: "sys", time: { created: T0 } }));
    addMsg(db, "ses_a", "user", user("please fix the widget"));
    addMsg(
      db,
      "ses_a",
      "assistant",
      assistant([
        { type: "reasoning", text: "thinking about widgets", time: { created: T0 + 6 } },
        { type: "text", text: "On it." },
        {
          type: "tool",
          id: "call_1",
          name: "edit",
          state: {
            status: "completed",
            input: { filePath: "/work/codehub-demo/widget.ts", oldString: "a", newString: "b" },
            content: [{ type: "text", text: "ok" }],
            metadata: { diff: "@@ -1 +1 @@\n-a\n+b" },
          },
          time: { created: T0 + 7, completed: T0 + 8 },
        },
      ]),
    );
    db.close();
    const { out, handle, warns } = await collect(root);
    expect(out.map((o) => o.id)).toEqual(["ses_a"]);
    const s = out[0].session;
    expect(s.turns.map((t) => t.kind)).toEqual(["prose", "thinking", "prose", "tool_use"]);
    expect(s.turns[0]).toMatchObject({ role: "user", text: "please fix the widget" });
    expect(s.turns[3]).toMatchObject({
      toolName: "edit",
      toolUseId: "call_1",
      filePath: "/work/codehub-demo/widget.ts",
      editHunks: 1,
    });
    expect(s.filesTouched).toEqual(["/work/codehub-demo/widget.ts"]);
    expect(s.model).toBe("acme/model-x");
    expect(s.usage?.inputTokens).toBe(10);
    expect(s.repo.path).toBe("/work/codehub-demo");
    expect(handle.skippedCount()).toBe(0);
    expect(warns).toEqual([]); // system rows are known, not "unknown"
  });

  it("still reads a legacy-only db", async () => {
    const db = await openDb(join(root, "opencode.db"), { legacy: true });
    addSession(db, "session", "ses_old");
    db.prepare("INSERT INTO message VALUES ('m1','ses_old',1,?)").run(
      JSON.stringify({ role: "user", time: { created: T0 } }),
    );
    db.prepare("INSERT INTO part VALUES ('p1','m1','ses_old',1,?)").run(
      JSON.stringify({ type: "text", text: "legacy prompt" }),
    );
    db.close();
    const { out } = await collect(root);
    expect(out.map((o) => o.id)).toEqual(["ses_old"]);
    expect(out[0].session.turns[0].text).toBe("legacy prompt");
  });

  it("with both: a shared id is read from v2 once; legacy-only ids are kept", async () => {
    const db = await openDb(join(root, "opencode.db"), { legacy: true, v2: true });
    addSession(db, "session", "ses_shared");
    addSession(db, "session", "ses_legacy_only");
    addSession(db, "session_v2", "ses_shared");
    db.prepare("INSERT INTO message VALUES ('m1','ses_shared',1,?)").run(
      JSON.stringify({ role: "user", time: { created: T0 } }),
    );
    db.prepare("INSERT INTO part VALUES ('p1','m1','ses_shared',1,?)").run(
      JSON.stringify({ type: "text", text: "old copy" }),
    );
    addMsg(db, "ses_shared", "user", user("new copy"));
    db.close();
    const { out } = await collect(root);
    expect(out.map((o) => o.id)).toEqual(["ses_legacy_only", "ses_shared"]);
    expect(out[1].session.turns.map((t) => t.text)).toEqual(["new copy"]);
  });

  it("exports a v2 sub-agent child with parentSessionId and lists it under the parent", async () => {
    const db = await openDb(join(root, "opencode.db"), { v2: true });
    addSession(db, "session_v2", "ses_p");
    addSession(db, "session_v2", "ses_c", { parent: "ses_p" });
    addMsg(db, "ses_p", "user", user("delegate it"));
    addMsg(
      db,
      "ses_p",
      "assistant",
      assistant([
        {
          type: "tool",
          id: "call_t",
          name: "task",
          state: {
            status: "completed",
            input: { description: "dig" },
            content: [{ type: "text", text: "done" }],
            metadata: { sessionId: "ses_c" },
          },
          time: { created: T0 + 7 },
        },
      ]),
    );
    addMsg(db, "ses_c", "user", user("child prompt"));
    db.close();
    const { out } = await collect(root);
    expect(out.map((o) => o.id)).toEqual(["ses_p", "ses_c"]);
    expect(out[0].session.subAgents?.[0]).toMatchObject({ agentId: "ses_c", toolUseId: "call_t" });
    expect(out[1].session.parentSessionId).toBe("ses_p");
  });

  it("pairs an errored tool call and keeps going past malformed JSON and unknown types", async () => {
    const db = await openDb(join(root, "opencode.db"), { v2: true });
    addSession(db, "session_v2", "ses_e");
    addMsg(db, "ses_e", "user", user("run it"));
    addMsg(db, "ses_e", "assistant", "{not json");
    addMsg(db, "ses_e", "mystery", "{}");
    addMsg(
      db,
      "ses_e",
      "assistant",
      assistant([
        {
          type: "tool",
          id: "c1",
          name: "bash",
          state: { status: "error", input: { command: "false" }, error: { type: "x", message: "boom" } },
          time: { created: T0 + 7 },
        },
        "garbage-block",
        { type: "text", text: "failed" },
      ]),
    );
    db.close();
    const { out, warns, handle } = await collect(root);
    expect(out[0].session.turns.map((t) => t.kind)).toEqual(["prose", "tool_use", "prose"]);
    expect(out[0].session.toolCounts).toEqual({ bash: 1 });
    expect(warns.join("\n")).toMatch(/unknown type: mystery x1/);
    expect(warns.join("\n")).toMatch(/2 opencode v2 message row/);
    expect(handle.skippedCount()).toBe(0);
  });

  it("yields an empty v2 session with no turns", async () => {
    const db = await openDb(join(root, "opencode.db"), { v2: true });
    addSession(db, "session_v2", "ses_empty");
    db.close();
    const { out } = await collect(root);
    expect(out).toHaveLength(1);
    expect(out[0].session.turns).toEqual([]);
  });

  it("redacts a fake secret and leaves oversized text for the wire clamp", async () => {
    const db = await openDb(join(root, "opencode.db"), { v2: true });
    addSession(db, "session_v2", "ses_s");
    addMsg(db, "ses_s", "user", user("my key is sk-test-0000000000000000 ok"));
    addMsg(db, "ses_s", "assistant", assistant([{ type: "text", text: "x".repeat(MAX_TURN_TEXT_CHARS + 500) }]));
    db.close();
    const { out } = await collect(root);
    expect(out[0].session.turns[0].text).not.toContain("sk-test-0000000000000000");
    const big = out[0].session.turns[1].text ?? "";
    expect(big.length).toBeGreaterThan(MAX_TURN_TEXT_CHARS);
    // through the real upload mapping, as the sweep sends it
    const wire = sessionForWire(out[0].session);
    const wired = wire.turns[1].text ?? "";
    expect(MAX_TURN_TEXT_CHARS).toBe(100_000);
    expect(wired.length).toBeLessThanOrEqual(MAX_TURN_TEXT_CHARS);
    expect(wired.length).toBeGreaterThan(MAX_TURN_TEXT_CHARS - 1_000);
  });

  it("--since follows v2 time_updated of the session, a child, or a message; and the export changes when a message is added", async () => {
    const db = await openDb(join(root, "opencode.db"), { v2: true });
    addSession(db, "session_v2", "ses_old", { updated: T0 });
    addSession(db, "session_v2", "ses_new", { updated: T0 + 10_000 });
    addSession(db, "session_v2", "ses_kid_parent", { updated: T0 });
    addSession(db, "session_v2", "ses_kid", { parent: "ses_kid_parent", updated: T0 + 20_000 });
    addSession(db, "session_v2", "ses_msg", { updated: T0 });
    addMsg(db, "ses_msg", "user", user("first"), 0, T0);
    addMsg(db, "ses_old", "user", user("quiet"), 0, T0);
    const since = T0 + 5_000;
    const first = await collect(root, { updatedSinceMs: since });
    expect(first.out.map((o) => o.id).sort()).toEqual(["ses_kid", "ses_kid_parent", "ses_new"]);
    const hashBefore = (await collect(root)).out.find((o) => o.id === "ses_msg")?.session.contentHash;
    expect(hashBefore).toBeTruthy();
    addMsg(db, "ses_msg", "user", user("later"), 1, T0 + 30_000);
    const second = await collect(root, { updatedSinceMs: since });
    expect(second.out.map((o) => o.id)).toContain("ses_msg");
    expect(second.out.find((o) => o.id === "ses_msg")?.session.contentHash).not.toBe(hashBefore);
    db.close();
  });

  it("--since selects a parent whose only new activity is a message of a sub-agent child, and its hash changes", async () => {
    const db = await openDb(join(root, "opencode.db"), { v2: true });
    addSession(db, "session_v2", "ses_pp", { updated: T0 });
    addSession(db, "session_v2", "ses_pc", { parent: "ses_pp", updated: T0 }); // child row lags its messages
    addMsg(db, "ses_pp", "user", user("parent prompt"), 0, T0);
    addMsg(db, "ses_pc", "user", user("child first"), 0, T0);
    const since = T0 + 5_000;
    expect((await collect(root, { updatedSinceMs: since })).out).toEqual([]);
    const hashBefore = (await collect(root)).out.find((o) => o.id === "ses_pp")?.session.contentHash;
    addMsg(db, "ses_pc", "assistant", assistant([{ type: "text", text: "child answer" }]), 1, T0 + 30_000);
    db.close();
    const after = await collect(root, { updatedSinceMs: since });
    expect(after.out.map((o) => o.id)).toEqual(["ses_pp", "ses_pc"]);
    expect(after.out[0].session.contentHash).not.toBe(hashBefore);
  });

  it("v2 without a seq column still imports, ordered by time_created then id", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(join(root, "opencode.db"));
    db.exec(`CREATE TABLE session_v2 (${SESSION_COLS});
      CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL,
        time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);`);
    addSession(db, "session_v2", "ses_ns");
    const ins = db.prepare("INSERT INTO session_message VALUES (?,?,?,?,?,?)");
    ins.run("b", "ses_ns", "user", T0 + 2, T0 + 2, user("second"));
    ins.run("a", "ses_ns", "user", T0 + 2, T0 + 2, user("third")); // same time: id breaks the tie
    ins.run("z", "ses_ns", "user", T0 + 1, T0 + 1, user("first"));
    db.close();
    const { out, handle } = await collect(root);
    expect(out[0].session.turns.map((t) => t.text)).toEqual(["first", "third", "second"]);
    expect(handle.unreadable).toBe(false);
  });

  it("a v2 table missing a needed column drops only the v2 store; legacy sessions still import", async () => {
    const db = await openDb(join(root, "opencode.db"), { legacy: true });
    db.exec(`CREATE TABLE session_v2 (${SESSION_COLS});
      CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, seq INTEGER, time_created INTEGER, data TEXT);`);
    addSession(db, "session", "ses_keep");
    addSession(db, "session_v2", "ses_v2");
    db.prepare("INSERT INTO message VALUES ('m1','ses_keep',1,?)").run(JSON.stringify({ role: "user", time: {} }));
    db.prepare("INSERT INTO part VALUES ('p1','m1','ses_keep',1,?)").run(
      JSON.stringify({ type: "text", text: "kept" }),
    );
    db.close();
    // no --since: the v2 selection succeeds but its message statement cannot be prepared
    const a = await collect(root);
    expect(a.out.map((o) => o.id)).toEqual(["ses_keep"]);
    expect(a.handle.skippedCount()).toBe(1);
    expect(a.warns.join("\n")).toMatch(/v2 messages unreadable/);
    // with --since the v2 selection itself fails (no time_updated column): store dropped up front
    const b = await collect(root, { updatedSinceMs: T0 });
    expect(b.out.map((o) => o.id)).toEqual(["ses_keep"]);
    expect(b.handle.unreadable).toBe(false);
    expect(b.handle.skippedCount()).toBe(1);
    expect(b.warns.join("\n")).toMatch(/v2 store unreadable/);
  });

  it("a v2-only db whose store is unreadable reports unreadable instead of throwing", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(join(root, "opencode.db"));
    db.exec(`CREATE TABLE session_v2 (${SESSION_COLS}); CREATE TABLE session_message (id TEXT, session_id TEXT);`);
    db.close();
    const handle = await discoverOpencodeSessions(root, () => {}, { updatedSinceMs: T0 });
    expect(handle.unreadable).toBe(true);
  });

  it("an unreadable (blob) message row in one session is counted and later sessions still import", async () => {
    const db = await openDb(join(root, "opencode.db"), { v2: true });
    addSession(db, "session_v2", "ses_1");
    addSession(db, "session_v2", "ses_2");
    addMsg(db, "ses_1", "user", user("one"));
    addMsg(db, "ses_2", "user", user("two"));
    db.close();
    const { DatabaseSync } = await import("node:sqlite");
    const rw = new DatabaseSync(join(root, "opencode.db"));
    rw.exec("UPDATE session_message SET data = x'ff00' WHERE session_id = 'ses_1'");
    rw.close();
    const { out } = await collect(root);
    expect(out.map((o) => o.id)).toContain("ses_2");
  });

  it("maps real-shaped user, assistant and tool rows without losing turns or warning", async () => {
    const db = await openDb(join(root, "opencode.db"), { v2: true });
    addSession(db, "session_v2", "ses_shape");
    addMsg(db, "ses_shape", "system", "{}");
    addMsg(db, "ses_shape", "synthetic", JSON.stringify({ text: "nudge" }));
    addMsg(db, "ses_shape", "compaction", JSON.stringify({ snapshot: "s" }));
    addMsg(db, "ses_shape", "idle", "{}");
    addMsg(
      db,
      "ses_shape",
      "user",
      JSON.stringify({
        text: "look at the invoice module",
        files: [{ uri: "file:///work/codehub-demo/invoice.ts", name: "invoice.ts", mime: "text/plain" }],
        agents: [{ name: "reviewer" }],
        time: { created: T0 },
      }),
    );
    addMsg(
      db,
      "ses_shape",
      "assistant",
      JSON.stringify({
        agent: "build",
        model: { providerID: "acme", id: "model-x" },
        content: [
          { type: "text", text: "Checking." },
          {
            type: "tool",
            id: "t_err",
            name: "bash",
            state: {
              status: "error",
              input: { command: "make" },
              content: [{ type: "text", text: "make: nothing to do" }],
              error: { type: "exit", message: "exit 2" },
            },
            time: { created: T0 + 7 },
          },
          {
            type: "tool",
            id: "t_run",
            name: "read",
            state: { status: "running", input: { filePath: "/work/codehub-demo/invoice.ts" } },
            time: { created: T0 + 8 },
          },
          { type: "tool", id: "t_pend", name: "grep", state: { status: "pending", input: { pattern: "x" } } },
        ],
        error: { name: "APIError", message: "rate limited" },
        tokens: { input: 12, output: 3, reasoning: 0, cache: { read: 1, write: 2 } },
        cost: 0.01,
        snapshot: "abc123",
        finish: "error",
        time: { created: T0 + 5, completed: T0 + 9 },
      }),
    );
    db.close();
    const { out, warns, handle } = await collect(root);
    const turns = out[0].session.turns;
    expect(turns[0]).toMatchObject({ role: "user", text: "look at the invoice module" });
    const tools = turns.filter((t) => t.kind === "tool_use");
    expect(tools.map((t) => t.toolName)).toEqual(["bash", "read", "grep"]);
    expect(tools[0].toolUseId).toBe("t_err");
    expect(turns.filter((t) => t.kind === "tool_result").length).toBeLessThanOrEqual(1);
    expect(warns).toEqual([]);
    expect(handle.skippedCount()).toBe(0);
    // error tool state keeps its content text as the output
    const r = v2ToLegacyRows([
      {
        id: "m",
        type: "assistant",
        data: JSON.stringify({
          content: [
            {
              type: "tool",
              id: "c",
              name: "bash",
              state: { status: "error", content: [{ type: "text", text: "boom out" }] },
            },
          ],
        }),
      },
    ]);
    expect(JSON.parse(r.parts[0].data).state.output).toBe("boom out");
  });

  it("reports an unreadable db when no session tables exist", async () => {
    const db = await openDb(join(root, "opencode.db"), {});
    db.exec("CREATE TABLE unrelated (x INTEGER)");
    db.close();
    const handle = await discoverOpencodeSessions(root, () => {});
    expect(handle.unreadable).toBe(true);
  });

  it("v2ToLegacyRows maps a user row without text to a message with no part", () => {
    const r = v2ToLegacyRows([{ id: "m", type: "user", data: JSON.stringify({ time: { created: 1 } }) }]);
    expect(r.messages).toHaveLength(1);
    expect(r.parts).toHaveLength(0);
  });
});
