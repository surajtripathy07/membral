import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  claudeCodeParser,
  isSensitiveFilePath,
  SessionRootUnreadableError,
  WRITTEN_TEXT_MAX_CHARS,
} from "../../sessions/claude-code.js";
import { FORGE_ACTIONS_VERSION } from "../../sessions/forge-actions.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, "..", "fixtures", "claude-code");

function readFixture(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf8");
}

describe("claudeCodeParser.parse — small-session fixture", () => {
  const ref = { source: "claude-code", sourceSessionId: "22222222-2222-4222-8222-222222222222", path: "n/a" };
  const raw = readFixture("small-session.jsonl");
  const parsed = claudeCodeParser.parse(ref, raw);

  it("stamps actionsVersion so the cloud can tell a no-action session from an old CLI's", () => {
    expect(parsed.actionsVersion).toBe(FORGE_ACTIONS_VERSION);
  });

  it("reports the correct source and sourceSessionId", () => {
    expect(parsed.source).toBe("claude-code");
    expect(parsed.sourceSessionId).toBe("22222222-2222-4222-8222-222222222222");
  });

  it("captures cwd/gitBranch/model from any event in the session", () => {
    expect(parsed.repo).toEqual({ path: "/home/dev/acme-webapp", branch: "feature/onboarding-flow" });
    expect(parsed.model).toBe("codehub-model-1");
  });

  it("computes startedAt/endedAt as min/max timestamp, ignoring unknown-type lines with no timestamp", () => {
    expect(parsed.startedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(parsed.endedAt).toBe("2026-01-01T00:00:20.000Z");
    const durationSeconds = (new Date(parsed.endedAt).getTime() - new Date(parsed.startedAt).getTime()) / 1000;
    expect(durationSeconds).toBe(20);
  });

  it("computes contentHash as sha256 of the raw bytes, stable across re-parses", () => {
    expect(parsed.contentHash).toBe(createHash("sha256").update(Buffer.from(raw, "utf8")).digest("hex"));
    expect(parsed.contentHash).toMatch(/^[a-f0-9]{64}$/);

    const reparsed = claudeCodeParser.parse(ref, raw);
    expect(reparsed.contentHash).toBe(parsed.contentHash);
  });

  it("changes contentHash when the raw bytes change", () => {
    const other = claudeCodeParser.parse(ref, `${raw}\n`);
    expect(other.contentHash).not.toBe(parsed.contentHash);
  });

  it("builds the user spine, excluding isMeta / command-wrapped / system-reminder / task-notification / sidechain lines", () => {
    const userProse = parsed.turns.filter((t) => t.role === "user" && t.kind === "prose");
    expect(userProse.map((t) => t.text)).toEqual([
      "Add a health check endpoint to the CodeHub API server.",
      "Looks good. Also remove the test API key [REDACTED] from the config before committing.",
    ]);
  });

  it("redacts obvious secrets in user-prose turn text", () => {
    const last = parsed.turns.find((t) => t.role === "user" && t.kind === "prose" && t.text?.startsWith("Looks good"));
    expect(last?.text).not.toContain("sk-testFAKEKEY1234567890abcdef");
    expect(last?.text).toContain("[REDACTED]");
  });

  it("reassembles multi-line assistant blocks sharing message.id into merged prose/thinking turns", () => {
    const assistantProse = parsed.turns.filter((t) => t.role === "assistant" && t.kind === "prose");
    const assistantThinking = parsed.turns.filter((t) => t.role === "assistant" && t.kind === "thinking");

    expect(assistantThinking).toHaveLength(1);
    expect(assistantThinking[0].text).toBe(
      "I should look at the router file first.\n\nThe health route likely belongs in routes/health.ts.",
    );

    expect(assistantProse.map((t) => t.text)).toEqual([
      "I will add a new health route file and wire it into the router.",
      "The write failed — let me retry with Edit instead.",
    ]);
  });

  it("emits one tool_use turn per block, never merging tool_use", () => {
    const toolUses = parsed.turns.filter((t) => t.kind === "tool_use");
    expect(toolUses.map((t) => t.toolName)).toEqual(["Read", "Write", "Edit", "Bash"]);
  });

  it("sets filePath from input.file_path only for Edit/Write/Read/NotebookEdit tools", () => {
    const toolUses = parsed.turns.filter((t) => t.kind === "tool_use");
    const byName = Object.fromEntries(toolUses.map((t) => [t.toolName, t.filePath]));
    expect(byName.Read).toBe("/home/dev/acme-webapp/src/router.ts");
    expect(byName.Write).toBe("/home/dev/acme-webapp/src/routes/health.ts");
    expect(byName.Edit).toBe("/home/dev/acme-webapp/src/routes/health.ts");
    expect(byName.Bash).toBeUndefined();
  });

  it("aggregates toolCounts and deduplicated filesTouched", () => {
    expect(parsed.toolCounts).toEqual({ Read: 1, Write: 1, Edit: 1, Bash: 1 });
    expect(parsed.filesTouched).toEqual([
      "/home/dev/acme-webapp/src/router.ts",
      "/home/dev/acme-webapp/src/routes/health.ts",
    ]);
  });

  it("elides tool_result payloads to a status marker turn, never storing the raw payload", () => {
    const toolResults = parsed.turns.filter((t) => t.kind === "tool_result");
    expect(toolResults).toHaveLength(4);
    for (const t of toolResults) {
      expect(t.text).toMatch(/^\[tool_result elided: (ok|error)\]$/);
    }
    expect(toolResults.map((t) => t.text)).toEqual([
      "[tool_result elided: ok]", // Read
      "[tool_result elided: error]", // Write
      "[tool_result elided: ok]", // Edit
      "[tool_result elided: ok]", // Bash
    ]);
    // Never leak the raw payload strings that were in the fixture's tool_result content.
    const allText = parsed.turns.map((t) => t.text ?? "").join("\n");
    expect(allText).not.toContain("...file contents...");
    expect(allText).not.toContain("permission denied");
    expect(allText).not.toContain("All tests passed");
  });

  it("drops sidechain (sub-agent) lines entirely, for both roles", () => {
    const allText = parsed.turns.map((t) => t.text ?? "").join("\n");
    expect(allText).not.toContain("Sub-agent");
    expect(parsed.toolCounts.unknown).toBeUndefined();
  });

  it("ignores unknown event types (mode, summary, queue-operation) without crashing", () => {
    // 24 lines in the fixture; only 13 produce turns. The `summary`/`queue-operation`/
    // `mode` lines are silently ignored, and parsing did not throw.
    expect(parsed.turns).toHaveLength(13);
  });

  it("preserves overall turn ordering via idx", () => {
    parsed.turns.forEach((t, i) => expect(t.idx).toBe(i));
    const kinds = parsed.turns.map((t) => `${t.role}:${t.kind}`);
    expect(kinds).toEqual([
      "user:prose",
      "assistant:thinking",
      "assistant:prose",
      "assistant:tool_use",
      "assistant:tool_use",
      "user:tool_result",
      "user:tool_result",
      "assistant:prose",
      "assistant:tool_use",
      "assistant:tool_use",
      "user:tool_result",
      "user:tool_result",
      "user:prose",
    ]);
  });
});

describe("claudeCodeParser.parse — reassembly-session fixture (merge/flush edge cases)", () => {
  const ref = { source: "claude-code", sourceSessionId: "33333333-3333-4333-8333-333333333333", path: "n/a" };
  const parsed = claudeCodeParser.parse(ref, readFixture("reassembly-session.jsonl"));

  it("does not emit a turn for an empty thinking block, but keeps merging with the next block", () => {
    const thinkingTurns = parsed.turns.filter((t) => t.kind === "thinking");
    expect(thinkingTurns.map((t) => t.text)).toEqual(["Real thinking content.", "After tool call."]);
  });

  it("merges consecutive text blocks sharing message.id into one prose turn", () => {
    const proseTurns = parsed.turns.filter((t) => t.kind === "prose" && t.role === "assistant");
    expect(proseTurns).toHaveLength(1);
    expect(proseTurns[0].text).toBe("Part one.\n\nPart two.");
  });

  it("flushes the pending merge run when a tool_use block interrupts it, and starts a fresh run after", () => {
    const kinds = parsed.turns.map((t) => `${t.role}:${t.kind}`);
    expect(kinds).toEqual([
      "assistant:thinking",
      "assistant:prose",
      "assistant:tool_use",
      "assistant:thinking",
      "user:prose",
    ]);
  });
});

describe("claudeCodeParser.parse — usage-session fixture (ADR 0026 D1/D2/D4/D10)", () => {
  const ref = { source: "claude-code", sourceSessionId: "44444444-4444-4444-8444-444444444444", path: "n/a" };
  const parsed = claudeCodeParser.parse(ref, readFixture("usage-session.jsonl"));
  const toolUses = parsed.turns.filter((t) => t.kind === "tool_use");
  const byToolUseId = Object.fromEntries(toolUses.map((t) => [t.toolUseId, t]));

  it("sums four-bucket usage once per distinct message.id, not once per JSONL line (D4)", () => {
    // msg_a's usage {100,50,5000,200} appears on BOTH its lines (text + tool_use) —
    // must be counted once, not twice.
    expect(parsed.usage).toEqual({
      inputTokens: 100 + 40 + 10 + 10 + 5 + 8,
      outputTokens: 50 + 20 + 5 + 5 + 2 + 3,
      cacheReadInputTokens: 5000 + 1000 + 100 + 100,
      cacheCreationInputTokens: 200 + 10,
    });
  });

  it("collects distinct models, excluding the <synthetic> sentinel (D4)", () => {
    expect(parsed.models).toEqual(["codehub-model-1", "codehub-model-2"]);
  });

  it("W11/D12: `model` (last-seen) also skips the <synthetic> sentinel, even when it is the LAST assistant message", () => {
    // Regression for the bug where `model` (unlike `modelsSeen`) took the raw
    // last `message.model` including "<synthetic>" — this fixture's own last
    // assistant message (msg_f) happens to be non-synthetic, so it can't
    // exercise the bug; build a session where the synthetic message is last.
    const ref2 = { source: "claude-code", sourceSessionId: "syn-last-session", path: "n/a" };
    const raw = [
      JSON.stringify({
        type: "assistant",
        message: { id: "msg_x", role: "assistant", model: "codehub-model-1", content: [{ type: "text", text: "hi" }] },
        timestamp: "2026-02-01T00:00:01.000Z",
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          id: "msg_y",
          role: "assistant",
          model: "<synthetic>",
          content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "echo hi" } }],
        },
        timestamp: "2026-02-01T00:00:02.000Z",
      }),
    ].join("\n");
    const parsedSynLast = claudeCodeParser.parse(ref2, raw);
    expect(parsedSynLast.model).toBe("codehub-model-1");
    expect(parsedSynLast.models).toEqual(["codehub-model-1"]);
  });

  it("takes created-vs-edited from toolUseResult.type, never the tool name (D1)", () => {
    expect(byToolUseId.toolu_write1.resultType).toBe("create");
    expect(byToolUseId.toolu_write1.editHunks).toBeUndefined();
    expect(byToolUseId.toolu_edit1.resultType).toBe("update");
    expect(byToolUseId.toolu_edit1.editHunks).toBe(3);
  });

  it("keys the Tool node source on attributionMcpServer/attributionMcpTool when present (D2)", () => {
    expect(byToolUseId.toolu_mcp1.mcpServer).toBe("codehub-browser");
    expect(byToolUseId.toolu_mcp1.mcpTool).toBe("computer");
    expect(byToolUseId.toolu_mcp1.toolName).toBe("mcp__codehub-browser__computer");
  });

  it("digests only allowlisted tool inputs — gh/git Bash commands and Agent descriptions (D10)", () => {
    // The command stays readable; the commit message itself is free text and is not stored (F9).
    expect(byToolUseId.toolu_bash_git.inputDigest).toBe("git commit -m ‹text›");
    expect(byToolUseId.toolu_bash_rm.inputDigest).toBeUndefined();
    expect(byToolUseId.toolu_agent1.inputDigest).toBe("Investigate the flaky checkout test root cause");
  });
});

describe("claudeCodeParser.parse — a git commit call proven to have done nothing (R-5/R-3)", () => {
  // Trimmed from a real transcript (ids omitted): a
  // pre-commit hook rejects a direct commit to main. is_error is true and
  // the text names the hook, not a bare "fatal:"/"error:" prefix.
  function session(command: string, resultText: string, isError: boolean) {
    const ref = { source: "claude-code" as const, sourceSessionId: "r5-r3-session", path: "n/a" };
    const raw = [
      JSON.stringify({
        type: "assistant",
        message: {
          id: "msg_a",
          role: "assistant",
          model: "codehub-model-1",
          content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command } }],
        },
        timestamp: "2026-09-27T22:38:20.000Z",
      }),
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_1", is_error: isError, content: resultText }],
        },
        timestamp: "2026-09-27T22:38:21.000Z",
      }),
    ].join("\n");
    return claudeCodeParser.parse(ref, raw).turns.find((t) => t.toolUseId === "toolu_1");
  }

  it("R-5: a pre-commit hook rejection (exit 1) leaves no committed action and no stale digest", () => {
    const turn = session(
      "git add README.md && git commit -q -m \"$(cat <<'EOF'\nAdd 0.3.1 changelog entry\nEOF\n)\"",
      "Exit code 1\npre-commit: direct commits to main are not allowed; use a branch",
      true,
    );
    expect(turn?.action).toBeUndefined();
    expect(turn?.actions).toBeUndefined();
    expect(turn?.inputDigest).toBeUndefined();
  });

  it("R-3: a heredoc commit that recorded nothing (`nothing to commit`) leaves no action and no stale digest", () => {
    // Trimmed from e2e2-glab S02b (session 23d1dc41…).
    const turn = session(
      "git add -A && git commit -q -m \"$(cat <<'EOF'\nFix typo in CONTRIBUTING.md for #43\nEOF\n)\"",
      "Exit code 1\nOn branch main\nnothing to commit, working tree clean",
      true,
    );
    expect(turn?.action).toBeUndefined();
    expect(turn?.inputDigest).toBeUndefined();
  });

  it("keeps the digest for a Bash call that actually failed but is unrelated to a forge command", () => {
    const turn = session("rm -rf dist/", "rm: dist/: No such file or directory", true);
    expect(turn?.inputDigest).toBeUndefined(); // never allowlisted regardless
  });

  it("does not clear the digest of a successful quiet commit (no false positive)", () => {
    const turn = session(
      "git add README.md && git commit -q -m \"$(cat <<'EOF'\nAdd 0.3.1 changelog entry\nEOF\n)\"",
      "",
      false,
    );
    expect(turn?.action?.verb).toBe("committed");
    expect(turn?.inputDigest).toBeDefined();
  });
});

describe("claudeCodeParser.parse — sub-agent sidecar join (ADR 0026 D3)", () => {
  const SUBAGENTS_DIR = join(
    FIXTURES,
    "projects",
    "-home-dev-acme-webapp",
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "subagents",
  );
  const AGENT_ID = "55555555-5555-4555-8555-555555555555";

  function subAgentFile(agentId: string, hasTranscript = true) {
    return {
      agentId,
      meta: readFileSync(join(SUBAGENTS_DIR, `agent-${agentId}.meta.json`), "utf8"),
      transcript: hasTranscript ? readFileSync(join(SUBAGENTS_DIR, `agent-${agentId}.jsonl`), "utf8") : undefined,
    };
  }

  const ref = { source: "claude-code", sourceSessionId: "44444444-4444-4444-8444-444444444444", path: "n/a" };

  it("joins via meta.json's toolUseId to the spawning Agent tool_use in the main transcript", () => {
    const parsed = claudeCodeParser.parse(ref, readFixture("usage-session.jsonl"), {
      subAgents: [subAgentFile(AGENT_ID)],
    });
    expect(parsed.subAgents).toHaveLength(1);
    const sub = parsed.subAgents?.[0];
    expect(sub?.toolUseId).toBe("toolu_agent1");

    // The main-transcript Agent tool_use id set (what a coverage assertion joins against).
    const agentToolUseIds = new Set(
      parsed.turns.filter((t) => t.kind === "tool_use" && t.toolName === "Agent").map((t) => t.toolUseId),
    );
    expect(agentToolUseIds.has(sub?.toolUseId)).toBe(true);
  });

  it("takes agentType/description/spawnDepth from the meta sidecar", () => {
    const parsed = claudeCodeParser.parse(ref, readFixture("usage-session.jsonl"), {
      subAgents: [subAgentFile(AGENT_ID)],
    });
    const sub = parsed.subAgents?.[0];
    expect(sub?.agentType).toBe("general-purpose");
    expect(sub?.description).toBe("Investigate the flaky checkout test root cause");
    expect(sub?.spawnDepth).toBe(1);
    expect(sub?.isFork).toBe(false);
  });

  it("takes model from the sub-agent transcript's message.model, NOT the 42%-populated meta.model override", () => {
    const parsed = claudeCodeParser.parse(ref, readFixture("usage-session.jsonl"), {
      subAgents: [subAgentFile(AGENT_ID)],
    });
    const sub = parsed.subAgents?.[0];
    // meta.json in the fixture sets "model": "codehub-meta-override-model" —
    // the parser must ignore it and use the transcript's own message.model.
    expect(sub?.model).toBe("codehub-model-2");
    expect(sub?.model).not.toBe("codehub-meta-override-model");
  });

  it("sums the sub-agent transcript's own usage, once per distinct message.id, four buckets", () => {
    const parsed = claudeCodeParser.parse(ref, readFixture("usage-session.jsonl"), {
      subAgents: [subAgentFile(AGENT_ID)],
    });
    const sub = parsed.subAgents?.[0];
    expect(sub?.usage).toEqual({
      inputTokens: 300 + 150,
      outputTokens: 120 + 60,
      cacheReadInputTokens: 9000 + 4000,
      cacheCreationInputTokens: 50 + 10,
    });
  });

  it("tolerates a spawn record with no transcript on disk — node metadata present, tokens null, no throw", () => {
    const parsed = claudeCodeParser.parse(ref, readFixture("usage-session.jsonl"), {
      subAgents: [subAgentFile(AGENT_ID, false)],
    });
    const sub = parsed.subAgents?.[0];
    expect(sub?.agentType).toBe("general-purpose");
    expect(sub?.model).toBeUndefined();
    expect(sub?.usage).toBeUndefined();
  });

  it("tolerates a malformed meta.json without throwing", () => {
    expect(() =>
      claudeCodeParser.parse(ref, readFixture("usage-session.jsonl"), {
        subAgents: [{ agentId: "broken", meta: "{not json", transcript: undefined }],
      }),
    ).not.toThrow();
  });

  it("tolerates a meta.json whose contents parse to the literal `null` — degrades to field-absent, never throws (F1)", () => {
    let parsed: ReturnType<typeof claudeCodeParser.parse> | undefined;
    expect(() => {
      parsed = claudeCodeParser.parse(ref, readFixture("usage-session.jsonl"), {
        subAgents: [{ agentId: "null-meta", meta: "null", transcript: undefined }],
      });
    }).not.toThrow();
    expect(parsed?.subAgents).toHaveLength(1);
    const sub = parsed?.subAgents?.[0];
    expect(sub?.agentId).toBe("null-meta");
    expect(sub?.toolUseId).toBeUndefined();
    expect(sub?.agentType).toBeUndefined();
    expect(sub?.isFork).toBe(false);
  });

  it("tolerates a meta.json whose contents parse to a JSON array or number — not a usable field bag, degrades to field-absent (F1)", () => {
    for (const meta of ["[1,2,3]", "123", '"a string"', "true"]) {
      expect(() =>
        claudeCodeParser.parse(ref, readFixture("usage-session.jsonl"), {
          subAgents: [{ agentId: "weird-meta", meta, transcript: undefined }],
        }),
      ).not.toThrow();
    }
  });

  it("leaves subAgents undefined when no extras are passed (source-optional, D13)", () => {
    const parsed = claudeCodeParser.parse(ref, readFixture("usage-session.jsonl"));
    expect(parsed.subAgents).toBeUndefined();
  });
});

describe("claudeCodeParser.parseSubAgentSessions — each sub-agent becomes its own child session", () => {
  const SUBAGENTS_DIR = join(
    FIXTURES,
    "projects",
    "-home-dev-acme-webapp",
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "subagents",
  );
  const AGENT_ID = "55555555-5555-4555-8555-555555555555";
  const PARENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const file = {
    agentId: AGENT_ID,
    meta: readFileSync(join(SUBAGENTS_DIR, `agent-${AGENT_ID}.meta.json`), "utf8"),
    transcript: readFileSync(join(SUBAGENTS_DIR, `agent-${AGENT_ID}.jsonl`), "utf8"),
  };
  const ref = { source: "claude-code", sourceSessionId: PARENT_ID, path: "n/a" };
  const parent = claudeCodeParser.parse(ref, readFixture("usage-session.jsonl"), { subAgents: [file] });
  const children = claudeCodeParser.parseSubAgentSessions?.(parent, { subAgents: [file] }) ?? [];

  it("keeps the parent's subAgents metadata (backward compatible) and never puts child fields on the parent", () => {
    expect(parent.subAgents).toHaveLength(1);
    expect(parent.parentSessionId).toBeUndefined();
    expect(parent.subAgent).toBeUndefined();
  });

  it("produces one child per transcript, id `${parent}:agent-${agentId}`, linked to the parent", () => {
    expect(children).toHaveLength(1);
    const child = children[0];
    expect(child.sourceSessionId).toBe(`${PARENT_ID}:agent-${AGENT_ID}`);
    expect(child.parentSessionId).toBe(PARENT_ID);
    expect(child.source).toBe("claude-code");
  });

  it("keeps the isSidechain:true lines the main-file filter drops", () => {
    const child = children[0];
    expect(child.turns.map((t) => [t.role, t.kind, t.text ?? t.toolName])).toEqual([
      ["user", "prose", "Investigate the flaky checkout test root cause"],
      ["assistant", "prose", "Looking at the test timing."],
      ["assistant", "tool_use", "Read"],
      ["assistant", "prose", "Root cause found: a race in the setup hook."],
    ]);
    expect(child.filesTouched).toEqual(["/home/dev/acme-webapp/src/tests/health.test.ts"]);
    expect(child.startedAt).toBe("2026-02-01T00:00:12.500Z");
    // Main-file parse of the SAME sidechain lines yields nothing.
    expect(claudeCodeParser.parse(ref, file.transcript).turns).toEqual([]);
  });

  it("carries the spawn metadata (agentType, description, toolUseId, model) on the child", () => {
    const sub = children[0].subAgent;
    expect(sub?.agentType).toBe("general-purpose");
    expect(sub?.description).toBe("Investigate the flaky checkout test root cause");
    expect(sub?.toolUseId).toBe("toolu_agent1");
    expect(sub?.model).toBe("codehub-model-2");
    expect(children[0].model).toBe("codehub-model-2");
  });

  it("inherits the parent's repo when the transcript carries no cwd/branch, so it resolves to the same project", () => {
    expect(children[0].repo.path).toBe(parent.repo.path);
    expect(children[0].repo.branch).toBe(parent.repo.branch);
  });

  it("uses the child's own cwd when present and hashes each child's own bytes", () => {
    const withCwd = {
      agentId: "66666666-6666-4666-8666-666666666666",
      meta: JSON.stringify({ agentType: "Explore", toolUseId: "toolu_x" }),
      transcript: `${JSON.stringify({
        type: "user",
        isSidechain: true,
        cwd: "/home/dev/acme-webapp/worktree",
        gitBranch: "feature/x",
        timestamp: "2026-02-01T00:01:00.000Z",
        message: { role: "user", content: "look around" },
      })}\n`,
    };
    const [c] = claudeCodeParser.parseSubAgentSessions?.(parent, { subAgents: [withCwd] }) ?? [];
    expect(c.repo.path).toBe("/home/dev/acme-webapp/worktree");
    expect(c.repo.branch).toBe("feature/x");
    expect(c.contentHash).toBe(createHash("sha256").update(withCwd.transcript).digest("hex"));
  });

  it("skips a spawn with no transcript on disk (the parent's metadata still records it)", () => {
    expect(
      claudeCodeParser.parseSubAgentSessions?.(parent, { subAgents: [{ ...file, transcript: undefined }] }),
    ).toEqual([]);
    expect(claudeCodeParser.parseSubAgentSessions?.(parent)).toEqual([]);
  });
});

describe("claudeCodeParser — version-tolerance: usage/model/subagents all absent (ADR 0026 D13)", () => {
  it("produces a valid parse with null run-metadata when the source transcript has none of it", () => {
    const ref = { source: "claude-code", sourceSessionId: "22222222-2222-4222-8222-222222222222", path: "n/a" };
    // small-session.jsonl predates D4 — none of its assistant lines carry `usage`.
    const parsed = claudeCodeParser.parse(ref, readFixture("small-session.jsonl"));
    expect(parsed.usage).toBeUndefined();
    expect(parsed.subAgents).toBeUndefined();
    expect(parsed.turns.length).toBeGreaterThan(0);
  });
});

describe("claudeCodeParser.detect", () => {
  it("walks a two-level <root>/<project>/<sessionId>.jsonl tree and returns one ref per .jsonl file", async () => {
    const root = join(FIXTURES, "projects");
    const refs = await claudeCodeParser.detect(root);

    expect(refs).toHaveLength(3);
    for (const ref of refs) {
      expect(ref.source).toBe("claude-code");
      expect(ref.path.endsWith(".jsonl")).toBe(true);
    }

    const ids = refs.map((r) => r.sourceSessionId).sort();
    expect(ids).toEqual([
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    ]);
  });

  it("ignores non-.jsonl files (e.g. stray notes)", async () => {
    const root = join(FIXTURES, "projects");
    const refs = await claudeCodeParser.detect(root);
    expect(refs.some((r) => r.path.endsWith("notes.txt"))).toBe(false);
  });

  it("throws SessionRootUnreadableError for a non-existent root (2026-07-26 round 2: was silently [])", async () => {
    const missingRoot = join(FIXTURES, "does-not-exist");
    await expect(claudeCodeParser.detect(missingRoot)).rejects.toThrow(SessionRootUnreadableError);
    try {
      await claudeCodeParser.detect(missingRoot);
      expect.unreachable("detect() should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SessionRootUnreadableError);
      expect((err as SessionRootUnreadableError).root).toBe(missingRoot);
    }
  });

  it("returns an empty array for a root that EXISTS but has no project subdirectories yet (legitimately empty, not unreadable)", async () => {
    const emptyRoot = await mkdtemp(join(tmpdir(), "claude-code-detect-empty-"));
    try {
      const refs = await claudeCodeParser.detect(emptyRoot);
      expect(refs).toEqual([]);
    } finally {
      await rm(emptyRoot, { recursive: true, force: true });
    }
  });

  it("still swallows a single unreadable PROJECT subdirectory (continue) rather than failing the whole walk", async () => {
    // Root-level unreadability now throws (above); a single bad PROJECT
    // subdirectory among good ones must NOT take down the whole walk — that
    // asymmetry is the actual contract this fix relies on.
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      // Running as root (some CI/container setups) — chmod 000 doesn't
      // actually block reads, so this would false-fail; skip instead.
      return;
    }
    const root = await mkdtemp(join(tmpdir(), "claude-code-detect-partial-"));
    const badDir = join(root, "bad-project");
    try {
      const goodDir = join(root, "good-project");
      await mkdir(goodDir, { recursive: true });
      await mkdir(badDir, { recursive: true });
      await writeFile(join(goodDir, "session.jsonl"), "{}");
      await chmod(badDir, 0o000);

      const refs = await claudeCodeParser.detect(root);
      expect(refs).toHaveLength(1);
      expect(refs[0].path).toContain("good-project");
    } finally {
      await chmod(badDir, 0o755).catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  });

  it("calls onWarn once per skipped unreadable PROJECT subdirectory, while still processing other projects (round 3, Minor 2)", async () => {
    // Round 2's MAJOR 1 fixed the ROOT being unreadable with zero
    // diagnostics; this is the same bug one level down — a bad PROJECT
    // subdirectory was swallowed with NO way for the caller to know it
    // happened at all. onWarn is optional (backward compatible — see the
    // no-callback test below) but must fire exactly once per skipped dir
    // when provided.
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      return;
    }
    const root = await mkdtemp(join(tmpdir(), "claude-code-detect-onwarn-"));
    const badDir = join(root, "bad-project");
    try {
      const goodDir = join(root, "good-project");
      await mkdir(goodDir, { recursive: true });
      await mkdir(badDir, { recursive: true });
      await writeFile(join(goodDir, "session.jsonl"), "{}");
      await chmod(badDir, 0o000);

      const warnings: string[] = [];
      const refs = await claudeCodeParser.detect(root, (message) => warnings.push(message));

      expect(refs).toHaveLength(1);
      expect(refs[0].path).toContain("good-project");
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("bad-project");
    } finally {
      await chmod(badDir, 0o755).catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  });

  it("works fine with no onWarn passed at all (optional, backward compatible)", async () => {
    const root = join(FIXTURES, "projects");
    const refs = await claudeCodeParser.detect(root);
    expect(refs.length).toBeGreaterThan(0);
  });

  it("sets subAgentsDir only for a session with a <sessionId>/subagents/ sidecar directory (ADR 0026 D3)", async () => {
    const root = join(FIXTURES, "projects");
    const refs = await claudeCodeParser.detect(root);
    const byId = Object.fromEntries(refs.map((r) => [r.sourceSessionId, r]));

    expect(byId["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"].subAgentsDir).toMatch(/\/subagents$/);
    expect(byId["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"].subAgentsDir).toBeUndefined();
    expect(byId["cccccccc-cccc-4ccc-8ccc-cccccccccccc"].subAgentsDir).toBeUndefined();
  });
});

describe("claudeCodeParser.parse — assistant redaction", () => {
  const ref = { source: "claude-code", sourceSessionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", path: "n/a" };

  it("redacts secrets in assistant prose and thinking turns, not just the user spine", () => {
    const lines = [
      {
        type: "assistant",
        timestamp: "2026-01-01T00:00:00.000Z",
        message: {
          id: "msg_redact_1",
          role: "assistant",
          content: [{ type: "thinking", thinking: "I will set api_key=abcd1234efgh5678ijkl in the env." }],
        },
      },
      {
        type: "assistant",
        timestamp: "2026-01-01T00:00:01.000Z",
        message: {
          id: "msg_redact_2",
          role: "assistant",
          content: [{ type: "text", text: "Add OPENAI key sk-abcdefghijklmnop1234 to your .env file." }],
        },
      },
    ];
    const raw = lines.map((l) => JSON.stringify(l)).join("\n");
    const parsed = claudeCodeParser.parse(ref, raw);
    const thinking = parsed.turns.find((t) => t.kind === "thinking");
    const prose = parsed.turns.find((t) => t.role === "assistant" && t.kind === "prose");
    expect(thinking?.text).toBe("I will set api_key=[REDACTED] in the env.");
    expect(prose?.text).toBe("Add OPENAI key [REDACTED] to your .env file.");
  });
});

describe("claudeCodeParser.parse — 1-hour cache writes are counted apart (C-8)", () => {
  // The usage object is copied from a real Claude Code transcript (every cache write there was 1-hour).
  const usage = {
    input_tokens: 10,
    cache_creation_input_tokens: 7473,
    cache_read_input_tokens: 13689,
    output_tokens: 219,
    output_tokens_details: { thinking_tokens: 103 },
    server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
    service_tier: "standard",
    cache_creation: { ephemeral_1h_input_tokens: 7473, ephemeral_5m_input_tokens: 0 },
    speed: "standard",
  };
  const line = (id: string, u: object) =>
    JSON.stringify({
      type: "assistant",
      message: { id, role: "assistant", model: "codehub-model-1", content: [{ type: "text", text: "ok" }], usage: u },
      timestamp: "2026-09-26T10:00:00.000Z",
      sessionId: "55555555-5555-4555-8555-555555555555",
    });
  const ref = { source: "claude-code", sourceSessionId: "55555555-5555-4555-8555-555555555555", path: "n/a" };

  it("sums ephemeral_1h_input_tokens into cacheCreation1hInputTokens, once per message id", () => {
    const raw = [line("msg_1", usage), line("msg_1", usage), line("msg_2", usage)].join("\n");
    expect(claudeCodeParser.parse(ref, raw).usage).toEqual({
      inputTokens: 20,
      outputTokens: 438,
      cacheReadInputTokens: 27378,
      cacheCreationInputTokens: 14946,
      cacheCreation1hInputTokens: 14946,
    });
  });

  it("a transcript without the split carries no 1-hour field", () => {
    const { cache_creation: _omit, ...old } = usage;
    expect(claudeCodeParser.parse(ref, line("msg_1", old)).usage).not.toHaveProperty("cacheCreation1hInputTokens");
  });
});

describe("claudeCodeParser.parse — user-role turns the owner did not write are marked nonOwner", () => {
  const ref = { source: "claude-code", sourceSessionId: "55555555-5555-4555-8555-555555555555", path: "n/a" };
  const parsed = claudeCodeParser.parse(ref, readFixture("non-owner-turns.jsonl"));
  const prose = parsed.turns.filter((t) => t.kind === "prose" && t.role === "user");
  const byStart = (s: string) => prose.find((t) => t.text?.startsWith(s));

  it("the owner's own prose (including a bash-mode command they typed) carries no nonOwner mark", () => {
    expect(byStart("Fix the flaky")?.nonOwner).toBeUndefined();
    expect(byStart("<bash-input>")?.nonOwner).toBeUndefined();
    expect(byStart("Now open")).toMatchObject({ action: { ref: "acme/api#41" } });
    expect(byStart("Now open")?.nonOwner).toBeUndefined();
  });

  it("a compaction summary is compact_summary — by the isCompactSummary flag, or by its opening line", () => {
    const summaries = prose.filter((t) => t.text?.startsWith("This session is being continued"));
    expect(summaries).toHaveLength(2);
    for (const s of summaries) expect(s.nonOwner).toBe("compact_summary");
    // A URL inside a summary is not the owner pasting it.
    for (const s of summaries) expect(s.action).toBeUndefined();
  });

  it("bash-mode output is shell_output and names no ref", () => {
    const out = byStart("<bash-stdout>");
    expect(out?.nonOwner).toBe("shell_output");
    expect(out?.action).toBeUndefined();
  });

  it("a non-meta caveat is caveat; a meta caveat and local-command-stdout stay skipped", () => {
    const caveats = prose.filter((t) => t.text?.startsWith("<local-command-caveat>"));
    expect(caveats.map((t) => t.nonOwner)).toEqual(["caveat"]);
    expect(byStart("<local-command-stdout>")).toBeUndefined();
  });
});

describe("claudeCodeParser — a resumed session (`claude --resume`) sums usage across every invocation", () => {
  // Trimmed from an e2e resumed transcript: three invocations appended to one
  // JSONL, each ending in a `cost-state` line whose totals are CUMULATIVE.
  // Usage must equal the last invocation's cumulative total, not an earlier one.
  const sid = "9d88d7d6-3b62-4fc0-b849-b38207c15f2a";
  let parent: string | null = null;
  let n = 0;
  const lines: string[] = [];
  const push = (o: Record<string, unknown>) => lines.push(JSON.stringify(o));
  const user = (text: string, ts: string) => {
    const uuid = `u${++n}`;
    push({
      type: "user",
      uuid,
      parentUuid: parent,
      sessionId: sid,
      timestamp: ts,
      message: { role: "user", content: text },
    });
    parent = uuid;
  };
  const assistant = (id: string, usage: [number, number, number, number], ts: string, blocks = 2) => {
    for (let b = 0; b < blocks; b++) {
      const uuid = `a${++n}`;
      push({
        type: "assistant",
        uuid,
        parentUuid: parent,
        sessionId: sid,
        timestamp: ts,
        message: {
          id,
          role: "assistant",
          model: "claude-haiku-4-5-20251001",
          content: [{ type: "text", text: `${id} block ${b}` }],
          usage: {
            input_tokens: usage[0],
            output_tokens: usage[1],
            cache_read_input_tokens: usage[2],
            cache_creation_input_tokens: usage[3],
          },
        },
      });
      parent = uuid;
    }
  };
  const costState = (usd: number) => push({ type: "cost-state", sessionId: sid, totalCostUSD: usd });
  const queue = () => push({ type: "queue-operation", operation: "enqueue", sessionId: sid });

  queue();
  user("t1", "2026-09-26T22:30:42.000Z");
  assistant("msg_t1a", [10, 331, 13689, 7672], "2026-09-26T22:30:44.000Z", 3);
  assistant("msg_t1b", [16, 569, 45705, 3618], "2026-09-26T22:30:50.000Z");
  costState(0.033);
  queue();
  user("t2", "2026-09-26T22:30:56.000Z");
  assistant("msg_t2a", [58, 1800, 184962, 3003], "2026-09-26T22:30:58.000Z");
  costState(0.0666);
  queue();
  user("t3", "2026-09-26T22:31:25.000Z");
  assistant("msg_t3a", [10, 230, 27982, 656], "2026-09-26T22:31:27.000Z");
  assistant("msg_t3b", [8, 78, 28638, 529], "2026-09-26T22:31:36.000Z");
  costState(0.0762);

  const parsed = claudeCodeParser.parse(
    { source: "claude-code", sourceSessionId: sid, path: "n/a" },
    lines.join("\n") + "\n",
  );

  it("equals the final cumulative total (t1 + t2 + t3), each message counted once", () => {
    expect(parsed.usage).toMatchObject({
      inputTokens: 102,
      outputTokens: 3008,
      cacheReadInputTokens: 300976,
      cacheCreationInputTokens: 15478,
    });
  });

  it("keeps t3's turns and ends at the last invocation", () => {
    expect(parsed.turns.filter((t) => t.role === "user").map((t) => t.text)).toEqual(["t1", "t2", "t3"]);
    expect(parsed.endedAt).toBe("2026-09-26T22:31:36.000Z");
  });
});

describe("claudeCodeParser.parse — a <pasted_content> span is kept as context, never the owner's words", () => {
  const ref = { source: "claude-code", sourceSessionId: "66666666-6666-4666-8666-666666666666", path: "n/a" };
  const line = (content: string, i: number) =>
    JSON.stringify({
      type: "user",
      message: { role: "user", content },
      timestamp: `2026-09-27T03:4${i}:00.000Z`,
      sessionId: "66666666-6666-4666-8666-666666666666",
    });
  const pasted =
    'I also see these listings\n\n<pasted_content id="c71c">\nacme/api#25\ndiscussed\nhttps://codehub.example/acme/api/-/issues/6\n</pasted_content id="c71c">\n\n, can we show more precision?';
  const stripped = (s: string) => s.replace(/<pasted_content[\s\S]*?<\/pasted_content[^>]*>/g, "PASTE");

  it("turn count and every idx are identical to the same transcript with the paste replaced by plain text", () => {
    const withPaste = claudeCodeParser.parse(ref, [line("first", 0), line(pasted, 1), line("third", 2)].join("\n"));
    const without = claudeCodeParser.parse(
      ref,
      [line("first", 0), line(stripped(pasted), 1), line("third", 2)].join("\n"),
    );
    expect(withPaste.turns.map((t) => t.idx)).toEqual(without.turns.map((t) => t.idx));
    expect(withPaste.turns).toHaveLength(3);
  });

  it("the turn keeps its full text; ownerText is the owner's own words without the paste", () => {
    const [t] = claudeCodeParser.parse(ref, line(pasted, 0)).turns;
    expect(t.text).toBe(pasted);
    expect(t.nonOwner).toBeUndefined();
    expect(t.ownerText).toContain("I also see these listings");
    expect(t.ownerText).toContain(", can we show more precision?");
    expect(t.ownerText).not.toContain("acme/api#25");
  });

  it("a forge URL inside the paste names no ref (no `paste` action) — only the owner's own words can", () => {
    expect(claudeCodeParser.parse(ref, line(pasted, 0)).turns[0].action).toBeUndefined();
    const own = claudeCodeParser.parse(ref, line("see https://codehub.example/acme/api/-/issues/6", 0)).turns;
    expect(own[0].action).toMatchObject({ ref: "acme/api#6", source: "paste" });
  });

  it("a prompt with no paste carries no ownerText and its text is unchanged", () => {
    const text = "  Fix the flaky test\n";
    const [t] = claudeCodeParser.parse(ref, line(text, 0)).turns;
    expect(t.text).toBe(text);
    expect(t.ownerText).toBeUndefined();
  });
});

describe("claudeCodeParser.parse — text a session wrote with Write/Edit/MultiEdit is kept on the tool_use turn", () => {
  const ref = { source: "claude-code", sourceSessionId: "77777777-7777-4777-8777-777777777777", path: "n/a" };
  const parsed = claudeCodeParser.parse(ref, readFixture("written-text.jsonl"));
  const toolUse = (name: string, path?: string) =>
    parsed.turns.find((t) => t.kind === "tool_use" && t.toolName === name && (!path || t.filePath === path));

  it("keeps a Write's content verbatim in the turn text, file_path unchanged", () => {
    const t = toolUse("Write", "/home/dev/codehub-api/docs/goals/queue.md");
    expect(t?.text).toBe(
      "# Queue ruling\n\nRuling: the queue worker keeps a 30 s visibility timeout; do not raise it, the retry budget depends on it.\n",
    );
  });

  it("keeps an Edit's new_string only, never its old_string", () => {
    const t = toolUse("Edit");
    expect(t?.text).toBe("Status: decided 2026-09-20.");
    expect(JSON.stringify(parsed.turns)).not.toContain("OLD-TEXT-NOT-KEPT");
  });

  it(`caps the written text at ${WRITTEN_TEXT_MAX_CHARS} chars (head kept) with a truncation marker`, () => {
    const t = toolUse("Write", "/home/dev/codehub-api/docs/notes/latency.md");
    const full = `Measured p95 enqueue latency 42 ms over the 7-day window. ${"filler line for the cap test. ".repeat(300)}`;
    expect(full.length).toBeGreaterThan(WRITTEN_TEXT_MAX_CHARS + 200);
    expect(t?.text).toBe(`${full.slice(0, WRITTEN_TEXT_MAX_CHARS)} …[+${full.length - WRITTEN_TEXT_MAX_CHARS} chars]`);
    expect(t?.text?.startsWith("Measured p95 enqueue latency 42 ms")).toBe(true);
  });

  it("joins each MultiEdit edit's new_string", () => {
    expect(toolUse("MultiEdit")?.text).toBe("const TIMEOUT_S = 30;\nconst RETRIES = 5;");
  });

  it("leaves other tools' text unset and tool_result payloads elided", () => {
    expect(toolUse("Read")?.text).toBeUndefined();
    expect(JSON.stringify(parsed.turns)).not.toContain("SECRET-RESULT-PAYLOAD");
  });
});

describe("claudeCodeParser.parse — written text is redacted, and dropped for sensitive files", () => {
  const sid = "88888888-8888-4888-8888-888888888888";
  const line = (i: number, name: string, input: Record<string, unknown>) =>
    JSON.stringify({
      cwd: "/home/dev/codehub-api",
      sessionId: sid,
      version: "2.1.3",
      type: "assistant",
      message: {
        id: `m${i}`,
        role: "assistant",
        model: "codehub-model-1",
        content: [{ type: "tool_use", id: `toolu_${i}`, name, input }],
      },
      uuid: `a-${i}`,
      timestamp: `2026-09-20T10:00:0${i}.000Z`,
    });
  const user = JSON.stringify({
    cwd: "/home/dev/codehub-api",
    sessionId: sid,
    version: "2.1.3",
    type: "user",
    message: { role: "user", content: "Write the config files." },
    uuid: "u-1",
    timestamp: "2026-09-20T10:00:00.000Z",
  });
  const jsonl = [
    user,
    line(1, "Write", {
      file_path: "/home/dev/codehub-api/deploy.sh",
      content: `STRIPE_KEY=${"sk_" + "test_000"} ./run\n`,
    }),
    line(2, "Write", { file_path: "/home/dev/codehub-api/.env.local", content: "Ruling: keep 30 s.\n" }),
    line(3, "Edit", { file_path: "/home/dev/codehub-api/certs/server.pem", old_string: "a", new_string: "b c d" }),
    line(4, "Write", { file_path: "/home/dev/codehub-api/notes.md", content: "Ruling: keep 30 s.\n" }),
    line(5, "Write", {
      file_path: "/home/dev/codehub-api/config.yml",
      content: "client_secret: abc\nauth_header: 'Authorization: Basic dTpw'\nurl: redis://:pw@cache\n",
    }),
    line(6, "Edit", {
      file_path: "/home/dev/codehub-api/big.ts",
      old_string: "x",
      new_string: `${"a".repeat(WRITTEN_TEXT_MAX_CHARS - 10)} TOKEN=abcd1234 tail`,
    }),
    line(7, "Write", { file_path: "/home/dev/codehub-api/.npmrc", content: "_auth=abc\n" }),
  ].join("\n");
  const parsed = claudeCodeParser.parse({ source: "claude-code", sourceSessionId: sid, path: "n/a" }, jsonl);
  const byPath = (p: string) => parsed.turns.find((t) => t.kind === "tool_use" && t.filePath?.endsWith(p));

  it("redacts a KEY=value env assignment in written text", () => {
    expect(byPath("deploy.sh")?.text).toBe("STRIPE_KEY=[REDACTED] ./run\n");
  });

  it("redacts config shapes (key/value, header, URL password) in written text", () => {
    expect(byPath("config.yml")?.text).toBe(
      "client_secret: [REDACTED]\nauth_header: '[REDACTED]'\nurl: redis://:[REDACTED]@cache\n",
    );
  });

  it("redacts before the cap, so a secret near the cut never leaks", () => {
    const text = byPath("big.ts")?.text ?? "";
    expect(text).not.toContain("abcd1234");
    expect(text).toContain("TOKEN=[RE");
  });

  it("stores no text for a written .npmrc", () => {
    expect(byPath(".npmrc")).toBeDefined();
    expect(byPath(".npmrc")?.text).toBeUndefined();
  });

  it("stores no text for a sensitive file, but keeps the turn and its path", () => {
    expect(byPath(".env.local")).toBeDefined();
    expect(byPath(".env.local")?.text).toBeUndefined();
    expect(byPath("server.pem")?.text).toBeUndefined();
    expect(byPath("notes.md")?.text).toBe("Ruling: keep 30 s.\n");
  });
});

describe("isSensitiveFilePath (deny-list)", () => {
  it.each([
    ".env",
    ".env.production",
    "server.pem",
    "tls.key",
    "store.p12",
    "store.pfx",
    "id_rsa",
    "id_rsa.pub",
    "id_ed25519",
    "credentials",
    "credentials.json",
    "app-secrets.yaml",
    "release.keystore",
    "secret.yaml",
    "secrets.json",
    ".npmrc",
    ".netrc",
    ".envrc",
    ".pgpass",
    "prod.tfvars",
    "terraform.tfstate",
    "service-account-ci.json",
    "kubeconfig",
    "dev-kubeconfig.yaml",
    "office.ovpn",
    "release.jks",
    ".htpasswd",
    ".git-credentials",
    "signing.asc",
    "backup.gpg",
  ])("denies %s", (base) => {
    expect(isSensitiveFilePath(`/home/dev/codehub-api/x/${base}`)).toBe(true);
  });

  it.each([
    "notes.md",
    "env.ts",
    "keys.ts",
    "queue.md",
    "environment.md",
    "secretary.md",
    "npmrc.md",
    "tfvars.ts",
  ])("allows %s", (base) => {
    expect(isSensitiveFilePath(`/home/dev/codehub-api/${base}`)).toBe(false);
  });
});
