// ~/.membral/sync.json — the per-project sync allowlist `membral setup`
// writes from the user's harness-scan selection (deliverable 3).
// `import-sessions.ts` (and therefore both `membral agent`'s sweep and the
// Claude Code SessionEnd hook via `import-session.ts`) honors it: a project
// explicitly listed with `enabled: false` is skipped; a project NOT listed
// at all is enabled by default (new projects auto-sync) unless
// `defaultNewProjects: false` is set. An optional top-level
// `excludePathPatterns` (e.g. ["/private/var/folders/*/membral-lab-*"]) disables
// every project whose path matches: `*` matches any characters (including `/`),
// the pattern is anchored to the whole path, and a string without `*` is an
// exact match. An explicit `enabled: true` entry for a path beats a pattern.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { HarnessId, HarnessProject } from "./harness-scan.js";

export interface SyncProjectEntry {
  path: string;
  enabled: boolean;
}

export interface SyncHarnessConfig {
  projects: SyncProjectEntry[];
}

export interface SyncAllowlist {
  version: 1;
  harnesses: Partial<Record<HarnessId, SyncHarnessConfig>>;
  updatedAt: string;
  /** Default true (new/unlisted projects sync automatically) when omitted. */
  defaultNewProjects?: boolean;
  /** Glob-ish patterns (`*` = any chars) matched against the whole project path; a match disables the project unless it has an explicit `enabled: true` entry. */
  excludePathPatterns?: string[];
}

const MAX_EXCLUDE_PATTERNS = 100;

function validateExcludePatterns(v: unknown): string[] | undefined {
  if (!Array.isArray(v) || v.length > MAX_EXCLUDE_PATTERNS) return undefined;
  if (!v.every((e) => typeof e === "string" && e.length > 0)) return undefined;
  return v as string[];
}

/** Anchored match; `*` matches any chars, everything else is literal (regex metacharacters escaped). */
export function matchesPathPattern(pattern: string, path: string): boolean {
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\/-]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}$`, "s").test(path);
}

export function defaultSyncAllowlistPath(): string {
  return join(homedir(), ".membral", "sync.json");
}

export function emptySyncAllowlist(): SyncAllowlist {
  return { version: 1, harnesses: {}, updatedAt: new Date(0).toISOString() };
}

function isProjectEntry(v: unknown): v is SyncProjectEntry {
  return (
    Boolean(v) &&
    typeof v === "object" &&
    typeof (v as Record<string, unknown>).path === "string" &&
    typeof (v as Record<string, unknown>).enabled === "boolean"
  );
}

/** Pure — validates/sanitizes a parsed JSON value. Never throws; an unrecognized shape degrades to `null` (treated as "no restrictions" by callers). */
export function validateSyncAllowlist(raw: unknown): SyncAllowlist | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!r.harnesses || typeof r.harnesses !== "object") return null;

  const harnesses: SyncAllowlist["harnesses"] = {};
  for (const [key, value] of Object.entries(r.harnesses as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const projectsRaw = (value as Record<string, unknown>).projects;
    if (!Array.isArray(projectsRaw)) continue;
    harnesses[key as HarnessId] = { projects: projectsRaw.filter(isProjectEntry) };
  }

  return {
    version: 1,
    harnesses,
    updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : new Date().toISOString(),
    defaultNewProjects: typeof r.defaultNewProjects === "boolean" ? r.defaultNewProjects : undefined,
    ...(validateExcludePatterns(r.excludePathPatterns)
      ? { excludePathPatterns: validateExcludePatterns(r.excludePathPatterns) }
      : {}),
  };
}

/** Missing/unreadable/corrupt file all degrade to `null` ("no restrictions" — every project syncs) — never throws. */
export function loadSyncAllowlist(path: string = defaultSyncAllowlistPath()): SyncAllowlist | null {
  try {
    return validateSyncAllowlist(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

export function saveSyncAllowlist(allowlist: SyncAllowlist, path: string = defaultSyncAllowlistPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(allowlist, null, 2)}\n`, "utf8");
}

/**
 * True unless the project is explicitly listed with `enabled: false`, or
 * it's unlisted and `defaultNewProjects` is explicitly `false`. A `null`
 * allowlist (no sync.json written yet) means "no restrictions" — everything
 * syncs, matching pre-allowlist behavior.
 */
export function isProjectEnabled(allowlist: SyncAllowlist | null, harness: HarnessId, path: string): boolean {
  if (!allowlist) return true;
  const entry = allowlist.harnesses[harness]?.projects.find((p) => p.path === path);
  if (entry?.enabled) return true;
  if (allowlist.excludePathPatterns?.some((pat) => matchesPathPattern(pat, path))) return false;
  if (entry) return entry.enabled;
  return allowlist.defaultNewProjects !== false;
}

/** Builds a fresh allowlist from a harness scan + the set of (1-based) numbered indices the user chose to exclude — see setup.ts's printScanTable, which returns the matching numbered project list. */
export function buildSyncAllowlist(
  numberedProjects: HarnessProject[],
  excludedIndices: Set<number>,
  previous?: SyncAllowlist | null,
): SyncAllowlist {
  const harnesses: SyncAllowlist["harnesses"] = {};
  numberedProjects.forEach((p, i) => {
    const n = i + 1;
    const enabled = !excludedIndices.has(n);
    const cfg = harnesses[p.harness] ?? { projects: [] };
    cfg.projects.push({ path: p.projectPath, enabled });
    harnesses[p.harness] = cfg;
  });
  return {
    version: 1,
    harnesses,
    updatedAt: new Date().toISOString(),
    // Hand-edited field the wizard never asks about: carry it over.
    ...(previous?.excludePathPatterns ? { excludePathPatterns: previous.excludePathPatterns } : {}),
  };
}

/** True if every project in `scanned` is already explicitly listed in `allowlist` — used by setup.ts to decide whether a re-run can skip re-prompting. */
export function hasNewProjects(allowlist: SyncAllowlist | null, scanned: HarnessProject[]): boolean {
  if (!allowlist) return scanned.length > 0;
  return scanned.some((p) => !allowlist.harnesses[p.harness]?.projects.some((entry) => entry.path === p.projectPath));
}
