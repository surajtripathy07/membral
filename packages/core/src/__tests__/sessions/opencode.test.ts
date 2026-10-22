import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FORGE_ACTIONS_VERSION } from "../../sessions/forge-actions.js";
import { opencodeParser } from "../../sessions/opencode.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Repo-root `fixtures/sessions/opencode/` (goal 2026-09-12 W6/D5) — not the
// package-local `src/__tests__/fixtures/` claude-code.test.ts uses, per the
// task brief's explicit path.
const FIXTURES = join(__dirname, "..", "..", "..", "..", "..", "fixtures", "sessions", "opencode");

function readFixture(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf8");
}

// Derived from a opencode session
// (session `ses_0000000000000000example1`) — 2 user turns, 2 assistant replies split across opencode's
// per-step `message` rows, real `bash`/`glob` tool calls, real (non-zero)
// token usage. Every path, repo name, username, model/provider id, and
// external URL was replaced with a generic placeholder; the result was
// verified to produce zero hits against `.claude/scrub-list.txt`
// (case-insensitive), `$HOME`, and the machine username (see W6 report).
const raw = readFixture("small-session.json");
const ref = { source: "opencode", sourceSessionId: "ses_0000000000000000example1", path: "n/a" };

describe("opencodeParser.parse — small-session fixture", () => {
  const parsed = opencodeParser.parse(ref, raw);

  it("stamps actionsVersion so the cloud can tell a no-action session from an old CLI's", () => {
    expect(parsed.actionsVersion).toBe(FORGE_ACTIONS_VERSION);
  });

  it("reports the correct source and sourceSessionId", () => {
    expect(parsed.source).toBe("opencode");
    expect(parsed.sourceSessionId).toBe("ses_0000000000000000example1");
  });

  it("has at least one user turn and one assistant turn", () => {
    const userTurns = parsed.turns.filter((t) => t.role === "user");
    const assistantTurns = parsed.turns.filter((t) => t.role === "assistant");
    expect(userTurns.length).toBeGreaterThanOrEqual(1);
    expect(assistantTurns.length).toBeGreaterThanOrEqual(1);
  });

  it("captures the user prose turns in order", () => {
    const userProse = parsed.turns.filter((t) => t.role === "user" && t.kind === "prose");
    expect(userProse).toHaveLength(2);
    expect(userProse[0].text).toContain("retry with backoff");
    expect(userProse[1].text).toBe("use https://github.com/example-org/example-repo/pull/1, and fix my local install");
  });

  it("reports a non-empty model string", () => {
    expect(typeof parsed.model).toBe("string");
    expect(parsed.model?.length).toBeGreaterThan(0);
    expect(parsed.model).toBe("acmeai/acme-opus-large");
  });

  it("reports non-zero usage.inputTokens, mapped into the four RawUsage buckets", () => {
    expect(parsed.usage).toBeDefined();
    expect(parsed.usage?.inputTokens).toBeGreaterThan(0);
    // session-level totals from the export (tokensInput=529, tokensOutput=383,
    // tokensReasoning=0 folded into outputTokens, cache read/write as-is).
    expect(parsed.usage).toEqual({
      inputTokens: 529,
      outputTokens: 383,
      cacheReadInputTokens: 18520,
      cacheCreationInputTokens: 18690,
    });
  });

  it("produces ISO-8601 timestamps for startedAt/endedAt and every turn", () => {
    const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
    expect(parsed.startedAt).toMatch(ISO);
    expect(parsed.endedAt).toMatch(ISO);
    for (const turn of parsed.turns) {
      expect(turn.ts).toMatch(ISO);
    }
  });

  it("captures real bash/glob tool_use turns with tool names and repo path", () => {
    const toolTurns = parsed.turns.filter((t) => t.kind === "tool_use");
    expect(toolTurns.length).toBeGreaterThanOrEqual(3);
    expect(toolTurns.map((t) => t.toolName)).toEqual(expect.arrayContaining(["bash", "glob"]));
    expect(parsed.toolCounts.bash).toBe(2);
    expect(parsed.toolCounts.glob).toBe(2);
    expect(parsed.repo.path).toBe("/home/user/codehub");
  });

  it("does not misclassify known builtin tools (bash/glob) as MCP tools", () => {
    const toolTurns = parsed.turns.filter((t) => t.kind === "tool_use");
    for (const turn of toolTurns) {
      expect(turn.mcpServer).toBeUndefined();
      expect(turn.mcpTool).toBeUndefined();
    }
  });

  it("only digests bash commands allowlisted by ADR 0026 D10 (gh/git), matching claude-code.ts exactly (2026-09-12 review, finding 3)", () => {
    const bashTurns = parsed.turns.filter((t) => t.kind === "tool_use" && t.toolName === "bash");
    expect(bashTurns.length).toBeGreaterThan(0);
    // Both bash calls in this fixture are `git ...` — allowlisted, so both
    // get a digest.
    for (const turn of bashTurns) {
      expect(turn.inputDigest).toBeDefined();
      expect(turn.inputDigest).toMatch(/^git /);
    }
  });

  it("redacts secrets in turn text the same way the Claude Code parser does", () => {
    // No secrets in this fixture — this asserts the parser routes text
    // through redactSecrets rather than asserting on a specific redaction
    // (the redaction behavior itself is covered by redact.test.ts).
    for (const turn of parsed.turns) {
      if (turn.text) expect(turn.text).not.toMatch(/\bsk-[A-Za-z0-9_-]{16,}\b/);
    }
  });

  it("computes contentHash as sha256 of the raw bytes, stable across re-parses (idempotent re-import)", () => {
    expect(parsed.contentHash).toBe(createHash("sha256").update(Buffer.from(raw, "utf8")).digest("hex"));
    expect(parsed.contentHash).toMatch(/^[a-f0-9]{64}$/);

    const reparsed = opencodeParser.parse(ref, raw);
    expect(reparsed.contentHash).toBe(parsed.contentHash);
    expect(reparsed).toEqual(parsed);
  });

  it("changes contentHash when the raw bytes change", () => {
    const other = opencodeParser.parse(ref, `${raw}\n`);
    expect(other.contentHash).not.toBe(parsed.contentHash);
  });
});

// Derived from a parent+child pair
// (parent `ses_0000000000000000example2`, child
// `ses_0000000000000000example3`) — the parent's `task` tool_use was
// CANCELLED before producing any `output` text, so the only join key
// available is the structured `state.metadata.sessionId` (2026-09-12
// review, findings 6 and 10). The real (much longer, project-specific)
// prompt/description text was replaced with a short generic stand-in; every
// path/repo name/provider was genericized the same way as the first
// fixture — verified zero scrub-list/username/$HOME hits (see W6 report).
const subAgentRaw = readFixture("session-with-subagent.json");
const subAgentRef = { source: "opencode", sourceSessionId: "ses_0000000000000000example2", path: "n/a" };

describe("opencodeParser.parse — session-with-subagent fixture (sub-agent tree)", () => {
  const parsed = opencodeParser.parse(subAgentRef, subAgentRaw);

  it("surfaces exactly one direct sub-agent", () => {
    expect(parsed.subAgents).toBeDefined();
    expect(parsed.subAgents).toHaveLength(1);
  });

  it("joins toolUseId/description via the cancelled task tool_use, using state.metadata.sessionId (no output text exists to regex against)", () => {
    const sub = parsed.subAgents?.[0];
    expect(sub?.agentId).toBe("ses_0000000000000000example3");
    expect(sub?.toolUseId).toBe("01KRX2WJG8YQPQ0B6MKXF241P6");
    expect(sub?.description).toBe(
      "Implementation orchestrator that drives TDD-first code delivery by routing work to specialist subagents",
    );
  });

  it("reports the sub-agent's own agentType, model, usage, and spawnDepth (direct children only)", () => {
    const sub = parsed.subAgents?.[0];
    expect(sub?.agentType).toBe("build");
    expect(sub?.model).toBe("acmeai/acme-opus-large");
    expect(sub?.spawnDepth).toBe(1);
    expect(sub?.parentAgentId).toBeUndefined();
    expect(sub?.isFork).toBeUndefined();
    expect(sub?.usage).toEqual({
      inputTokens: 7352,
      outputTokens: 304,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    });
  });

  it("never double-counts: the parent's own usage excludes the child's tokens", () => {
    // The parent session row itself carries zero usage (all real work was
    // delegated to the child) — RawCodeSession.usage must reflect only the
    // parent's OWN session-level tokens, not the sum including children.
    expect(parsed.usage).toBeUndefined();
  });

  it("a grep/bash tool_use part that happened to echo 'task_id: ...' text cannot hijack another sub-agent's join (finding 10 regression guard)", () => {
    // Construct a variant export with a decoy bash tool part echoing a
    // task_id-shaped string for a DIFFERENT session id, appended after the
    // real task part — confirms the join only ever considers `tool: "task"`
    // parts, never scans arbitrary tool output.
    const exportData = JSON.parse(subAgentRaw);
    const decoyMessageId = exportData.messages[1].id;
    exportData.parts.push({
      messageId: decoyMessageId,
      data: JSON.stringify({
        type: "tool",
        tool: "bash",
        callID: "decoy-call-id",
        state: {
          status: "completed",
          input: { command: "git log" },
          output: "task_id: ses_0000000000000000example3 (decoy)",
        },
      }),
    });
    const decoyRaw = JSON.stringify(exportData);
    const decoyParsed = opencodeParser.parse(subAgentRef, decoyRaw);
    const sub = decoyParsed.subAgents?.[0];
    // Must still resolve via the real `task` part's structured metadata,
    // NOT the decoy bash part's toolUseId.
    expect(sub?.toolUseId).toBe("01KRX2WJG8YQPQ0B6MKXF241P6");
  });
});

describe("opencodeParser — ADR 0026 D10 digest gate rejects non-allowlisted bash commands", () => {
  it("does not digest a bash command outside gh/git (e.g. an arbitrary shell command that could carry a username/hostname/path)", () => {
    const exportData = JSON.parse(subAgentRaw);
    exportData.parts = [
      {
        messageId: exportData.messages[1].id,
        data: JSON.stringify({
          type: "tool",
          tool: "bash",
          callID: "call-1",
          state: { status: "completed", input: { command: "ls -la /home/user" }, output: "ok" },
        }),
      },
    ];
    const result = opencodeParser.parse(subAgentRef, JSON.stringify(exportData));
    const bashTurn = result.turns.find((t) => t.kind === "tool_use" && t.toolName === "bash");
    expect(bashTurn).toBeDefined();
    expect(bashTurn?.inputDigest).toBeUndefined();
  });
});

describe("opencodeParser — MCP heuristic prefix fix (finding 8)", () => {
  it("treats sibling websearch_*/session_* plugin tools as non-MCP (prefix, not exact-name match)", () => {
    const exportData = JSON.parse(subAgentRaw);
    exportData.parts = [
      {
        messageId: exportData.messages[1].id,
        data: JSON.stringify({
          type: "tool",
          tool: "websearch_another_tool",
          callID: "call-1",
          state: { status: "completed", input: {}, output: "ok" },
        }),
      },
      {
        messageId: exportData.messages[1].id,
        data: JSON.stringify({
          type: "tool",
          tool: "session_another_tool",
          callID: "call-2",
          state: { status: "completed", input: {}, output: "ok" },
        }),
      },
    ];
    const result = opencodeParser.parse(subAgentRef, JSON.stringify(exportData));
    const toolTurns = result.turns.filter((t) => t.kind === "tool_use");
    expect(toolTurns).toHaveLength(2);
    for (const turn of toolTurns) {
      expect(turn.mcpServer).toBeUndefined();
      expect(turn.mcpTool).toBeUndefined();
    }
  });
});

describe("opencodeParser — toIso rejects epoch 0 (finding 9)", () => {
  it("does not let a zero/missing timestamp win the startedAt min-reduce", () => {
    const exportData = JSON.parse(subAgentRaw);
    // A malformed row with time.created = 0 must not become startedAt.
    exportData.messages.push({
      id: "msg-zero-ts",
      data: JSON.stringify({ role: "user", time: { created: 0 } }),
    });
    const result = opencodeParser.parse(subAgentRef, JSON.stringify(exportData));
    expect(result.startedAt).not.toBe("1970-01-01T00:00:00.000Z");
  });
});

describe("opencodeParser — malformed input", () => {
  it("never throws on unparseable raw bytes; returns the smallest valid session", () => {
    const ref2 = { source: "opencode", sourceSessionId: "broken", path: "n/a" };
    const result = opencodeParser.parse(ref2, "not json at all");
    expect(result.source).toBe("opencode");
    expect(result.sourceSessionId).toBe("broken");
    expect(result.turns).toEqual([]);
    expect(result.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("detect() always returns an empty array — opencode discovery happens in the CLI via SQLite, not core", async () => {
    await expect(opencodeParser.detect("/does/not/matter")).resolves.toEqual([]);
  });
});

describe("opencodeParser.parse — a sub-agent session exported on its own", () => {
  function exportFor(parentId: string | null) {
    return JSON.stringify({
      session: {
        id: "ses_child",
        parentId,
        directory: "/home/user/codehub",
        title: "Find the flaky test (@explore subagent)",
        agent: "explore",
        modelRaw: null,
        timeCreated: 1000,
        timeUpdated: 2000,
        cost: 0,
        tokensInput: 1,
        tokensOutput: 1,
        tokensReasoning: 0,
        tokensCacheRead: 0,
        tokensCacheWrite: 0,
      },
      messages: [
        { id: "m1", data: JSON.stringify({ role: "user", time: { created: 1000 } }) },
        {
          id: "m2",
          data: JSON.stringify({ role: "assistant", modelID: "m-1", providerID: "p", time: { created: 1500 } }),
        },
      ],
      parts: [
        { messageId: "m1", data: JSON.stringify({ type: "text", text: "find it" }) },
        { messageId: "m2", data: JSON.stringify({ type: "text", text: "found it" }) },
      ],
    });
  }

  it("links a child to its direct parent and carries its agent metadata", () => {
    const parsed = opencodeParser.parse(
      { source: "opencode", sourceSessionId: "ses_child", path: "n/a" },
      exportFor("ses_parent"),
    );
    expect(parsed.parentSessionId).toBe("ses_parent");
    expect(parsed.subAgent?.agentId).toBe("ses_child");
    expect(parsed.subAgent?.agentType).toBe("explore");
    expect(parsed.subAgent?.model).toBe("p/m-1");
    expect(parsed.turns.map((t) => t.text)).toEqual(["find it", "found it"]);
  });

  it("leaves a top-level session unlinked", () => {
    const parsed = opencodeParser.parse(
      { source: "opencode", sourceSessionId: "ses_child", path: "n/a" },
      exportFor(null),
    );
    expect(parsed.parentSessionId).toBeUndefined();
    expect(parsed.subAgent).toBeUndefined();
  });
});

describe("opencodeParser.parse — a git commit call proven to have done nothing (R-5/R-3)", () => {
  // Same scenario as claude-code.test.ts's equivalent describe block, in
  // opencode's export shape: one `bash` tool part, `status: "error"` +
  // nonzero `exit` (opencode's isError signal), no derived action.
  function session(command: string, output: string, exit: number) {
    const sessionRow = {
      id: "ses_r5",
      parentId: null,
      directory: "/repo",
      title: "t",
      agent: null,
      modelRaw: null,
      timeCreated: 0,
      timeUpdated: 0,
      cost: 0,
      tokensInput: 0,
      tokensOutput: 0,
      tokensReasoning: 0,
      tokensCacheRead: 0,
      tokensCacheWrite: 0,
    };
    const raw = JSON.stringify({
      session: sessionRow,
      messages: [{ id: "msg_1", data: JSON.stringify({ role: "assistant", modelID: "m", providerID: "p" }) }],
      parts: [
        {
          messageId: "msg_1",
          data: JSON.stringify({
            type: "tool",
            tool: "bash",
            callID: "call_1",
            state: { status: exit === 0 ? "completed" : "error", input: { command }, output, metadata: { exit } },
          }),
        },
      ],
    });
    const parsed = opencodeParser.parse({ source: "opencode", sourceSessionId: "ses_r5", path: "n/a" }, raw);
    return parsed.turns.find((t) => t.toolUseId === "call_1");
  }

  it("R-5: a pre-commit hook rejection (exit 1) leaves no committed action and no stale digest", () => {
    const turn = session(
      "git add README.md && git commit -q -m \"$(cat <<'EOF'\nAdd 0.3.1 changelog entry\nEOF\n)\"",
      "Exit code 1\npre-commit: direct commits to main are not allowed; use a branch",
      1,
    );
    expect(turn?.action).toBeUndefined();
    expect(turn?.inputDigest).toBeUndefined();
  });

  it("does not clear the digest of a successful quiet commit (no false positive)", () => {
    const turn = session(
      "git add README.md && git commit -q -m \"$(cat <<'EOF'\nAdd 0.3.1 changelog entry\nEOF\n)\"",
      "",
      0,
    );
    expect(turn?.action?.verb).toBe("committed");
    expect(turn?.inputDigest).toBeDefined();
  });
});
