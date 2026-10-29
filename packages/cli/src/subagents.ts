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
 * `subAgentsDir`, and under each `subAgentsDir/workflows/wf_*` directory (the
 * sub-agents a workflow run spawns live there, with the same pair shape and
 * the same parent session). Best-effort: a missing/unreadable pair is skipped,
 * never throws — matches the parser's own tolerance for the ~1.7% of spawns
 * with no transcript on disk. An agent id seen twice keeps its first file.
 *
 * Pairing keys on the meta sidecar (it carries the agent type and description), so an `agent-*.jsonl` with no
 * `.meta.json` is deliberately skipped, not guessed at. `onUnpaired` is told how many were skipped (once, with the
 * total across the directory and its workflows) so a caller can say so instead of dropping them silently.
 */
export async function readSubAgentFiles(
  subAgentsDir: string,
  onUnpaired?: (count: number) => void,
): Promise<SubAgentFile[]> {
  const unpaired = { count: 0 };
  const files = await readSubAgentPairs(subAgentsDir, unpaired);
  let workflows: string[] = [];
  try {
    workflows = (await readdir(join(subAgentsDir, "workflows"), { withFileTypes: true }))
      .filter((e) => e.isDirectory() && e.name.startsWith("wf_"))
      .map((e) => e.name)
      .sort();
  } catch {
    // no workflows directory — the common case
  }
  const seen = new Set(files.map((f) => f.agentId));
  for (const wf of workflows) {
    for (const file of await readSubAgentPairs(join(subAgentsDir, "workflows", wf), unpaired)) {
      if (seen.has(file.agentId)) continue;
      seen.add(file.agentId);
      files.push(file);
    }
  }
  if (unpaired.count > 0) onUnpaired?.(unpaired.count);
  return files;
}

async function readSubAgentPairs(dir: string, unpaired: { count: number }): Promise<SubAgentFile[]> {
  let entries: string[];
  try {
    const all = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isFile());
    entries = all.filter((e) => e.name.endsWith(".meta.json")).map((e) => e.name);
    const metas = new Set(entries.map((n) => n.slice(0, -".meta.json".length)));
    for (const e of all) {
      if (e.name.startsWith("agent-") && e.name.endsWith(".jsonl") && !metas.has(e.name.slice(0, -".jsonl".length))) {
        unpaired.count++;
      }
    }
  } catch {
    return [];
  }

  const files: SubAgentFile[] = [];
  for (const metaName of entries) {
    // agent-<agentId>.meta.json
    const base = metaName.slice(0, -".meta.json".length);
    const agentId = base.startsWith("agent-") ? base.slice("agent-".length) : base;
    try {
      const meta = await readFile(join(dir, metaName), "utf8");
      let transcript: string | undefined;
      try {
        transcript = await readFile(join(dir, `${base}.jsonl`), "utf8");
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
