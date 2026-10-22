// Behaviour lock (D-059) for `codexParser`: every committed fixture under
// fixtures/sessions/codex/sessions/, parsed with the same ref the unit tests
// use, snapshot of the full RawCodeSession plus the empty-input edge case.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { codexParser } from "../../codex.js";
import { golden } from "./serialize.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// packages/core/src/sessions/__tests__/golden -> repo root -> fixtures/sessions/codex
const ROOT = join(__dirname, "..", "..", "..", "..", "..", "..", "fixtures", "sessions", "codex");

const FIXTURE_CASES: Array<{ name: string; file: string; sourceSessionId: string }> = [
  // Codex CLI event order: session_meta, developer + injected user context,
  // turn_context, prompt, reasoning, MCP / exec_command / apply_patch calls,
  // repeated token_count totals, an unknown line type, final answer.
  {
    name: "small-session",
    file: "sessions/2026/05/14/rollout-2026-05-14T09-12-01-5b1e9c2a-7d40-4f8e-a3b6-0c9d2e4f6a11.jsonl",
    sourceSessionId: "5b1e9c2a-7d40-4f8e-a3b6-0c9d2e4f6a11",
  },
];

describe("golden: codexParser.parse — one snapshot per committed fixture", () => {
  for (const { name, file, sourceSessionId } of FIXTURE_CASES) {
    it(`matches the committed snapshot for ${name}`, async () => {
      const ref = { source: "codex", sourceSessionId, path: "n/a" };
      const parsed = codexParser.parse(ref, readFileSync(join(ROOT, file), "utf8"));
      await expect(golden(parsed)).toMatchFileSnapshot(`./__snapshots__/codex.${name}.json`);
    });
  }
});

describe("golden: codexParser edge cases", () => {
  it("matches the committed snapshot for empty raw bytes (never throws)", async () => {
    const ref = { source: "codex", sourceSessionId: "empty-session", path: "n/a" };
    const parsed = codexParser.parse(ref, "");
    await expect(golden(parsed)).toMatchFileSnapshot("./__snapshots__/codex.empty-session.json");
  });
});
