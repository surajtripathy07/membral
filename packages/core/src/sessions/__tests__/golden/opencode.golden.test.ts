// Step 0.2 (behaviour lock, D-059/D-051, G0 goal §0.2): golden test over
// `opencodeParser` — every committed fixture under
// fixtures/sessions/opencode/ (repo-root, per opencode.test.ts's own comment
// that these are NOT the package-local __tests__/fixtures/ tree), parsed
// with the same refs the existing unit tests use, snapshot of the full
// RawCodeSession plus the parser's own malformed-input edge case.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { opencodeParser } from "../../opencode.js";
import { golden } from "./serialize.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// packages/core/src/sessions/__tests__/golden -> repo root -> fixtures/sessions/opencode
const FIXTURES = join(__dirname, "..", "..", "..", "..", "..", "..", "fixtures", "sessions", "opencode");

function readFixture(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf8");
}

const FIXTURE_CASES: Array<{ name: string; file: string; sourceSessionId: string }> = [
  { name: "small-session", file: "small-session.json", sourceSessionId: "ses_0000000000000000example1" },
  {
    name: "session-with-subagent",
    file: "session-with-subagent.json",
    sourceSessionId: "ses_0000000000000000example2",
  },
];

describe("golden: opencodeParser.parse — one snapshot per committed fixture", () => {
  for (const { name, file, sourceSessionId } of FIXTURE_CASES) {
    it(`matches the committed snapshot for ${file}`, async () => {
      const ref = { source: "opencode", sourceSessionId, path: "n/a" };
      const parsed = opencodeParser.parse(ref, readFixture(file));
      await expect(golden(parsed)).toMatchFileSnapshot(`./__snapshots__/opencode.${name}.json`);
    });
  }
});

describe("golden: opencodeParser edge cases", () => {
  it("matches the committed snapshot for unparseable raw bytes (never throws)", async () => {
    const ref = { source: "opencode", sourceSessionId: "empty-session", path: "n/a" };
    const parsed = opencodeParser.parse(ref, "");
    await expect(golden(parsed)).toMatchFileSnapshot("./__snapshots__/opencode.empty-session.json");
  });

  it("matches the committed snapshot for detect() (always [])", async () => {
    const refs = await opencodeParser.detect("/golden/fixture-root/does-not-matter");
    await expect(golden(refs)).toMatchFileSnapshot("./__snapshots__/opencode.detect.json");
  });
});
