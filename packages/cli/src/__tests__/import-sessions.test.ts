import { chmod, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { claudeCodeParser, FORGE_ACTIONS_VERSION } from "@membral/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SCOPED_KEY_403 } from "../code-session-upload.js";
import { defaultCredentialsPath, deleteCredentials, saveCredentials } from "../credentials.js";
import { importSessions, sendHeartbeatPing } from "../import-sessions.js";
import { envKeyMarkerPath } from "../lib/api-client.js";
import * as opencodeExport from "../opencode-export.js";
import { buildSyncAllowlist, saveSyncAllowlist } from "../sync-allowlist.js";

/** A `discoverOpencodeSessions` handle yielding one fake-but-parseable session, for tests that don't need a real opencode.db (fine-grained opencode-export.ts coverage lives in opencode-export.test.ts). */
function fakeOpencodeHandle(sessions: { id: string; directory: string }[]) {
  async function* gen() {
    for (const s of sessions) {
      yield {
        ref: { source: "opencode" as const, sourceSessionId: s.id, path: `fake.db#${s.id}` },
        raw: JSON.stringify({
          session: {
            id: s.id,
            parentId: null,
            directory: s.directory,
            title: "t",
            agent: null,
            modelRaw: null,
            timeCreated: 1_700_000_000_000,
            timeUpdated: 1_700_000_000_000,
            cost: 0,
            tokensInput: 0,
            tokensOutput: 0,
            tokensReasoning: 0,
            tokensCacheRead: 0,
            tokensCacheWrite: 0,
          },
          messages: [],
          parts: [],
        }),
      };
    }
  }
  return { unreadable: false, sqliteUnavailable: false, sessions: gen(), skippedCount: () => 0 };
}

/**
 * A fetch mock for a server that has the /known endpoint but none of these
 * sessions: POST /api/code-sessions/known answers `{ known: [] }`, every
 * other call goes to `upload`.
 */
function serverWith(upload: (url: string, init: RequestInit) => unknown) {
  return vi
    .fn()
    .mockImplementation(async (url: string, init: RequestInit) =>
      String(url).endsWith("/api/code-sessions/known")
        ? { ok: true, status: 200, json: async () => ({ known: [] }), text: async () => JSON.stringify({ known: [] }) }
        : upload(url, init),
    );
}

/** The fetch calls that were not the /known check. */
function uploadCalls(fetchMock: ReturnType<typeof vi.fn>): unknown[][] {
  return fetchMock.mock.calls.filter((c: unknown[]) => !String(c[0]).endsWith("/api/code-sessions/known"));
}

function sessionLine(cwd: string, timestamp: string, text = "hello from the user") {
  return JSON.stringify({
    type: "user",
    message: { role: "user", content: text },
    cwd,
    gitBranch: "main",
    timestamp,
  });
}

describe("importSessions", () => {
  let root: string;
  let logSpy: ReturnType<typeof vi.fn>;
  let warnSpy: ReturnType<typeof vi.fn>;
  let errorSpy: ReturnType<typeof vi.fn>;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "membral-import-sessions-"));
    await mkdir(join(root, "sessions"), { recursive: true });

    // acme-webapp: one old session (before the --since cutoff used below) and
    // one recent one.
    await writeFile(
      join(root, "sessions", "old-session.jsonl"),
      sessionLine("/home/dev/acme-webapp", "2025-06-01T00:00:00.000Z"),
    );
    await writeFile(
      join(root, "sessions", "recent-session.jsonl"),
      sessionLine("/home/dev/acme-webapp", "2026-02-01T00:00:00.000Z"),
    );
    // A second, unrelated project.
    await writeFile(
      join(root, "sessions", "other-project-session.jsonl"),
      sessionLine("/home/dev/other-proj", "2026-02-02T00:00:00.000Z"),
    );

    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // Issue #136 test-isolation gotcha: resolveUploadConfig falls back to
    // ~/.membral/credentials.json (os.homedir()) when no flag/env key is
    // given — on a machine that has run `membral login`, that's a REAL key,
    // and the "no API key configured" test below would otherwise silently
    // hit the real API with it. os.homedir() reads $HOME live, so pointing
    // it at this test's own empty temp dir isolates the suite from whatever
    // machine it runs on.
    process.env.HOME = root;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    // Mutate process.env in place (not `process.env = {...}`) — replacing the
    // whole object severs the live binding os.homedir() reads from, so a
    // later test's `process.env.HOME = ...` stops reaching it and every
    // subsequent homedir()-derived path silently aliases back to whichever
    // temp dir was current the first time this ran.
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
    process.exitCode = undefined;
  });

  function output(spy: ReturnType<typeof vi.fn>): string {
    return spy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
  }

  it("dry-run parses and resolves without making any network calls", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await importSessions({ root, dryRun: true, apiKey: "lls_unused" });

    expect(fetchMock).not.toHaveBeenCalled();
    const out = output(logSpy);
    expect(out).toContain("Ready to import 3 session(s) (incl. sub-agents) across 2 project(s).");
    expect(out).toContain("/home/dev/acme-webapp");
    expect(out).toContain("/home/dev/other-proj");
  });

  it("--since filters out sessions that ended before the cutoff, per project", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await importSessions({ root, dryRun: true, since: "2026-01-15T00:00:00.000Z" });

    expect(fetchMock).not.toHaveBeenCalled();
    const out = output(logSpy);
    // Only the recent acme-webapp session + the other-proj session remain.
    expect(out).toContain("Ready to import 2 session(s) (incl. sub-agents) across 2 project(s).");
  });

  it("--since mtime prefilter skips transcripts (and sub-agent dirs) untouched since the cutoff, before reading them", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const old = new Date("2020-01-01T00:00:00.000Z");
    await utimes(join(root, "sessions", "old-session.jsonl"), old, old);
    await utimes(join(root, "sessions", "recent-session.jsonl"), old, old);
    // other-project-session keeps a fresh mtime; recent-session gets a fresh sub-agent file.
    const subDir = join(root, "sessions", "recent-session", "subagents");
    await mkdir(subDir, { recursive: true });
    await writeFile(join(subDir, "agent-a.meta.json"), "{}");
    await utimes(subDir, old, old);
    await utimes(join(root, "sessions", "recent-session"), old, old);

    await importSessions({ root, dryRun: true, since: "2026-01-15T00:00:00.000Z" });
    let out = output(logSpy);
    expect(out).toContain("Skipped 1 session file(s) not modified since");
    expect(out).toContain("Ready to import 2 session(s) (incl. sub-agents) across 2 project(s).");

    await utimes(join(subDir, "agent-a.meta.json"), old, old);
    logSpy.mockClear();
    await importSessions({ root, dryRun: true, since: "2026-01-15T00:00:00.000Z" });
    out = output(logSpy);
    expect(out).toContain("Skipped 2 session file(s) not modified since");
    expect(out).toContain("Ready to import 1 session(s) (incl. sub-agents) across 1 project(s).");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("missingHarnessOk: an absent root or missing node:sqlite counts as 'not installed' — ok, no HTTP, exit 0", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const r1 = await importSessions({
      root: join(root, "no-such-dir"),
      apiKey: "lls_test_key",
      since: "2026-01-01T00:00:00.000Z",
      missingHarnessOk: true,
    });
    expect(r1).toEqual({ ok: true, totalImported: 0, totalErrored: 0, totalSessions: 0 });

    vi.spyOn(opencodeExport, "discoverOpencodeSessions").mockResolvedValue({
      unreadable: false,
      sqliteUnavailable: true,
      sessions: (async function* () {})(),
      skippedCount: () => 0,
    });
    const r2 = await importSessions({ root, apiKey: "lls_test_key", source: "opencode", missingHarnessOk: true });
    expect(r2.ok).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it("a missing DEFAULT claude-code root is 'not installed' (silent ok, exit 0); an explicit missing --root still fails", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    // $HOME is a fresh empty dir here, so ~/.claude/projects does not exist.
    const r1 = await importSessions({ apiKey: "lls_test_key", since: "2026-01-01T00:00:00.000Z" });
    expect(r1).toEqual({ ok: true, totalImported: 0, totalErrored: 0, totalSessions: 0 });
    expect(process.exitCode).toBeUndefined();

    const r2 = await importSessions({
      root: join(root, "no-such-dir"),
      apiKey: "lls_test_key",
      source: "claude-code",
      since: "2026-01-01T00:00:00.000Z",
    });
    expect(r2.ok).toBe(false);
    expect(process.exitCode).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("an explicit --source claude-code with a missing DEFAULT root stays loud: not ok, exit 1 (F5)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const r = await importSessions({
      apiKey: "lls_test_key",
      source: "claude-code",
      explicitSource: true,
      since: "2026-01-01T00:00:00.000Z",
    });
    expect(r.ok).toBe(false);
    expect(process.exitCode).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an invalid --since value without touching the filesystem/network", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await importSessions({ root, dryRun: true, since: "not-a-date" });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(output(errorSpy)).toContain("Invalid --since date");
  });

  it("fails fast when no API key is configured for a real (non-dry-run) run", async () => {
    delete process.env.MEMBRAL_API_KEY;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await importSessions({ root });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(output(errorSpy)).toContain("Missing API key");
  });

  it("--force sends force:true on every uploaded batch (issue #91 backfill)", async () => {
    const seenForce: unknown[] = [];
    const fetchMock = serverWith(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { sessions: unknown[]; force?: boolean };
      seenForce.push(body.force);
      return {
        ok: true,
        status: 200,
        json: async () => ({ imported: body.sessions.length, skipped: 0, total: body.sessions.length, errors: [] }),
        text: async () =>
          JSON.stringify({ imported: body.sessions.length, skipped: 0, total: body.sessions.length, errors: [] }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    await importSessions({ root, apiKey: "lls_test_key", apiUrl: "https://cloud.example.com", force: true });

    expect(uploadCalls(fetchMock)).toHaveLength(2); // one batch per project
    expect(seenForce.every((f) => f === true)).toBe(true);
    expect(output(logSpy)).toContain("--force: re-parsing and re-uploading every session in scope");
    expect(output(logSpy)).toMatch(
      /--force: \d+ session\(s\) will be re-uploaded and re-queued for memory extraction \(server-side daily caps apply\); pass --since to narrow\./,
    );
  });

  it("--force with --since omits the 'pass --since to narrow' clause (already narrowed)", async () => {
    const fetchMock = serverWith(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { sessions: unknown[] };
      return {
        ok: true,
        status: 200,
        json: async () => ({ imported: body.sessions.length, skipped: 0, total: body.sessions.length, errors: [] }),
        text: async () =>
          JSON.stringify({ imported: body.sessions.length, skipped: 0, total: body.sessions.length, errors: [] }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    await importSessions({
      root,
      apiKey: "lls_test_key",
      apiUrl: "https://cloud.example.com",
      force: true,
      since: "2026-01-01T00:00:00.000Z",
    });

    const lines = output(logSpy);
    expect(lines).toMatch(
      /--force: \d+ session\(s\) will be re-uploaded and re-queued for memory extraction \(server-side daily caps apply\)\./,
    );
    expect(lines).not.toContain("pass --since to narrow");
  });

  it("without --force, batches omit the force field entirely", async () => {
    const seenBodies: Array<{ sessions: unknown[]; force?: boolean }> = [];
    const fetchMock = serverWith(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { sessions: unknown[]; force?: boolean };
      seenBodies.push(body);
      return {
        ok: true,
        status: 200,
        json: async () => ({ imported: body.sessions.length, skipped: 0, total: body.sessions.length, errors: [] }),
        text: async () =>
          JSON.stringify({ imported: body.sessions.length, skipped: 0, total: body.sessions.length, errors: [] }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    await importSessions({ root, apiKey: "lls_test_key", apiUrl: "https://cloud.example.com" });

    expect(seenBodies.every((b) => !("force" in b))).toBe(true);
  });

  it("uploads sessions grouped by project and reports per-project imported/skipped/errored counts", async () => {
    const fetchMock = serverWith(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { sessions: Array<{ repo: { path?: string } }> };
      const projectPaths = new Set(body.sessions.map((s) => s.repo.path));
      // Every batch should belong to exactly one project (grouped-by-project batching).
      expect(projectPaths.size).toBe(1);
      return {
        ok: true,
        status: 200,
        json: async () => ({ imported: body.sessions.length, skipped: 0, total: body.sessions.length, errors: [] }),
        text: async () =>
          JSON.stringify({ imported: body.sessions.length, skipped: 0, total: body.sessions.length, errors: [] }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    await importSessions({ root, apiKey: "lls_test_key", apiUrl: "https://cloud.example.com" });

    expect(uploadCalls(fetchMock)).toHaveLength(2); // one batch per project
    expect(process.exitCode).toBeUndefined();

    const out = output(logSpy);
    expect(out).toContain("Ready to import 3 session(s) (incl. sub-agents) across 2 project(s).");
    // Totals row: toImport=3, imported=3, skipped=0, errored=0, skippedOld=0
    // (no --since in this test, so nothing is filtered by age).
    expect(out).toMatch(/TOTAL\s+3\s+3\s+0\s+0\s+0/);
  });

  it("F-007: hides an all-zero project row and reports how many were hidden", async () => {
    // Mark both acme-webapp sessions as already known/unchanged (so that
    // project's row ends up toImport=0, imported=0, skipped=0, errored=0,
    // skippedOld=0, skippedDisabled=0 — nothing to do at all) while
    // other-proj's session is unknown and uploads normally.
    const fetchMock = vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      if (String(url).endsWith("/known")) {
        const known = (body.sessions as Array<{ source_session_id: string }>).flatMap((p, i) =>
          p.source_session_id === "old-session" || p.source_session_id === "recent-session" ? [i] : [],
        );
        return { ok: true, status: 200, json: async () => ({ known }), text: async () => JSON.stringify({ known }) };
      }
      const n = body.sessions.length;
      return {
        ok: true,
        status: 200,
        json: async () => ({ imported: n, skipped: 0, total: n, errors: [] }),
        text: async () => JSON.stringify({ imported: n, skipped: 0, total: n, errors: [] }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    await importSessions({ root, apiKey: "lls_test_key", apiUrl: "https://cloud.example.com" });

    const out = output(logSpy);
    expect(out).not.toContain("acme-webapp");
    expect(out).toContain("other-proj");
    expect(out).toContain("1 project(s) with nothing to do hidden");
  });

  // Maintainer ask (2026-09-25): upload newest-first, across every project,
  // so the server's extraction chain reaches the most-recent-and-likely-
  // wanted sessions first on a backlog that can take a while to drain. The
  // beforeEach fixture's three sessions end at (oldest to newest)
  // old-session (2025-06-01, acme-webapp), recent-session (2026-02-01,
  // acme-webapp), other-project-session (2026-02-02, other-proj) — so the
  // newer other-proj batch should upload before acme-webapp's, and within
  // acme-webapp's own (single, both sessions fit one batch) batch,
  // recent-session should be ordered ahead of old-session.
  it("uploads batches newest-first across projects, and sorts sessions newest-first within a batch", async () => {
    const batchOrder: string[] = [];
    const fetchMock = serverWith(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as {
        sessions: Array<{ sourceSessionId: string; repo: { path?: string } }>;
      };
      batchOrder.push(...body.sessions.map((s) => s.sourceSessionId));
      return {
        ok: true,
        status: 200,
        json: async () => ({ imported: body.sessions.length, skipped: 0, total: body.sessions.length, errors: [] }),
        text: async () =>
          JSON.stringify({ imported: body.sessions.length, skipped: 0, total: body.sessions.length, errors: [] }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    await importSessions({ root, apiKey: "lls_test_key", apiUrl: "https://cloud.example.com" });

    expect(batchOrder).toEqual(["other-project-session", "recent-session", "old-session"]);
  });

  it("uploads each sub-agent transcript as its own child session, following the parent's --since decision", async () => {
    // Sub-agent sidecars for the recent acme-webapp session; the child's own
    // timestamp is older than --since, but it follows its (recent) parent.
    const subDir = join(root, "sessions", "recent-session", "subagents");
    await mkdir(subDir, { recursive: true });
    await writeFile(join(subDir, "agent-a1.meta.json"), JSON.stringify({ agentType: "Explore", toolUseId: "toolu_1" }));
    await writeFile(
      join(subDir, "agent-a1.jsonl"),
      `${JSON.stringify({
        type: "user",
        isSidechain: true,
        message: { role: "user", content: "explore the repo" },
        timestamp: "2025-01-01T00:00:00.000Z",
      })}\n`,
    );

    const uploaded: Array<{ sourceSessionId: string; parentSessionId?: string; repo: { path?: string } }> = [];
    const fetchMock = serverWith(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { sessions: typeof uploaded };
      uploaded.push(...body.sessions);
      return {
        ok: true,
        status: 200,
        json: async () => ({ imported: body.sessions.length, skipped: 0, total: body.sessions.length, errors: [] }),
        text: async () =>
          JSON.stringify({ imported: body.sessions.length, skipped: 0, total: body.sessions.length, errors: [] }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    await importSessions({
      root,
      apiKey: "lls_test_key",
      apiUrl: "https://cloud.example.com",
      since: "2026-01-15T00:00:00.000Z",
    });

    const child = uploaded.find((s) => s.sourceSessionId === "recent-session:agent-a1");
    expect(child?.parentSessionId).toBe("recent-session");
    // Same project as the parent (inherits the parent's cwd).
    expect(child?.repo.path).toBe("/home/dev/acme-webapp");
    const ids = uploaded.map((s) => s.sourceSessionId);
    expect(ids.indexOf("recent-session")).toBeLessThan(ids.indexOf("recent-session:agent-a1"));
    expect(ids).not.toContain("old-session");
    expect(process.exitCode).toBeUndefined();
  });

  // 2026-10-08: a rejected key on the /known probe used to warn, then 401
  // the first batch and silently drop every other batch. Now it stops at the
  // probe, names the server, key source and fix, and counts what was not sent.
  it("a 401 on the /known probe stops before any upload and says why and how much was not sent", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 401, text: async () => "" });
    vi.stubGlobal("fetch", fetchMock);

    const result = await importSessions({ root, apiKey: "lls_rejected_key", apiUrl: "http://localhost:3000" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(uploadCalls(fetchMock)).toHaveLength(0);
    expect(result).toMatchObject({ ok: false, totalImported: 0, totalSessions: 3, authRejected: true });
    expect(process.exitCode).toBe(1);
    const err = output(errorSpy);
    expect(err).toContain("known-sessions check rejected the API key (401)");
    expect(err).toContain("the server at http://localhost:3000 rejected API key lls_re…");
    expect(err).not.toContain("lls_rejected_key");
    expect(err).toContain("lsof -nP -iTCP:3000 -sTCP:LISTEN");
    expect(err).toContain("Stopped: 3 session(s) not uploaded");
  });

  it("a 403 on the /known probe stops with the same scoped-key text the upload path uses", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 403, text: async () => "" });
    vi.stubGlobal("fetch", fetchMock);

    const result = await importSessions({ root, apiKey: "lls_scoped_key", apiUrl: "https://cloud.example.com" });

    expect(uploadCalls(fetchMock)).toHaveLength(0);
    expect(result).toMatchObject({ ok: false, totalImported: 0, totalSessions: 3, authRejected: true });
    const err = output(errorSpy);
    expect(err).toContain(SCOPED_KEY_403);
    expect(err).toContain("Stopped: 3 session(s) not uploaded");
  });

  it("a 401 on the first upload batch reports the batch with its reason and counts the batches never sent", async () => {
    const fetchMock = serverWith(() => ({ ok: false, status: 401, text: async () => "" }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await importSessions({ root, apiKey: "lls_rejected_key", apiUrl: "https://cloud.example.com" });

    expect(uploadCalls(fetchMock)).toHaveLength(1);
    expect(result).toMatchObject({ ok: false, totalImported: 0, totalErrored: 1, authRejected: true });
    const err = output(errorSpy);
    expect(err).toContain("batch upload failed (1 session(s)): Invalid or missing API key (401)");
    expect(err).toContain("the server at https://cloud.example.com rejected API key lls_re… from the --api-key flag");
    expect(err).not.toContain("lsof"); // not a localhost URL
    expect(err).toContain("Stopped after the API key was rejected: 2 more session(s) not uploaded");
  });

  // M4 (adversarial round 1 on #136): a stale MEMBRAL_API_KEY must not
  // shadow a valid ~/.membral/credentials.json key for this sync leg
  // either. Writes to defaultCredentialsPath() rather than a path under
  // `root` — see import-session.test.ts's identical M4 test for why (a
  // Node/vitest-worker quirk observed here can make node:os's homedir()
  // return a value cached from an earlier test in this file, not
  // necessarily this test's own $HOME) — cleaned up in `finally` so it
  // can't leak into another test's "no credentials.json" assumption.
  it("M4: a stale env key that 401s on the first batch retries with credentials.json's key and keeps using it", async () => {
    const credsPath = defaultCredentialsPath();
    saveCredentials(
      { apiUrl: "https://cloud.example.com", apiKey: "lls_from_creds", email: "e", userId: "i", createdAt: "c" },
      credsPath,
    );
    try {
      process.env.MEMBRAL_API_KEY = "lls_stale_env";
      let call = 0;
      const fetchMock = vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
        call++;
        const auth = (init.headers as Record<string, string>).authorization;
        if (call === 1) {
          // The first request of the run is the /known check.
          expect(url).toBe("https://cloud.example.com/api/code-sessions/known");
          expect(auth).toBe("Bearer lls_stale_env");
          return { ok: false, status: 401, text: async () => "" };
        }
        // Every call after the first (the /known retry, and both project
        // batches) must use the fallback key — the swap persists for the
        // rest of the run, not just the one retried call.
        expect(auth).toBe("Bearer lls_from_creds");
        if (url.endsWith("/known"))
          return {
            ok: true,
            status: 200,
            json: async () => ({ known: [] }),
            text: async () => JSON.stringify({ known: [] }),
          };
        const body = JSON.parse(init.body as string) as { sessions: unknown[] };
        return {
          ok: true,
          status: 200,
          json: async () => ({ imported: body.sessions.length, skipped: 0, total: body.sessions.length, errors: [] }),
          text: async () =>
            JSON.stringify({ imported: body.sessions.length, skipped: 0, total: body.sessions.length, errors: [] }),
        };
      });
      vi.stubGlobal("fetch", fetchMock);

      const result = await importSessions({ root, apiUrl: "https://cloud.example.com" });

      expect(fetchMock).toHaveBeenCalledTimes(4); // /known (401) + /known retry + 2 batches
      expect(uploadCalls(fetchMock)).toHaveLength(2);
      expect(result.ok).toBe(true);
      expect(process.exitCode).toBeUndefined();
      expect(output(warnSpy)).toContain("retrying with the key from");
    } finally {
      deleteCredentials(credsPath);
      // The upload client leaves an env-key-rejected marker beside credentials.json after the fallback worked.
      await rm(envKeyMarkerPath(dirname(credsPath), "lls_stale_env", "https://cloud.example.com"), { force: true });
    }
  });

  // B1 (2026-07-26 adversarial review): a healthy idle sweep must still
  // touch the server, or the code freshness heartbeat never advances and a
  // perfectly healthy sweep looks "code stale" on /pulse.
  describe("run with nothing new to upload (B1 heartbeat ping)", () => {
    it("pings the server with an explicit empty batch when --since filters out every session", async () => {
      const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as { sessions: unknown[] };
        expect(body.sessions).toEqual([]);
        return {
          ok: true,
          status: 200,
          json: async () => ({ imported: 0, skipped: 0, total: 0, errors: [] }),
          text: async () => JSON.stringify({ imported: 0, skipped: 0, total: 0, errors: [] }),
        };
      });
      vi.stubGlobal("fetch", fetchMock);

      await importSessions({
        root,
        apiKey: "lls_test_key",
        apiUrl: "https://cloud.example.com",
        since: "2027-01-01T00:00:00.000Z", // after every test session's endedAt
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://cloud.example.com/api/code-sessions");
      expect(process.exitCode).toBeUndefined();
      expect(output(logSpy)).toContain("heartbeat ping");
    });

    it("ALSO pings on a FULL walk (--since absent) that finds nothing to upload (round 4, Minor 1)", async () => {
      // Round 1-3 gated the ping on `sinceMs !== undefined`, so a plain
      // full backfill (no --since) that happened to find zero sessions to
      // upload (e.g. an empty root, or every session already on the
      // server and server-side content_hash-skipped) made zero HTTP calls
      // and the heartbeat went stale exactly like the --since case B1
      // fixed. The gate is now `totalToUpload === 0` alone.
      const emptyRoot = await mkdtemp(join(tmpdir(), "membral-import-sessions-empty-"));
      try {
        const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
          const body = JSON.parse(init.body as string) as { sessions: unknown[] };
          expect(body.sessions).toEqual([]);
          return {
            ok: true,
            status: 200,
            json: async () => ({ imported: 0, skipped: 0, total: 0, errors: [] }),
            text: async () => JSON.stringify({ imported: 0, skipped: 0, total: 0, errors: [] }),
          };
        });
        vi.stubGlobal("fetch", fetchMock);

        await importSessions({ root: emptyRoot, apiKey: "lls_test_key" });

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(process.exitCode).toBeUndefined();
        // No --since, so the message must not say "No new sessions since undefined".
        expect(output(logSpy)).toContain("No sessions to upload — sending an empty-batch heartbeat ping.");
      } finally {
        await rm(emptyRoot, { recursive: true, force: true });
      }
    });

    // MAJOR 1 / Minor 2 (round 2, 2026-07-26): round 1's ping sat below an
    // `if (refs.length === 0) return` early return, so it was UNREACHABLE
    // whenever detect() found literally zero refs — which used to include
    // "root missing/unreadable" (silently swallowed to [] by detect()) as
    // well as "root exists, genuinely empty". That early return is gone
    // now; both cases below prove the ping fires regardless of refs.length.
    it("pings even when --since is set and the root EXISTS but is legitimately empty (refs.length === 0)", async () => {
      const emptyRoot = await mkdtemp(join(tmpdir(), "membral-import-sessions-empty-since-"));
      try {
        const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
          const body = JSON.parse(init.body as string) as { sessions: unknown[] };
          expect(body.sessions).toEqual([]);
          return {
            ok: true,
            status: 200,
            json: async () => ({ imported: 0, skipped: 0, total: 0, errors: [] }),
            text: async () => JSON.stringify({ imported: 0, skipped: 0, total: 0, errors: [] }),
          };
        });
        vi.stubGlobal("fetch", fetchMock);

        await importSessions({ root: emptyRoot, apiKey: "lls_test_key", since: "2026-01-01T00:00:00.000Z" });

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(process.exitCode).toBeUndefined();
        expect(output(logSpy)).toContain("heartbeat ping");
      } finally {
        await rm(emptyRoot, { recursive: true, force: true });
      }
    });

    it("pings even when refs.length > 0 but EVERY session fails to read/parse (byProject genuinely empty, not vacuously so)", async () => {
      // Round 1's "does NOT ping when --since is absent" test used an empty
      // root, which trivially has refs.length === 0 — it never actually
      // exercised "detect() found real refs, but none of them survived
      // into byProject" (the read/parse-failure `continue` paths in the
      // main loop). Stub detect() to return refs pointing at files that
      // don't exist, so readFile() genuinely fails for each one — real
      // failure path, not a fabricated shortcut.
      const detectSpy = vi.spyOn(claudeCodeParser, "detect").mockResolvedValueOnce([
        { source: "claude-code", sourceSessionId: "ghost-1", path: join(root, "does-not-exist-1.jsonl") },
        { source: "claude-code", sourceSessionId: "ghost-2", path: join(root, "does-not-exist-2.jsonl") },
      ]);

      const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as { sessions: unknown[] };
        expect(body.sessions).toEqual([]);
        return {
          ok: true,
          status: 200,
          json: async () => ({ imported: 0, skipped: 0, total: 0, errors: [] }),
          text: async () => JSON.stringify({ imported: 0, skipped: 0, total: 0, errors: [] }),
        };
      });
      vi.stubGlobal("fetch", fetchMock);

      await importSessions({ root, apiKey: "lls_test_key", since: "2020-01-01T00:00:00.000Z" });

      expect(detectSpy).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(process.exitCode).toBeUndefined();
      expect(output(logSpy)).toContain("heartbeat ping");
      // Both ghost refs genuinely failed to read — proves byProject ended
      // up empty via the real failure path, not because nothing was found.
      expect(output(warnSpy)).toMatch(/failed to read .*does-not-exist-1\.jsonl/);
      expect(output(warnSpy)).toMatch(/failed to read .*does-not-exist-2\.jsonl/);
    });

    it("marks the run as failed when the empty-batch heartbeat ping itself fails", async () => {
      // 403 throws UploadAuthError immediately (no retry/backoff sleep), so
      // this stays fast — mirrors code-session-upload.test.ts's own
      // no-retry-on-403 coverage.
      const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 403, text: async () => "scoped key" });
      vi.stubGlobal("fetch", fetchMock);

      await importSessions({
        root,
        apiKey: "lls_test_key",
        since: "2027-01-01T00:00:00.000Z",
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(process.exitCode).toBe(1);
      expect(output(errorSpy)).toContain("heartbeat ping failed");
    });
  });

  // Deliverable 3: ~/.membral/sync.json (written by `membral setup`) must be
  // honored here — a project explicitly disabled is skipped, and an
  // unlisted project still syncs by default.
  describe("sync.json allowlist (deliverable 3)", () => {
    it("skips a project marked enabled:false, uploading only the still-enabled one", async () => {
      const syncAllowlistPath = join(root, "sync.json");
      saveSyncAllowlist(
        buildSyncAllowlist(
          [
            {
              harness: "claude-code",
              projectPath: "/home/dev/other-proj",
              displayName: "other-proj",
              sessions: 1,
              lastActiveAt: null,
              importable: true,
            },
          ],
          new Set([1]), // exclude other-proj
        ),
        syncAllowlistPath,
      );

      const fetchMock = serverWith(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as { sessions: Array<{ repo: { path?: string } }> };
        for (const s of body.sessions) {
          expect(s.repo.path).not.toBe("/home/dev/other-proj");
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ imported: body.sessions.length, skipped: 0, total: body.sessions.length, errors: [] }),
          text: async () =>
            JSON.stringify({ imported: body.sessions.length, skipped: 0, total: body.sessions.length, errors: [] }),
        };
      });
      vi.stubGlobal("fetch", fetchMock);

      await importSessions({ root, apiKey: "lls_test_key", syncAllowlistPath });

      expect(uploadCalls(fetchMock)).toHaveLength(1); // only acme-webapp's project batch
      const out = output(logSpy);
      expect(out).toMatch(/TOTAL\s+2\s+2\s+0\s+0\s+0\s+1/); // 1 session counted DISABLED
    });

    it("an unlisted project still syncs by default (new projects auto-sync)", async () => {
      const syncAllowlistPath = join(root, "sync.json");
      saveSyncAllowlist(
        buildSyncAllowlist(
          [
            {
              harness: "claude-code",
              projectPath: "/home/dev/acme-webapp",
              displayName: "acme-webapp",
              sessions: 1,
              lastActiveAt: null,
              importable: true,
            },
          ],
          new Set(), // acme-webapp explicitly enabled; other-proj is unlisted
        ),
        syncAllowlistPath,
      );

      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ imported: 1, skipped: 0, total: 1, errors: [] }),
        text: async () => JSON.stringify({ imported: 1, skipped: 0, total: 1, errors: [] }),
      });
      vi.stubGlobal("fetch", fetchMock);

      await importSessions({ root, apiKey: "lls_test_key", syncAllowlistPath });

      // Both acme-webapp (explicitly enabled) and other-proj (unlisted, defaults on) upload.
      expect(uploadCalls(fetchMock)).toHaveLength(2);
    });

    it("a missing sync.json applies no restrictions at all (backward compatible)", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ imported: 1, skipped: 0, total: 1, errors: [] }),
        text: async () => JSON.stringify({ imported: 1, skipped: 0, total: 1, errors: [] }),
      });
      vi.stubGlobal("fetch", fetchMock);

      await importSessions({ root, apiKey: "lls_test_key", syncAllowlistPath: join(root, "does-not-exist.json") });

      expect(uploadCalls(fetchMock)).toHaveLength(2);
    });

    // 2026-09-12 review, finding 2 (BLOCKER): sync.json's exclusion was
    // gated on `source === "claude-code"` and hard-coded "claude-code" as
    // the harness id passed to isProjectEnabled — so an opencode project a
    // user excluded via the onboarding wizard (harness-scan.ts now lists
    // opencode as importable, so it appears in that prompt) was uploaded
    // anyway. This reproduces the bug directly against `source: "opencode"`.
    it("honors sync.json for opencode too — a project excluded under harnesses.opencode is skipped, not uploaded anyway", async () => {
      const syncAllowlistPath = join(root, "sync.json");
      saveSyncAllowlist(
        buildSyncAllowlist(
          [
            {
              harness: "opencode",
              projectPath: "/home/dev/opencode-excluded",
              displayName: "opencode-excluded",
              sessions: 1,
              lastActiveAt: null,
              importable: true,
            },
          ],
          new Set([1]), // exclude it
        ),
        syncAllowlistPath,
      );

      vi.spyOn(opencodeExport, "discoverOpencodeSessions").mockResolvedValue(
        fakeOpencodeHandle([{ id: "ses_1", directory: "/home/dev/opencode-excluded" }]),
      );

      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      await importSessions({ root, apiKey: "lls_test_key", source: "opencode", syncAllowlistPath });

      // Nothing to upload (the only session found is disabled) — the
      // heartbeat-ping path fires, but never a real session batch.
      const out = output(logSpy);
      expect(out).toMatch(/TOTAL\s+0\s+0\s+0\s+0\s+0\s+1/); // 1 counted DISABLED
    });
  });

  // #143 follow-up: `--root` used to be dropped for every source but
  // claude-code (index.ts only threaded it through when `--source
  // claude-code` was given), so `membral sessions --source opencode --root
  // <dir>` silently fell back to this machine's REAL
  // `~/.local/share/opencode` and could upload real sessions the caller
  // never meant to touch. importSessions() itself has always resolved
  // `opts.root ?? defaultRootFor(source)` correctly (the bug was in
  // index.ts's dispatch, fixed there) — this pins that a custom `root`
  // reaches `discoverOpencodeSessions` verbatim for `source: "opencode"`,
  // never the OS default, so a regression in either place is caught here.
  describe("--root applies to the opencode source too (#143 follow-up)", () => {
    it("passes a custom root straight through to discoverOpencodeSessions, not the real ~/.local/share/opencode default", async () => {
      const customOpencodeRoot = join(root, "fixture-opencode-root");
      const discoverSpy = vi
        .spyOn(opencodeExport, "discoverOpencodeSessions")
        .mockResolvedValue(fakeOpencodeHandle([]));

      // fakeOpencodeHandle([]) means no sessions, so importSessions falls
      // into the empty-batch heartbeat-ping path and calls fetch for real —
      // stub it (as every sibling test does) so this never reaches the
      // network. Unstubbed, this hit the real API host under full-repo
      // parallel load and intermittently exceeded the 5s test timeout.
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ imported: 0, skipped: 0, total: 0, errors: [] }),
        text: async () => JSON.stringify({ imported: 0, skipped: 0, total: 0, errors: [] }),
      });
      vi.stubGlobal("fetch", fetchMock);

      await importSessions({ root: customOpencodeRoot, apiKey: "lls_test_key", source: "opencode" });

      expect(discoverSpy).toHaveBeenCalledTimes(1);
      const rootArgUsed = discoverSpy.mock.calls[0][0];
      expect(rootArgUsed).toBe(customOpencodeRoot);
      expect(rootArgUsed).not.toBe(join(homedir(), ".local", "share", "opencode"));
    });
  });

  // MAJOR 1 (round 2, 2026-07-26): a missing/unreadable session root used
  // to be silently swallowed into `[]` by claudeCodeParser.detect() — making
  // "capture is actually broken" indistinguishable from "healthy, nothing
  // new". detect() now throws SessionRootUnreadableError for that case
  // (packages/core/src/sessions/claude-code.ts); import-sessions.ts must
  // turn that into a loud, non-zero-exit failure that makes NO HTTP calls
  // (not even the heartbeat ping — we don't know capture is working at all).
  // Cursor semantics: this exits 1, so the launchd sweep script's cmd_sweep
  // (success-gated on exit code) does NOT advance last_success_at — the
  // next sweep retries from the same cursor rather than silently drifting
  // forward past a period capture was actually broken.
  describe("session root missing/unreadable (MAJOR 1)", () => {
    it("exits non-zero with a clear message and makes no HTTP calls when the root doesn't exist", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      await importSessions({
        root: join(root, "this-directory-does-not-exist"),
        apiKey: "lls_test_key",
      });

      expect(fetchMock).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
      expect(output(errorSpy)).toContain("not found or unreadable");
    });

    it("exits non-zero even in delta (--since) mode — the ping never fires for a broken root", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      await importSessions({
        root: join(root, "this-directory-does-not-exist"),
        apiKey: "lls_test_key",
        since: "2026-01-01T00:00:00.000Z",
      });

      expect(fetchMock).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    });
  });

  // 2026-09-12 review, finding 5 (SHOULD-FIX): an unreadable/corrupt
  // opencode.db (or a Node runtime with no node:sqlite — finding 1) used to
  // be indistinguishable from "opencode never used on this machine" —
  // logged "No sessions found", fired the success heartbeat, exited 0.
  // Mirrors the claude-code MAJOR-1 branch above exactly.
  describe("opencode database unreadable / node:sqlite unavailable (findings 1 and 5)", () => {
    it("exits non-zero with no HTTP calls (not even the heartbeat) when the opencode database is unreadable", async () => {
      vi.spyOn(opencodeExport, "discoverOpencodeSessions").mockResolvedValue({
        unreadable: true,
        sqliteUnavailable: false,
        sessions: (async function* () {})(),
        skippedCount: () => 0,
      });

      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      await importSessions({ root, apiKey: "lls_test_key", source: "opencode" });

      expect(fetchMock).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
      expect(output(errorSpy)).toContain("unreadable");
    });

    it("exits non-zero with no HTTP calls when this Node has no node:sqlite", async () => {
      vi.spyOn(opencodeExport, "discoverOpencodeSessions").mockResolvedValue({
        unreadable: false,
        sqliteUnavailable: true,
        sessions: (async function* () {})(),
        skippedCount: () => 0,
      });

      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      await importSessions({ root, apiKey: "lls_test_key", source: "opencode" });

      expect(fetchMock).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
      expect(output(errorSpy)).toContain("Node >= 22.5");
    });
  });

  // Minor 2 (round 3, 2026-07-26): a single unreadable PROJECT subdirectory
  // (as opposed to the ROOT itself — MAJOR 1 above) is still swallowed by
  // detect() on purpose, but was previously silent even to import-sessions.
  // detect() now accepts an onWarn callback; wired here to console.warn so
  // it lands in the sweep log alongside every other per-session diagnostic.
  describe("copilot-cli source (W6 D4)", () => {
    // packages/cli/src/__tests__ -> repo root -> fixtures/sessions/copilot-cli
    const FIXTURE_HOME = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "..",
      "..",
      "fixtures",
      "sessions",
      "copilot-cli",
    );

    it("--source copilot-cli --root <home> imports the session-state fixtures", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const r = await importSessions({ root: FIXTURE_HOME, source: "copilot-cli", dryRun: true });
      expect(r.ok).toBe(true);
      expect(r.totalSessions).toBe(3);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(output(logSpy)).toContain("/home/dev/codehub/ledger");
    });

    it("defaults to $COPILOT_HOME when no --root is given", async () => {
      process.env.COPILOT_HOME = FIXTURE_HOME;
      const r = await importSessions({ source: "copilot-cli", dryRun: true });
      expect(r.totalSessions).toBe(3);
      expect(output(logSpy)).toContain(`Scanning ${FIXTURE_HOME} for copilot-cli sessions`);
    });

    it("a missing default Copilot home counts as 'not installed' (ok, exit 0); a missing explicit --root still fails", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      process.env.COPILOT_HOME = join(root, "no-copilot-here");
      const r1 = await importSessions({ source: "copilot-cli", apiKey: "lls_test_key" });
      expect(r1).toEqual({ ok: true, totalImported: 0, totalErrored: 0, totalSessions: 0 });
      expect(process.exitCode).toBeUndefined();
      // Silent skip: machines without Copilot see no new output.
      expect(output(logSpy)).not.toContain("copilot-cli");

      const r2 = await importSessions({ root: join(root, "no-copilot-here"), source: "copilot-cli", apiKey: "k" });
      expect(r2.ok).toBe(false);
      expect(process.exitCode).toBe(1);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("codex source (W9 D3)", () => {
    // packages/cli/src/__tests__ -> repo root -> fixtures/sessions/codex (laid out as a Codex home)
    const FIXTURE_HOME = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "..",
      "..",
      "fixtures",
      "sessions",
      "codex",
    );

    it("--source codex --root <home> imports the rollout fixtures", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const r = await importSessions({ root: FIXTURE_HOME, source: "codex", dryRun: true });
      expect(r.ok).toBe(true);
      expect(r.totalSessions).toBe(1);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(output(logSpy)).toContain("/Users/dev/codehub-api");
    });

    it("defaults to $CODEX_HOME when no --root is given", async () => {
      process.env.CODEX_HOME = FIXTURE_HOME;
      const r = await importSessions({ source: "codex", dryRun: true });
      expect(r.totalSessions).toBe(1);
      expect(output(logSpy)).toContain(`Scanning ${FIXTURE_HOME} for codex sessions`);
    });

    it("a missing default Codex home counts as 'not installed' (ok, silent); a missing explicit --root still fails", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      process.env.CODEX_HOME = join(root, "no-codex-here");
      const r1 = await importSessions({ source: "codex", apiKey: "lls_test_key" });
      expect(r1).toEqual({ ok: true, totalImported: 0, totalErrored: 0, totalSessions: 0 });
      expect(process.exitCode).toBeUndefined();
      expect(output(logSpy)).not.toContain("codex");

      const r2 = await importSessions({ root: join(root, "no-codex-here"), source: "codex", apiKey: "k" });
      expect(r2.ok).toBe(false);
      expect(process.exitCode).toBe(1);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("an explicit --source codex with a missing DEFAULT home stays loud: not ok, exit 1 (F5)", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      process.env.CODEX_HOME = join(root, "typo-codex-home");
      const r = await importSessions({ source: "codex", explicitSource: true, apiKey: "lls_test_key" });
      expect(r.ok).toBe(false);
      expect(process.exitCode).toBe(1);
      expect(output(logSpy)).toContain(`Scanning ${join(root, "typo-codex-home")} for codex sessions`);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("onWarn diagnostics for an unreadable project subdirectory (Minor 2)", () => {
    it("surfaces a console.warn naming the skipped directory, while still processing the readable ones", async () => {
      if (typeof process.getuid === "function" && process.getuid() === 0) {
        // Running as root — chmod 000 doesn't block reads; skip rather than false-fail.
        return;
      }
      const diagRoot = await mkdtemp(join(tmpdir(), "membral-import-sessions-diag-"));
      const badDir = join(diagRoot, "bad-project");
      try {
        const goodDir = join(diagRoot, "good-project");
        await mkdir(goodDir, { recursive: true });
        await mkdir(badDir, { recursive: true });
        await writeFile(
          join(goodDir, "session.jsonl"),
          sessionLine("/home/dev/good-project", "2026-02-01T00:00:00.000Z"),
        );
        await chmod(badDir, 0o000);

        const fetchMock = vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => ({ imported: 1, skipped: 0, total: 1, errors: [] }),
          text: async () => JSON.stringify({ imported: 1, skipped: 0, total: 1, errors: [] }),
        });
        vi.stubGlobal("fetch", fetchMock);

        await importSessions({ root: diagRoot, apiKey: "lls_test_key" });

        expect(uploadCalls(fetchMock)).toHaveLength(1);
        expect(output(warnSpy)).toContain("bad-project");
        expect(output(logSpy)).toContain("Ready to import 1 session(s) (incl. sub-agents) across 1 project(s).");
      } finally {
        await chmod(badDir, 0o755).catch(() => {});
        await rm(diagRoot, { recursive: true, force: true });
      }
    });
  });
});

// 2026-09-12 review, finding 12 (NIT): index.ts's `sessions` command loops
// `importSessions()` once per harness; without dedup that means two
// empty-batch heartbeat pings on an idle machine. The fix moves the actual
// ping into this standalone exported function so index.ts can call it
// exactly once, after confirming every source came back with zero sessions
// (see index.ts's `sessions` case and import-sessions.ts's `heartbeat:
// false` option). Covered here directly rather than via a subprocess-level
// index.ts integration test, proportionate to a NIT-severity finding.
describe("sendHeartbeatPing (finding 12)", () => {
  const originalEnv = { ...process.env };
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "membral-heartbeat-"));
    process.env.HOME = root;
    // This machine's real shell environment sets MEMBRAL_API_KEY (a known
    // test-isolation gotcha in this repo) — clear it so "no API key" tests
    // don't accidentally pick up a real key and hit the network.
    delete process.env.MEMBRAL_API_KEY;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  it("sends exactly one empty-batch request and returns true on success", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ imported: 0, skipped: 0, total: 0, errors: [] }),
      text: async () => JSON.stringify({ imported: 0, skipped: 0, total: 0, errors: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const ok = await sendHeartbeatPing({ apiKey: "lls_test_key", apiUrl: "https://cloud.example.com" });

    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.sessions).toEqual([]);
  });

  it("returns true without any network call when there's no API key (nothing to ping)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const ok = await sendHeartbeatPing({});

    expect(ok).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns false and logs on failure (403, no retry)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 403, text: async () => "scoped key" });
    vi.stubGlobal("fetch", fetchMock);
    const logError = vi.fn();

    const ok = await sendHeartbeatPing(
      { apiKey: "lls_test_key", apiUrl: "https://cloud.example.com" },
      undefined,
      logError,
    );

    expect(ok).toBe(false);
    expect(logError).toHaveBeenCalled();
  });
});

describe("importSessions — skips sessions the server already has (POST /api/code-sessions/known)", () => {
  let dir: string;
  let root: string;
  let logSpy: ReturnType<typeof vi.fn>;
  let warnSpy: ReturnType<typeof vi.fn>;
  const originalEnv = { ...process.env };

  function output(spy: ReturnType<typeof vi.fn>): string {
    return spy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
  }

  type Probe = { source: string; source_session_id: string; turn_count: number; ended_at: string | null };

  /**
   * A fake server: `stored` maps source_session_id -> the (turn_count,
   * ended_at) it holds. /known answers with the indexes whose probe matches;
   * /api/code-sessions records what was uploaded.
   */
  function fakeServer(
    stored: Map<string, { turn_count: number; ended_at: string }>,
    knownResponse?: () => { ok: boolean; status: number; json: () => Promise<unknown> },
  ) {
    const uploaded: string[] = [];
    const probes: Probe[][] = [];
    const fetchMock = vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      if (url.endsWith("/api/code-sessions/known")) {
        probes.push(body.sessions);
        if (knownResponse) return knownResponse();
        const known = (body.sessions as Probe[]).flatMap((p, i) => {
          const row = stored.get(p.source_session_id);
          return row && row.turn_count === p.turn_count && row.ended_at === p.ended_at ? [i] : [];
        });
        return { ok: true, status: 200, json: async () => ({ known }), text: async () => JSON.stringify({ known }) };
      }
      for (const s of body.sessions as { sourceSessionId: string }[]) uploaded.push(s.sourceSessionId);
      const n = body.sessions.length;
      return {
        ok: true,
        status: 200,
        json: async () => ({ imported: n, skipped: 0, total: n, errors: [] }),
        text: async () => JSON.stringify({ imported: n, skipped: 0, total: n, errors: [] }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);
    return { fetchMock, uploaded, probes };
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "membral-known-sessions-"));
    root = join(dir, "projects");
    await mkdir(join(root, "sessions"), { recursive: true });
    await writeFile(join(root, "sessions", "s1.jsonl"), sessionLine("/home/dev/one-proj", "2026-02-01T00:00:00.000Z"));
    await writeFile(join(root, "sessions", "s2.jsonl"), sessionLine("/home/dev/one-proj", "2026-02-02T00:00:00.000Z"));
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.HOME = dir;
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
    process.exitCode = undefined;
  });

  const opts = () => ({ root, apiKey: "lls_test", apiUrl: "https://cloud.example.com" });

  it("probes with the payload's turn count and endedAt, skips the known session, uploads the unknown one", async () => {
    const stored = new Map([["s1", { turn_count: 1, ended_at: "2026-02-01T00:00:00.000Z" }]]);
    const { uploaded, probes } = fakeServer(stored);

    await importSessions(opts());

    expect(probes).toHaveLength(1);
    expect(probes[0]).toEqual(
      expect.arrayContaining([
        {
          source: "claude-code",
          source_session_id: "s1",
          turn_count: 1,
          ended_at: "2026-02-01T00:00:00.000Z",
          // Issue #171: the parser's version rides on every probe.
          actions_version: FORGE_ACTIONS_VERSION,
        },
      ]),
    );
    expect(uploaded).toEqual(["s2"]);
    expect(output(logSpy)).toContain("Skipped 1 unchanged (already uploaded).");
  });

  it("re-uploads a session that grew since the server stored it", async () => {
    await writeFile(
      join(root, "sessions", "s1.jsonl"),
      [
        sessionLine("/home/dev/one-proj", "2026-02-01T00:00:00.000Z"),
        sessionLine("/home/dev/one-proj", "2026-02-01T00:10:00.000Z", "one more turn"),
      ].join("\n"),
    );
    const stored = new Map([
      ["s1", { turn_count: 1, ended_at: "2026-02-01T00:00:00.000Z" }],
      ["s2", { turn_count: 1, ended_at: "2026-02-02T00:00:00.000Z" }],
    ]);
    const { uploaded } = fakeServer(stored);

    await importSessions(opts());

    expect(uploaded).toEqual(["s1"]);
    expect(output(logSpy)).toContain("Skipped 1 unchanged (already uploaded).");
  });

  it("when everything is known, uploads nothing and only sends the heartbeat ping", async () => {
    const stored = new Map([
      ["s1", { turn_count: 1, ended_at: "2026-02-01T00:00:00.000Z" }],
      ["s2", { turn_count: 1, ended_at: "2026-02-02T00:00:00.000Z" }],
    ]);
    const { fetchMock, uploaded } = fakeServer(stored);

    await importSessions(opts());

    expect(uploaded).toEqual([]);
    // /known once, then the empty-batch heartbeat.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(output(logSpy)).toContain("Skipped 2 unchanged (already uploaded).");
  });

  it.each([
    [
      "404 from a server without the endpoint",
      () => ({ ok: false, status: 404, json: async () => ({}), text: async () => JSON.stringify({}) }),
    ],
    ["500", () => ({ ok: false, status: 500, json: async () => ({}), text: async () => JSON.stringify({}) })],
    [
      "a body without a known list",
      () => ({
        ok: true,
        status: 200,
        json: async () => ({ imported: 0 }),
        text: async () => JSON.stringify({ imported: 0 }),
      }),
    ],
  ])("falls back to uploading everything on %s, warning once", async (_label, knownResponse) => {
    const stored = new Map([["s1", { turn_count: 1, ended_at: "2026-02-01T00:00:00.000Z" }]]);
    const { uploaded } = fakeServer(stored, knownResponse);

    await importSessions(opts());

    expect(uploaded.sort()).toEqual(["s1", "s2"]);
    const warnings = warnSpy.mock.calls.filter((c: unknown[]) => String(c[0]).includes("already uploaded"));
    expect(warnings).toHaveLength(1);
    expect(process.exitCode).toBeUndefined();
  });

  it("falls back to uploading everything on a network error", async () => {
    const uploaded: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
        if (url.endsWith("/known")) throw new TypeError("fetch failed");
        const body = JSON.parse(init.body as string);
        for (const s of body.sessions as { sourceSessionId: string }[]) uploaded.push(s.sourceSessionId);
        const n = body.sessions.length;
        return {
          ok: true,
          status: 200,
          json: async () => ({ imported: n, skipped: 0, total: n, errors: [] }),
          text: async () => JSON.stringify({ imported: n, skipped: 0, total: n, errors: [] }),
        };
      }),
    );

    await importSessions(opts());

    expect(uploaded.sort()).toEqual(["s1", "s2"]);
    expect(output(warnSpy)).toContain("Could not check which sessions are already uploaded");
  });

  it("probes sub-agent child sessions too, skipping a known child while its grown parent uploads", async () => {
    const subDir = join(root, "sessions", "s2", "subagents");
    await mkdir(subDir, { recursive: true });
    await writeFile(join(subDir, "agent-a1.meta.json"), JSON.stringify({ agentType: "Explore", toolUseId: "toolu_1" }));
    await writeFile(
      join(subDir, "agent-a1.jsonl"),
      `${JSON.stringify({
        type: "user",
        isSidechain: true,
        message: { role: "user", content: "explore the repo" },
        timestamp: "2026-02-02T00:01:00.000Z",
      })}\n`,
    );
    const stored = new Map([
      ["s1", { turn_count: 1, ended_at: "2026-02-01T00:00:00.000Z" }],
      ["s2:agent-a1", { turn_count: 1, ended_at: "2026-02-02T00:01:00.000Z" }],
    ]);
    const { uploaded, probes } = fakeServer(stored);

    await importSessions(opts());

    expect(probes[0].map((p) => p.source_session_id).sort()).toEqual(["s1", "s2", "s2:agent-a1"]);
    expect(uploaded).toEqual(["s2"]);
    expect(output(logSpy)).toContain("Skipped 2 unchanged (already uploaded).");
  });

  it("--full skips the check and re-uploads every session", async () => {
    const stored = new Map([
      ["s1", { turn_count: 1, ended_at: "2026-02-01T00:00:00.000Z" }],
      ["s2", { turn_count: 1, ended_at: "2026-02-02T00:00:00.000Z" }],
    ]);
    const { uploaded, probes } = fakeServer(stored);

    await importSessions({ ...opts(), full: true });

    expect(probes).toHaveLength(0);
    expect(uploaded.sort()).toEqual(["s1", "s2"]);
  });

  it("--force implies --full: skips the check and re-uploads unchanged sessions too (F-005/#171)", async () => {
    const stored = new Map([
      ["s1", { turn_count: 1, ended_at: "2026-02-01T00:00:00.000Z" }],
      ["s2", { turn_count: 1, ended_at: "2026-02-02T00:00:00.000Z" }],
    ]);
    const { uploaded, probes, fetchMock } = fakeServer(stored);

    await importSessions({ ...opts(), force: true });

    expect(probes).toHaveLength(0);
    expect(uploaded.sort()).toEqual(["s1", "s2"]);
    expect(output(logSpy)).toContain("--force implies --full: skipping the already-uploaded check.");
    const uploadBodies = fetchMock.mock.calls
      .filter((c: unknown[]) => !String(c[0]).endsWith("/known"))
      .map((c: unknown[]) => JSON.parse((c[1] as RequestInit).body as string));
    expect(uploadBodies.every((b: { force?: boolean }) => b.force === true)).toBe(true);
  });

  it("dry-run never calls the check", async () => {
    const { fetchMock } = fakeServer(new Map());
    await importSessions({ ...opts(), dryRun: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
