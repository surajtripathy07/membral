// Behaviour lock (D-059) for `copilotCliParser`: every committed fixture
// under fixtures/sessions/copilot-cli/session-state/, parsed with the same
// refs the unit tests use, snapshot of the full RawCodeSession plus the
// parser's malformed-input edge case.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { copilotCliParser } from "../../copilot-cli.js";
import { golden } from "./serialize.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// packages/core/src/sessions/__tests__/golden -> repo root -> fixtures/sessions/copilot-cli
const ROOT = join(__dirname, "..", "..", "..", "..", "..", "..", "fixtures", "sessions", "copilot-cli");

const FIXTURE_CASES: Array<{ name: string; sourceSessionId: string }> = [
  { name: "small-session", sourceSessionId: "7c0f3a52-1d4e-4b8a-9f61-2e5d8c4b1a01" },
  { name: "killed-session", sourceSessionId: "9e2b7d14-5a3c-4f80-b6d2-0c1e4a7f3b02" },
  // Copilot CLI 1.0.91 event order: auto model, hook.*, auto_mode_resolved, usage_checkpoint, shutdown.
  { name: "auto-model-session", sourceSessionId: "3d8a61f0-7b2e-4c95-a4d1-5f0b9e2c7a03" },
];

describe("golden: copilotCliParser.parse — one snapshot per committed fixture", () => {
  for (const { name, sourceSessionId } of FIXTURE_CASES) {
    it(`matches the committed snapshot for ${name}`, async () => {
      const ref = { source: "copilot-cli", sourceSessionId, path: "n/a" };
      const raw = readFileSync(join(ROOT, "session-state", sourceSessionId, "events.jsonl"), "utf8");
      const parsed = copilotCliParser.parse(ref, raw);
      await expect(golden(parsed)).toMatchFileSnapshot(`./__snapshots__/copilot-cli.${name}.json`);
    });
  }
});

describe("golden: copilotCliParser edge cases", () => {
  it("matches the committed snapshot for empty raw bytes (never throws)", async () => {
    const ref = { source: "copilot-cli", sourceSessionId: "empty-session", path: "n/a" };
    const parsed = copilotCliParser.parse(ref, "");
    await expect(golden(parsed)).toMatchFileSnapshot("./__snapshots__/copilot-cli.empty-session.json");
  });
});
