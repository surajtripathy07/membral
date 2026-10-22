import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultCredentialsPath, deleteCredentials, saveCredentials } from "../credentials.js";
import { importSession } from "../import-session.js";
import { envKeyMarkerPath } from "../lib/api-client.js";
import { buildSyncAllowlist, saveSyncAllowlist } from "../sync-allowlist.js";

function sessionLine(cwd: string, timestamp: string) {
  return JSON.stringify({
    type: "user",
    message: { role: "user", content: "hello" },
    cwd,
    gitBranch: "main",
    timestamp,
  });
}

// The hook contract (ADR 0021 P1b) is non-negotiable: import-session must
// NEVER throw or set a non-zero exit code, no matter what fails. Every test
// here asserts that on top of the specific behavior.
describe("importSession", () => {
  let root: string;
  let errorSpy: ReturnType<typeof vi.fn>;
  const originalEnv = { ...process.env };
  const originalExitCode = process.exitCode;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "membral-import-session-"));
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // Issue #136 test-isolation gotcha: resolveUploadConfig ultimately falls
    // back to ~/.membral/credentials.json (credentials.ts's
    // defaultCredentialsPath -> os.homedir()) when no flag/env key is
    // given — on a machine that has actually run `membral login`, that's a
    // REAL file with a REAL key, and this suite's "no API key configured"
    // tests would otherwise silently pick it up and hit the real API.
    // os.homedir() reads $HOME live, so pointing it at an empty temp dir
    // isolates every test here from whatever machine it runs on.
    process.env.HOME = root;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
    process.exitCode = originalExitCode;
  });

  function warnings(): string {
    return errorSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
  }

  it("never throws and warns to stderr when --transcript is missing", async () => {
    await expect(importSession({})).resolves.toBeUndefined();
    expect(warnings()).toContain("missing --transcript");
    expect(process.exitCode).toBeUndefined();
  });

  it("never throws and warns to stderr when the transcript file doesn't exist", async () => {
    await expect(importSession({ transcript: join(root, "nope.jsonl"), apiKey: "lls_x" })).resolves.toBeUndefined();
    expect(warnings()).toContain("failed to read transcript");
    expect(process.exitCode).toBeUndefined();
  });

  it("warns and skips (no throw, no upload) when no API key is configured", async () => {
    delete process.env.MEMBRAL_API_KEY;
    const transcript = join(root, "session.jsonl");
    await writeFile(transcript, sessionLine("/home/dev/acme-webapp", "2026-01-01T00:00:00.000Z"));

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(importSession({ transcript })).resolves.toBeUndefined();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(warnings()).toContain("missing API key");
    expect(process.exitCode).toBeUndefined();
  });

  it("parses, resolves the repo, and uploads exactly one session on success", async () => {
    const transcript = join(root, "22222222-2222-4222-8222-222222222222.jsonl");
    await writeFile(transcript, sessionLine("/home/dev/acme-webapp", "2026-01-01T00:00:00.000Z"));

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ imported: 1, skipped: 0, total: 1, errors: [] }),
      text: async () => JSON.stringify({ imported: 1, skipped: 0, total: 1, errors: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await importSession({ transcript, apiKey: "lls_test_key", apiUrl: "https://cloud.example.com" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://cloud.example.com/api/code-sessions");
    const body = JSON.parse(init.body as string) as { sessions: Array<{ sourceSessionId: string }> };
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0].sourceSessionId).toBe("22222222-2222-4222-8222-222222222222");
    expect(process.exitCode).toBeUndefined();
  });

  it("skips upload (no throw) for a project disabled in ~/.membral/sync.json", async () => {
    const transcript = join(root, "session.jsonl");
    await writeFile(transcript, sessionLine("/home/dev/acme-webapp", "2026-01-01T00:00:00.000Z"));

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
        new Set([1]),
      ),
      syncAllowlistPath,
    );

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(importSession({ transcript, apiKey: "lls_test_key", syncAllowlistPath })).resolves.toBeUndefined();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(warnings()).toContain("disabled in ~/.membral/sync.json");
    expect(process.exitCode).toBeUndefined();
  });

  it("still uploads an unlisted project (new projects auto-sync by default)", async () => {
    const transcript = join(root, "session.jsonl");
    await writeFile(transcript, sessionLine("/home/dev/acme-webapp", "2026-01-01T00:00:00.000Z"));

    const syncAllowlistPath = join(root, "sync.json");
    saveSyncAllowlist(
      buildSyncAllowlist(
        [
          {
            harness: "claude-code",
            projectPath: "/home/dev/some-other-project",
            displayName: "other",
            sessions: 1,
            lastActiveAt: null,
            importable: true,
          },
        ],
        new Set(),
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

    await importSession({ transcript, apiKey: "lls_test_key", syncAllowlistPath });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // M4 (adversarial round 1 on #136): a stale MEMBRAL_API_KEY must not
  // shadow a valid ~/.membral/credentials.json key for the SessionEnd
  // hook's upload — this is the "sync" leg #136's title named but the
  // original fix never touched.
  it("M4: a stale env key that 401s retries once with a working credentials.json key instead", async () => {
    // NOTE: write to defaultCredentialsPath() (the SAME path the upload client's
    // loadCredentials(undefined) resolves internally), not to `root` — a
    // Node/vitest-worker quirk observed here means node:os's homedir() can
    // return a value cached from the FIRST test in this file to call it,
    // not necessarily this test's own freshly-set $HOME. Explicitly cleaned
    // up below so it can't leak into a later test's "no credentials.json"
    // assumption.
    const credsPath = defaultCredentialsPath();
    saveCredentials(
      { apiUrl: "https://cloud.example.com", apiKey: "lls_from_creds", email: "e", userId: "i", createdAt: "c" },
      credsPath,
    );
    try {
      process.env.MEMBRAL_API_KEY = "lls_stale_env";
      const transcript = join(root, "session.jsonl");
      await writeFile(transcript, sessionLine("/home/dev/acme-webapp", "2026-01-01T00:00:00.000Z"));

      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 401, text: async () => "" })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ imported: 1, skipped: 0, total: 1, errors: [] }),
          text: async () => JSON.stringify({ imported: 1, skipped: 0, total: 1, errors: [] }),
        });
      vi.stubGlobal("fetch", fetchMock);

      await importSession({ transcript, apiUrl: "https://cloud.example.com" });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const [, firstInit] = fetchMock.mock.calls[0] as [string, RequestInit];
      const [, secondInit] = fetchMock.mock.calls[1] as [string, RequestInit];
      expect((firstInit.headers as Record<string, string>).authorization).toBe("Bearer lls_stale_env");
      expect((secondInit.headers as Record<string, string>).authorization).toBe("Bearer lls_from_creds");
      // The fallback now runs inside the shared upload client (R4 4.3 site 1), with its own line.
      expect(warnings()).toContain(
        "MEMBRAL_API_KEY was rejected by https://cloud.example.com (401); retrying with the key from",
      );
      expect(process.exitCode).toBeUndefined();
    } finally {
      deleteCredentials(credsPath);
      // The upload client leaves an env-key-rejected marker beside credentials.json after the fallback worked.
      await rm(envKeyMarkerPath(dirname(credsPath), "lls_stale_env", "https://cloud.example.com"), { force: true });
    }
  });

  it("M4: does NOT retry when the env key 401s and credentials.json has no different key", async () => {
    process.env.MEMBRAL_API_KEY = "lls_stale_env";
    const transcript = join(root, "session.jsonl");
    await writeFile(transcript, sessionLine("/home/dev/acme-webapp", "2026-01-01T00:00:00.000Z"));

    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 401, text: async () => "" });
    vi.stubGlobal("fetch", fetchMock);

    await importSession({ transcript });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(warnings()).toContain("upload failed");
  });

  it("never throws and warns to stderr when the upload fails outright (e.g. scoped key)", async () => {
    const transcript = join(root, "session.jsonl");
    await writeFile(transcript, sessionLine("/home/dev/acme-webapp", "2026-01-01T00:00:00.000Z"));

    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 403, text: async () => "" });
    vi.stubGlobal("fetch", fetchMock);

    await expect(importSession({ transcript, apiKey: "lls_scoped_key" })).resolves.toEqual({
      total: 0,
      uploaded: 0,
      failed: 0,
      deferred: 0,
    });

    expect(warnings()).toContain("upload failed");
    expect(process.exitCode).toBeUndefined();
  });

  it("under a deadline (the SessionEnd hook), a 429 whose Retry-After passes it defers to the sweep instead of waiting", async () => {
    const transcript = join(root, "session.jsonl");
    await writeFile(transcript, sessionLine("/home/dev/acme-webapp", "2026-01-01T00:00:00.000Z"));

    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      headers: new Headers({ "Retry-After": "45" }),
      text: async () => "",
    });
    vi.stubGlobal("fetch", fetchMock);

    const started = Date.now();
    await importSession({ transcript, apiKey: "lls_key", childDeadlineAt: Date.now() + 20_000 });

    expect(Date.now() - started).toBeLessThan(5_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(warnings()).toContain("upload deferred");
    expect(warnings()).toContain("left for the sweep");
    expect(process.exitCode).toBeUndefined();
  });

  // R4 4.3 site 1, design note §4: startBy (childDeadlineAt) stops NEW work; an
  // in-flight upload is only cut at abortAt (uploadAbortAt).
  function slowOk(ms: number) {
    const body = { imported: 1, skipped: 0, total: 1, errors: [] };
    return vi.fn(
      (_u: string, init: RequestInit) =>
        new Promise((resolve, reject) => {
          const t = setTimeout(
            () => resolve({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }),
            ms,
          );
          init.signal?.addEventListener("abort", () => {
            clearTimeout(t);
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );
  }

  it("an upload still in flight past childDeadlineAt finishes when it answers before uploadAbortAt", async () => {
    const transcript = join(root, "session.jsonl");
    await writeFile(transcript, sessionLine("/home/dev/acme-webapp", "2026-01-01T00:00:00.000Z"));
    const fetchMock = slowOk(150);
    vi.stubGlobal("fetch", fetchMock);

    const now = Date.now();
    await importSession({ transcript, apiKey: "lls_key", childDeadlineAt: now + 50, uploadAbortAt: now + 1_000 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(warnings()).toBe("");
  });

  it("an upload still in flight at uploadAbortAt is cut and deferred to the sweep", async () => {
    const transcript = join(root, "session.jsonl");
    await writeFile(transcript, sessionLine("/home/dev/acme-webapp", "2026-01-01T00:00:00.000Z"));
    const fetchMock = slowOk(5_000);
    vi.stubGlobal("fetch", fetchMock);

    const now = Date.now();
    await importSession({ transcript, apiKey: "lls_key", childDeadlineAt: now + 50, uploadAbortAt: now + 200 });

    expect(Date.now() - now).toBeLessThan(2_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(warnings()).toContain("upload deferred");
  });

  it("the parent is sent even when childDeadlineAt has already passed (the child budget never skips it)", async () => {
    const transcript = join(root, "session.jsonl");
    await writeFile(transcript, sessionLine("/home/dev/acme-webapp", "2026-01-01T00:00:00.000Z"));
    const fetchMock = slowOk(10);
    vi.stubGlobal("fetch", fetchMock);

    const now = Date.now();
    await importSession({ transcript, apiKey: "lls_key", childDeadlineAt: now - 1, uploadAbortAt: now + 1_000 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
