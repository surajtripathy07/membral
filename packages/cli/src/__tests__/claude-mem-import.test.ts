// `membral import claude-mem`: reader against the checked-in fictional fixture
// (regenerate with scripts/make-claude-mem-fixture.mjs), dispatch, and the batch upload.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  batchObservations,
  CLAUDE_MEM_BATCH_SIZE,
  CLAUDE_MEM_MAX_SESSIONS_PER_BATCH,
  type ClaudeMemObservation,
  ClaudeMemReadError,
  claudeMemImportCommand,
  readClaudeMemDb,
  serverMessage,
} from "../claude-mem-import.js";
import { findCommand } from "../commands/index.js";
import { HELP } from "../help.js";

const FIXTURE = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/claude-mem/claude-mem.db");

describe("readClaudeMemDb", () => {
  it("reads the fixture observations with their content_session_id", async () => {
    const r = await readClaudeMemDb(FIXTURE);
    expect(r.observations).toHaveLength(10);
    expect(r.orphaned).toBe(0);
    expect(new Set(r.observations.map((o) => o.contentSessionId))).toEqual(
      new Set(["cs-codehub-queue-01", "cs-codehub-queue-02", "cs-codehub-docs-01", "cs-codehub-gone-01"]),
    );
    const first = r.observations[0];
    expect(first).toMatchObject({
      type: "bugfix",
      title: "Retry queue loses jobs on restart",
      promptNumber: 2,
      body: null,
    });
    expect(first?.narrative).toContain("retry queue drops jobs");
  });

  it("errors clearly on a missing file", async () => {
    await expect(readClaudeMemDb("/nonexistent/claude-mem.db")).rejects.toThrow(/No claude-mem database/);
  });

  it("errors clearly on a database with the wrong schema", async () => {
    const dir = mkdtempSync(join(tmpdir(), "membral-cm-"));
    try {
      const { DatabaseSync } = await import("node:sqlite");
      const p = join(dir, "other.db");
      const db = new DatabaseSync(p);
      db.exec("CREATE TABLE notes (id INTEGER)");
      db.close();
      await expect(readClaudeMemDb(p)).rejects.toBeInstanceOf(ClaudeMemReadError);
      await expect(readClaudeMemDb(p)).rejects.toThrow(/does not look like a claude-mem database/);
      const bad = join(dir, "not-sqlite.db");
      writeFileSync(bad, "this is not a database");
      await expect(readClaudeMemDb(bad)).rejects.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("membral import claude-mem command", () => {
  let dir: string;
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "membral-cm-home-"));
    vi.stubEnv("HOME", dir);
    vi.stubEnv("MEMBRAL_API_KEY", "");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    process.exitCode = 0;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    process.exitCode = 0;
  });

  it("is dispatched from `import claude-mem`, not treated as a chat export file", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => JSON.stringify({ inserted: 9, duplicates: 0, unmatched: 1, requoted: 1 }),
      json: async () => ({ inserted: 9, duplicates: 0, unmatched: 1, requoted: 1 }),
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await findCommand("import")?.run([
      "claude-mem",
      "--db",
      FIXTURE,
      "--api-url",
      "http://localhost:3000",
      "--api-key",
      "lls_test",
    ]);
    expect(process.exitCode).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe("http://localhost:3000/api/memory/import-claude-mem");
    const body = JSON.parse(String(init.body)) as { observations: unknown[] };
    expect(body.observations).toHaveLength(10);
    const logged = vi
      .mocked(console.log)
      .mock.calls.map((c) => String(c[0]))
      .join("\n");
    expect(logged).toContain("inserted: 9");
    expect(logged).toContain("no matching Membral session: 1");
  });

  it("exits 1 for a missing db without calling the API", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await claudeMemImportCommand({ db: join(dir, "nope.db"), apiKey: "k", apiUrl: "http://localhost:3000" });
    expect(process.exitCode).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("exits 1 with no API key", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await claudeMemImportCommand({ db: FIXTURE, apiKey: "", apiUrl: "http://localhost:3000" });
    expect(process.exitCode).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stops after a 401 and reports exit 1", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      headers: new Headers(),
      text: async () => '{"error":"Invalid API key"}',
      json: async () => ({ error: "Invalid API key" }),
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await claudeMemImportCommand({ db: FIXTURE, apiKey: "lls_bad", apiUrl: "http://localhost:3000" });
    expect(process.exitCode).toBe(1);
  });

  it("documents the subcommand in import help and caps batches at 100", () => {
    expect(HELP.import).toContain("membral import claude-mem");
    expect(HELP.import).toContain("--db <path>");
    expect(CLAUDE_MEM_BATCH_SIZE).toBe(100);
  });
});

describe("redaction, caps and batching", () => {
  it("redacts secrets and truncates over-long fields, counting the cuts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "membral-cm-"));
    try {
      const { DatabaseSync } = await import("node:sqlite");
      const p = join(dir, "cm.db");
      const db = new DatabaseSync(p);
      db.exec(
        "CREATE TABLE sdk_sessions (content_session_id TEXT, memory_session_id TEXT); CREATE TABLE observations (id INTEGER PRIMARY KEY, memory_session_id TEXT, type TEXT, title TEXT, narrative TEXT, text TEXT, prompt_number INTEGER, created_at TEXT)",
      );
      db.prepare("INSERT INTO sdk_sessions VALUES ('cs-a', 'ms-a')").run();
      // Assembled at runtime so no secret-shaped literal sits in the source.
      const fakeKey = `sk-${"Qw7Er6Ty".repeat(5)}`;
      db.prepare(
        "INSERT INTO observations (memory_session_id, type, title, narrative, text, prompt_number, created_at) VALUES ('ms-a', 'bugfix', ?, ?, NULL, 1, NULL)",
      ).run("t".repeat(800), `used ${fakeKey} then ${"n".repeat(5000)}`);
      db.close();
      const r = await readClaudeMemDb(p);
      const o = r.observations[0];
      expect(o?.title).toHaveLength(500);
      expect(o?.narrative).toHaveLength(4000);
      expect(o?.narrative).not.toContain(fakeKey);
      expect(r.truncated).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("batches by session: at most 100 observations and 25 sessions per request, none lost", () => {
    const mk = (s: number, n: number): ClaudeMemObservation => ({
      contentSessionId: `cs-${s}`,
      type: "bugfix",
      title: null,
      narrative: `n${n}`,
      body: null,
      promptNumber: null,
      createdAt: null,
      rawHash: "0".repeat(64),
    });
    const many = Array.from({ length: 60 }, (_, i) => mk(i, i)); // 60 sessions x 1
    const batches = batchObservations(many);
    expect(batches.map((b) => b.length)).toEqual([25, 25, 10]);
    for (const b of batches)
      expect(new Set(b.map((o) => o.contentSessionId)).size).toBeLessThanOrEqual(CLAUDE_MEM_MAX_SESSIONS_PER_BATCH);
    const one = Array.from({ length: 250 }, (_, i) => mk(1, i)); // 1 session x 250
    expect(batchObservations(one).map((b) => b.length)).toEqual([100, 100, 50]);
    expect(batchObservations([...many, ...one]).flat()).toHaveLength(310);
  });

  it("prints the server's error and issues, not a clipped raw body", () => {
    expect(serverMessage('{"error":"Invalid request","issues":["narrative too long","type required"]}')).toBe(
      "Invalid request: narrative too long; type required",
    );
    expect(serverMessage("<html>bad gateway</html>")).toBe("<html>bad gateway</html>");
    expect(serverMessage("")).toBe("(empty response body)");
  });
});
