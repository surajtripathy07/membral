// Step 0.2 (behaviour lock, D-059/D-051, G0 goal §0.2): golden test over
// `claudeCodeParser` — every committed fixture under
// packages/core/src/__tests__/fixtures/claude-code/, parsed exactly as the
// existing unit tests parse it (same refs, same subAgents extras), snapshot
// of the FULL RawCodeSession (or thrown-error shape) so any output change —
// not just the fields today's unit tests happen to assert on — fails CI.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { claudeCodeParser, SessionRootUnreadableError } from "../../claude-code.js";
import { golden } from "./serialize.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// packages/core/src/sessions/__tests__/golden -> packages/core/src/__tests__/fixtures/claude-code
const FIXTURES = join(__dirname, "..", "..", "..", "__tests__", "fixtures", "claude-code");

function readFixture(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf8");
}

// One case per committed fixture file, mirroring the ref each fixture is
// parsed with in packages/core/src/__tests__/sessions/claude-code.test.ts.
const FIXTURE_CASES: Array<{ name: string; file: string; sourceSessionId: string }> = [
  { name: "small-session", file: "small-session.jsonl", sourceSessionId: "22222222-2222-4222-8222-222222222222" },
  {
    name: "reassembly-session",
    file: "reassembly-session.jsonl",
    sourceSessionId: "33333333-3333-4333-8333-333333333333",
  },
  { name: "usage-session", file: "usage-session.jsonl", sourceSessionId: "44444444-4444-4444-8444-444444444444" },
  {
    name: "non-owner-turns",
    file: "non-owner-turns.jsonl",
    sourceSessionId: "55555555-5555-4555-8555-555555555555",
  },
  {
    name: "project-aaaaaaaa",
    file: "projects/-home-dev-acme-webapp/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl",
    sourceSessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  },
  {
    name: "project-bbbbbbbb",
    file: "projects/-home-dev-acme-webapp/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jsonl",
    sourceSessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  },
  {
    name: "project-cccccccc",
    file: "projects/-home-dev-other-repo/cccccccc-cccc-4ccc-8ccc-cccccccccccc.jsonl",
    sourceSessionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  },
];

describe("golden: claudeCodeParser.parse — one snapshot per committed fixture", () => {
  for (const { name, file, sourceSessionId } of FIXTURE_CASES) {
    it(`matches the committed snapshot for ${file}`, async () => {
      const ref = { source: "claude-code", sourceSessionId, path: "n/a" };
      const parsed = claudeCodeParser.parse(ref, readFixture(file));
      await expect(golden(parsed)).toMatchFileSnapshot(`./__snapshots__/claude-code.${name}.json`);
    });
  }
});

describe("golden: claudeCodeParser sub-agent sidecar join + parseSubAgentSessions", () => {
  // Same fixture pairing as the existing sub-agent unit tests: the sidecar
  // under projects/.../aaaaaaaa.../subagents/ is joined against
  // usage-session.jsonl as the main transcript, with the parent ref's
  // sourceSessionId set to the aaaaaaaa... project id (see
  // claude-code.test.ts "sub-agent sidecar join" describe block).
  const SUBAGENTS_DIR = join(
    FIXTURES,
    "projects",
    "-home-dev-acme-webapp",
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "subagents",
  );
  const AGENT_ID = "55555555-5555-4555-8555-555555555555";
  const file = {
    agentId: AGENT_ID,
    meta: readFileSync(join(SUBAGENTS_DIR, `agent-${AGENT_ID}.meta.json`), "utf8"),
    transcript: readFileSync(join(SUBAGENTS_DIR, `agent-${AGENT_ID}.jsonl`), "utf8"),
  };
  const ref = { source: "claude-code", sourceSessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", path: "n/a" };

  it("matches the committed snapshot for the parent session (with subAgents metadata)", async () => {
    const parent = claudeCodeParser.parse(ref, readFixture("usage-session.jsonl"), { subAgents: [file] });
    await expect(golden(parent)).toMatchFileSnapshot("./__snapshots__/claude-code.subagent-parent.json");
  });

  it("matches the committed snapshot for the child sessions from parseSubAgentSessions", async () => {
    const parent = claudeCodeParser.parse(ref, readFixture("usage-session.jsonl"), { subAgents: [file] });
    const children = claudeCodeParser.parseSubAgentSessions?.(parent, { subAgents: [file] }) ?? [];
    await expect(golden(children)).toMatchFileSnapshot("./__snapshots__/claude-code.subagent-children.json");
  });
});

describe("golden: claudeCodeParser edge cases", () => {
  it("matches the committed snapshot for an empty-bytes session (0 lines, no timestamps)", async () => {
    const ref = { source: "claude-code", sourceSessionId: "empty-session", path: "n/a" };
    const parsed = claudeCodeParser.parse(ref, "");
    await expect(golden(parsed)).toMatchFileSnapshot("./__snapshots__/claude-code.empty-session.json");
  });

  it("matches the committed snapshot for detect()'s thrown SessionRootUnreadableError", async () => {
    // Hardcoded literal, never derived from __dirname/import.meta.url, so the
    // error's `root`/`message` fields are identical on every machine and CI
    // runner (see serialize.ts's file-header note on volatility).
    const root = "/golden/fixture-root/does-not-exist";
    let captured: unknown;
    try {
      await claudeCodeParser.detect(root);
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(SessionRootUnreadableError);
    const err = captured as SessionRootUnreadableError;
    await expect(golden({ name: err.name, message: err.message, root: err.root })).toMatchFileSnapshot(
      "./__snapshots__/claude-code.unreadable-root-error.json",
    );
  });
});
