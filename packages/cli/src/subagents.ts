// Shared sub-agent sidecar reader (ADR 0026 D3), used by both
// `sessions` (backfill) and `import-session` (the per-session hook
// path). `detect()` only sets `SessionRef.subAgentsDir` for the backfill
// walk; the hook path constructs its own SessionRef by hand and derives the
// same directory shape itself (`<sessionId>/subagents/` sibling to the
// transcript file) since it never calls `detect()`.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SubAgentFile } from "@membral/core";

/**
 * Read every `agent-<id>.jsonl` + `agent-<id>.meta.json` pair under
 * `subAgentsDir`. Best-effort: a missing/unreadable pair is skipped, never
 * throws — matches the parser's own tolerance for the ~1.7% of spawns with
 * no transcript on disk.
 */
export async function readSubAgentFiles(subAgentsDir: string): Promise<SubAgentFile[]> {
  let entries: string[];
  try {
    entries = (await readdir(subAgentsDir, { withFileTypes: true }))
      .filter((e) => e.isFile() && e.name.endsWith(".meta.json"))
      .map((e) => e.name);
  } catch {
    return [];
  }

  const files: SubAgentFile[] = [];
  for (const metaName of entries) {
    // agent-<agentId>.meta.json
    const base = metaName.slice(0, -".meta.json".length);
    const agentId = base.startsWith("agent-") ? base.slice("agent-".length) : base;
    try {
      const meta = await readFile(join(subAgentsDir, metaName), "utf8");
      let transcript: string | undefined;
      try {
        transcript = await readFile(join(subAgentsDir, `${base}.jsonl`), "utf8");
      } catch {
        transcript = undefined; // ~1.7% of spawns have no transcript on disk — tolerated
      }
      files.push({ agentId, meta, transcript });
    } catch {
      // unreadable meta sidecar — skip this one spawn, keep going
    }
  }
  return files;
}
