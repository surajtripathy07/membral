// scanHarnesses — real filesystem reads against a temp-dir fixture (per the
// task brief: "Tests with a temp-dir fixture"). git-remote.ts is left real
// (not mocked) — the fixture's cwds don't exist on disk, so resolveGitRemote
// naturally returns undefined without needing a mock.
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanHarnesses } from "../harness-scan.js";

/** Minimal real opencode.db fixture — only the columns scanHarnesses reads (goal 2026-09-12 W6/D5). */
function writeOpencodeDb(
  dbPath: string,
  rows: { id: string; parentId: string | null; directory: string; timeUpdated: number }[],
) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      parent_id TEXT,
      directory TEXT NOT NULL,
      time_updated INTEGER NOT NULL
    );
  `);
  const insert = db.prepare("INSERT INTO session (id, parent_id, directory, time_updated) VALUES (?, ?, ?, ?)");
  for (const row of rows) {
    insert.run(row.id, row.parentId, row.directory, row.timeUpdated);
  }
  db.close();
}

describe("scanHarnesses", () => {
  let root: string;
  let claudeCodeRoot: string;
  let codexRoot: string;
  let opencodeRoot: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "membral-harness-"));
    claudeCodeRoot = join(root, "claude-projects");
    codexRoot = join(root, "codex-sessions");
    opencodeRoot = join(root, "opencode");
    mkdirSync(claudeCodeRoot, { recursive: true });
    mkdirSync(codexRoot, { recursive: true });
    mkdirSync(opencodeRoot, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns nothing for roots that don't exist", async () => {
    rmSync(claudeCodeRoot, { recursive: true, force: true });
    rmSync(codexRoot, { recursive: true, force: true });
    rmSync(opencodeRoot, { recursive: true, force: true });

    const result = await scanHarnesses({
      claudeCodeRoot,
      codexRoot,
      opencodeRoot,
      copilotHome: join(root, "no-copilot"),
    });
    expect(result).toEqual([]);
  });

  it("reads the real cwd out of a Claude Code project's transcript, sessions count, and mtime", async () => {
    const projectDir = join(claudeCodeRoot, "-Users-dev-example-app");
    mkdirSync(projectDir, { recursive: true });
    const event = JSON.stringify({
      type: "user",
      cwd: "/Users/dev/example-app",
      timestamp: "2026-01-01T00:00:00Z",
    });
    writeFileSync(join(projectDir, "session-1.jsonl"), `${event}\n`);
    writeFileSync(join(projectDir, "session-2.jsonl"), `${event}\n`);

    const result = await scanHarnesses({ claudeCodeRoot, codexRoot, opencodeRoot });
    const project = result.find((p) => p.harness === "claude-code");

    expect(project).toBeDefined();
    expect(project?.projectPath).toBe("/Users/dev/example-app");
    expect(project?.displayName).toBe("example-app");
    expect(project?.sessions).toBe(2);
    expect(project?.importable).toBe(true);
  });

  it("falls back to a lossy directory-name decode when no session has a readable cwd", async () => {
    const projectDir = join(claudeCodeRoot, "-Users-dev-noop");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "session-1.jsonl"), "not json at all\n");

    const result = await scanHarnesses({ claudeCodeRoot, codexRoot, opencodeRoot });
    const project = result.find((p) => p.harness === "claude-code");

    expect(project?.projectPath).toBe("/Users/dev/noop");
    expect(project?.sessions).toBe(1);
  });

  it("uses the latest mtime among a project's session files", async () => {
    const projectDir = join(claudeCodeRoot, "-Users-dev-app");
    mkdirSync(projectDir, { recursive: true });
    const event = JSON.stringify({ cwd: "/Users/dev/app" });
    writeFileSync(join(projectDir, "old.jsonl"), `${event}\n`);
    writeFileSync(join(projectDir, "new.jsonl"), `${event}\n`);

    const old = new Date("2020-01-01T00:00:00Z");
    const newer = new Date("2026-06-01T00:00:00Z");
    utimesSync(join(projectDir, "old.jsonl"), old, old);
    utimesSync(join(projectDir, "new.jsonl"), newer, newer);

    const result = await scanHarnesses({ claudeCodeRoot, codexRoot, opencodeRoot });
    const project = result.find((p) => p.harness === "claude-code");
    expect(project?.lastActiveAt).toBe(newer.toISOString());
  });

  it("ignores a project directory with no .jsonl files", async () => {
    mkdirSync(join(claudeCodeRoot, "-Users-dev-empty"), { recursive: true });
    const result = await scanHarnesses({ claudeCodeRoot, codexRoot, opencodeRoot });
    expect(result.filter((p) => p.harness === "claude-code")).toEqual([]);
  });

  it("marks codex sessions as importable, grouped by cwd when the file exposes one", async () => {
    const day = join(codexRoot, "2026", "01", "01");
    mkdirSync(day, { recursive: true });
    writeFileSync(join(day, "rollout-1.jsonl"), `${JSON.stringify({ cwd: "/Users/dev/codex-project" })}\n`);
    writeFileSync(join(day, "rollout-2.jsonl"), `${JSON.stringify({ cwd: "/Users/dev/codex-project" })}\n`);

    const result = await scanHarnesses({ claudeCodeRoot, codexRoot, opencodeRoot });
    const project = result.find((p) => p.harness === "codex");

    expect(project).toBeDefined();
    expect(project?.projectPath).toBe("/Users/dev/codex-project");
    expect(project?.sessions).toBe(2);
    expect(project?.importable).toBe(true);
  });

  it("groups a codex file with no discoverable cwd as its own singleton project", async () => {
    writeFileSync(join(codexRoot, "orphan.jsonl"), "not json\n");
    const result = await scanHarnesses({ claudeCodeRoot, codexRoot, opencodeRoot });
    const project = result.find((p) => p.harness === "codex");
    expect(project?.sessions).toBe(1);
    expect(project?.importable).toBe(true);
  });

  it("groups codex rollouts by session_meta.payload.cwd", async () => {
    const day = join(codexRoot, "2026", "05", "14");
    mkdirSync(day, { recursive: true });
    const meta = JSON.stringify({
      timestamp: "t",
      type: "session_meta",
      payload: { id: "x", cwd: "/Users/dev/codehub-api" },
    });
    writeFileSync(join(day, "rollout-a.jsonl"), `${meta}\n`);
    writeFileSync(join(day, "rollout-b.jsonl"), `${meta}\n`);
    const result = await scanHarnesses({ claudeCodeRoot, codexRoot, opencodeRoot });
    const project = result.find((p) => p.harness === "codex");
    expect(project?.projectPath).toBe("/Users/dev/codehub-api");
    expect(project?.sessions).toBe(2);
  });

  it("ignores non-json/jsonl files and skips VCS-internal directories (e.g. a harness's own bare-git snapshot storage)", async () => {
    // Mirrors a real opencode layout observed in practice: a per-session
    // bare git repo under storage/snapshot/<hash>/<hash2>/ whose extension-
    // less HEAD/config/refs files (and an objects/ subtree) must not each
    // become their own bogus "project".
    const snapshotRepo = join(opencodeRoot, "storage", "snapshot", "abc123", "def456");
    mkdirSync(join(snapshotRepo, "objects"), { recursive: true });
    writeFileSync(join(snapshotRepo, "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(snapshotRepo, "config"), "[core]\n");
    writeFileSync(join(snapshotRepo, "objects", "pack-abc.pack"), "binary");
    writeFileSync(join(opencodeRoot, "account.json"), JSON.stringify({ ok: true }));

    const result = await scanHarnesses({ claudeCodeRoot, codexRoot, opencodeRoot });
    const opencodeProjects = result.filter((p) => p.harness === "opencode");

    expect(opencodeProjects).toHaveLength(1);
    expect(opencodeProjects[0].projectPath).toContain("account.json");
  });

  it("detects opencode sessions from a whole-JSON-document file (workdir field)", async () => {
    const sessionDir = join(opencodeRoot, "storage", "session");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "abc.json"), JSON.stringify({ workdir: "/Users/dev/opencode-project" }));

    const result = await scanHarnesses({ claudeCodeRoot, codexRoot, opencodeRoot });
    const project = result.find((p) => p.harness === "opencode");

    expect(project?.projectPath).toBe("/Users/dev/opencode-project");
    expect(project?.importable).toBe(false);
  });

  it("prefers opencode.db (SQLite) over the generic file walk when it exists, and marks it importable", async () => {
    // Also drop a stray storage/session JSON file to confirm the SQLite path
    // wins outright rather than merging with the generic walk's results.
    const sessionDir = join(opencodeRoot, "storage", "session");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "stray.json"), JSON.stringify({ workdir: "/Users/dev/should-not-appear" }));

    writeOpencodeDb(join(opencodeRoot, "opencode.db"), [
      { id: "ses_1", parentId: null, directory: "/Users/dev/codehub", timeUpdated: 1_700_000_000_000 },
      { id: "ses_2", parentId: null, directory: "/Users/dev/codehub", timeUpdated: 1_700_000_500_000 },
      { id: "ses_3", parentId: null, directory: "/Users/dev/other-proj", timeUpdated: 1_700_000_100_000 },
      // A sub-agent session (parent_id set) must not be counted as its own project.
      { id: "ses_1_sub", parentId: "ses_1", directory: "/Users/dev/codehub", timeUpdated: 1_700_000_200_000 },
    ]);

    const result = await scanHarnesses({ claudeCodeRoot, codexRoot, opencodeRoot });
    const opencodeProjects = result.filter((p) => p.harness === "opencode");

    expect(opencodeProjects).toHaveLength(2);
    expect(opencodeProjects.every((p) => p.importable)).toBe(true);
    expect(opencodeProjects.find((p) => p.projectPath === "/Users/dev/should-not-appear")).toBeUndefined();

    const codehub = opencodeProjects.find((p) => p.projectPath === "/Users/dev/codehub");
    expect(codehub?.sessions).toBe(2);
    expect(codehub?.lastActiveAt).toBe(new Date(1_700_000_500_000).toISOString());

    const other = opencodeProjects.find((p) => p.projectPath === "/Users/dev/other-proj");
    expect(other?.sessions).toBe(1);
  });

  it("falls back to the generic file walk when opencode.db is present but corrupt", async () => {
    writeFileSync(join(opencodeRoot, "opencode.db"), "not a sqlite file");
    const sessionDir = join(opencodeRoot, "storage", "session");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "abc.json"), JSON.stringify({ workdir: "/Users/dev/opencode-project" }));

    const result = await scanHarnesses({ claudeCodeRoot, codexRoot, opencodeRoot });
    const project = result.find((p) => p.harness === "opencode");

    expect(project?.projectPath).toBe("/Users/dev/opencode-project");
    expect(project?.importable).toBe(false);
  });
});
