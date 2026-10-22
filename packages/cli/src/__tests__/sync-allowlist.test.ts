import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HarnessProject } from "../harness-scan.js";
import {
  buildSyncAllowlist,
  emptySyncAllowlist,
  hasNewProjects,
  isProjectEnabled,
  loadSyncAllowlist,
  saveSyncAllowlist,
  validateSyncAllowlist,
} from "../sync-allowlist.js";

function project(overrides: Partial<HarnessProject> = {}): HarnessProject {
  return {
    harness: "claude-code",
    projectPath: "/home/dev/app",
    displayName: "app",
    sessions: 1,
    lastActiveAt: null,
    importable: true,
    ...overrides,
  };
}

describe("sync-allowlist", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "membral-sync-"));
    path = join(dir, "sync.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("loadSyncAllowlist returns null when the file is missing", () => {
    expect(loadSyncAllowlist(path)).toBeNull();
  });

  it("loadSyncAllowlist returns null for corrupt JSON", () => {
    writeFileSync(path, "not json");
    expect(loadSyncAllowlist(path)).toBeNull();
  });

  it("round-trips save/load", () => {
    const allowlist = buildSyncAllowlist([project()], new Set());
    saveSyncAllowlist(allowlist, path);
    expect(loadSyncAllowlist(path)).toEqual(allowlist);
  });

  it("validateSyncAllowlist drops malformed project entries but keeps well-formed ones", () => {
    const result = validateSyncAllowlist({
      harnesses: {
        "claude-code": { projects: [{ path: "/a", enabled: true }, { path: "/b" }, "garbage"] },
      },
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(result?.harnesses["claude-code"]?.projects).toEqual([{ path: "/a", enabled: true }]);
  });

  it("validateSyncAllowlist returns null for a non-object or missing harnesses", () => {
    expect(validateSyncAllowlist(null)).toBeNull();
    expect(validateSyncAllowlist("nope")).toBeNull();
    expect(validateSyncAllowlist({})).toBeNull();
  });

  describe("isProjectEnabled", () => {
    it("returns true (no restrictions) for a null allowlist", () => {
      expect(isProjectEnabled(null, "claude-code", "/anything")).toBe(true);
    });

    it("returns the explicit enabled value for a listed project", () => {
      const allowlist = buildSyncAllowlist(
        [project({ projectPath: "/a" }), project({ projectPath: "/b" })],
        new Set([2]),
      );
      expect(isProjectEnabled(allowlist, "claude-code", "/a")).toBe(true);
      expect(isProjectEnabled(allowlist, "claude-code", "/b")).toBe(false);
    });

    it("defaults an unlisted project to enabled unless defaultNewProjects is false", () => {
      const allowlist = { ...emptySyncAllowlist(), harnesses: { "claude-code": { projects: [] } } };
      expect(isProjectEnabled(allowlist, "claude-code", "/new")).toBe(true);

      const restrictive = { ...allowlist, defaultNewProjects: false };
      expect(isProjectEnabled(restrictive, "claude-code", "/new")).toBe(false);
    });
  });

  describe("buildSyncAllowlist", () => {
    it("groups projects by harness and marks excluded indices disabled", () => {
      const projects = [
        project({ harness: "claude-code", projectPath: "/a" }),
        project({ harness: "codex", projectPath: "/b", importable: false }),
      ];
      const allowlist = buildSyncAllowlist(projects, new Set([2]));

      expect(allowlist.harnesses["claude-code"]?.projects).toEqual([{ path: "/a", enabled: true }]);
      expect(allowlist.harnesses.codex?.projects).toEqual([{ path: "/b", enabled: false }]);
    });
  });

  describe("hasNewProjects", () => {
    it("true when the allowlist is null and there's at least one project", () => {
      expect(hasNewProjects(null, [project()])).toBe(true);
      expect(hasNewProjects(null, [])).toBe(false);
    });

    it("true when a scanned project isn't in the allowlist yet", () => {
      const allowlist = buildSyncAllowlist([project({ projectPath: "/a" })], new Set());
      expect(hasNewProjects(allowlist, [project({ projectPath: "/a" }), project({ projectPath: "/b" })])).toBe(true);
    });

    it("false when every scanned project is already listed", () => {
      const allowlist = buildSyncAllowlist([project({ projectPath: "/a" })], new Set());
      expect(hasNewProjects(allowlist, [project({ projectPath: "/a" })])).toBe(false);
    });
  });
});
