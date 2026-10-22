// G0 goal follow-up (D-059): golden test over `claudeCodeParser`, run against
// the harvested real-world transcripts under fixtures/sessions/harvest/
// (UNTRACKED pending a privacy review — see docs/HANDOFF.md), mirroring
// claude-code.golden.test.ts exactly: same parser calls, same `serialize.ts`
// golden() form, one committed snapshot file per session under
// __snapshots__/harvest/.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { claudeCodeParser } from "../../claude-code.js";
import type { SubAgentFile } from "../../types.js";
import { golden } from "./serialize.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// packages/core/src/sessions/__tests__/golden -> repo root -> fixtures/sessions/harvest
const HARVEST = join(__dirname, "..", "..", "..", "..", "..", "..", "fixtures", "sessions", "harvest");

// Harvest session directories, sorted. Discovered from disk (not hardcoded)
// so a future harvest refresh (e.g. after the pending redaction pass) picks
// up added/removed sessions without editing this file; `readdirSync` with
// `withFileTypes` naturally excludes the sibling MANIFEST.md/redact.mjs files.
const SESSION_NAMES = readdirSync(HARVEST, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

function readSession(name: string): string {
  return readFileSync(join(HARVEST, name, "transcript.jsonl"), "utf8");
}

// The two harvested sessions that carry a subagents/ sidecar (per
// meta.json's has_subagent_sidecar: true), read the same shape
// claude-code.golden.test.ts's "sub-agent sidecar join" describe block
// builds by hand: one { agentId, meta, transcript } per agent-<id> pair.
function readSubAgents(name: string): SubAgentFile[] {
  const dir = join(HARVEST, name, "subagents");
  const agentIds = readdirSync(dir)
    .map((entry) => entry.match(/^agent-(.+)\.jsonl$/))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map((match) => match[1])
    .sort();
  return agentIds.map((agentId) => ({
    agentId,
    meta: readFileSync(join(dir, `agent-${agentId}.meta.json`), "utf8"),
    transcript: readFileSync(join(dir, `agent-${agentId}.jsonl`), "utf8"),
  }));
}

const SUBAGENT_SESSIONS = ["a-subagent-sidecar-1", "c-subagent-sidecar-1"];

// Tiny stable summary, captured once from claudeCodeParser.parse() on this
// fixture set (2026-09-28), asserted alongside each snapshot so a reader
// sees the session's shape without opening the (larger) snapshot file.
//
// NOT compared against meta.json's `turn_count`: that field is the raw
// transcript.jsonl LINE count (verified equal to `wc -l` for all 20 sessions
// at authoring time), not the parser's turn count — claudeCodeParser merges/
// filters raw JSONL lines (e.g. non-owner lines, tool_use+tool_result pairs)
// into fewer RawTurn entries, so the two fields measure different things and
// only the parser's own output is a meaningful thing to lock here.
// Counts below are from the 2026-09-28 re-redacted corpus: the earlier
// redaction's secret-key rule matched the "sk-" substring inside
// `<task-notification>`/`<task-id>` tags (task = t-a-s-k), mangling each to
// `<ta<redacted>>` and costing the parser one extra unrecognized-marker turn
// per affected session; the fix dropped a-large-billing-1, a-subagent-
// sidecar-1 and c-subagent-sidecar-1 by exactly one turn each.
const EXPECTED_TURN_COUNTS: Record<string, number> = {
  "a-checkout-branch-1": 12,
  "a-forge-ref-commit-1": 21,
  "a-gh-pr-merge-1": 24,
  "a-large-billing-1": 103,
  "a-nohook-medium-1": 22,
  "a-subagent-sidecar-1": 9,
  "c-hindi-sprachbox-1": 23,
  "c-large-longhaul-1": 207,
  "c-non-coding-notes-1": 4,
  "c-non-coding-tiny-1": 2,
  "c-subagent-sidecar-1": 6,
  "r-hindi-sprachbox-1": 34,
  "r-large-billing-1": 51,
  "r-nohook-medium-1": 42,
};

describe("golden: claudeCodeParser.parse — one snapshot per harvested session (fixtures/sessions/harvest)", () => {
  for (const name of SESSION_NAMES) {
    const ref = { source: "claude-code", sourceSessionId: name, path: "n/a" };

    it(`matches the committed snapshot for ${name}`, async () => {
      const parsed = claudeCodeParser.parse(ref, readSession(name));
      await expect(golden(parsed)).toMatchFileSnapshot(`./__snapshots__/harvest/${name}.json`);
    });

    it(`parses ${name} into its expected turn count`, () => {
      const parsed = claudeCodeParser.parse(ref, readSession(name));
      expect(parsed.turns.length).toBe(EXPECTED_TURN_COUNTS[name]);
    });
  }
});

describe("golden: claudeCodeParser sub-agent sidecar join for harvested sessions with a subagents/ sidecar", () => {
  for (const name of SUBAGENT_SESSIONS) {
    const ref = { source: "claude-code", sourceSessionId: name, path: "n/a" };
    const subAgents = readSubAgents(name);

    it(`matches the committed snapshot for ${name}'s parent session (with subAgents metadata)`, async () => {
      const parent = claudeCodeParser.parse(ref, readSession(name), { subAgents });
      await expect(golden(parent)).toMatchFileSnapshot(`./__snapshots__/harvest/${name}.parent-with-subagents.json`);
    });

    it(`matches the committed snapshot for ${name}'s child sessions from parseSubAgentSessions`, async () => {
      const parent = claudeCodeParser.parse(ref, readSession(name), { subAgents });
      const children = claudeCodeParser.parseSubAgentSessions?.(parent, { subAgents }) ?? [];
      await expect(golden(children)).toMatchFileSnapshot(`./__snapshots__/harvest/${name}.children.json`);
    });
  }
});
