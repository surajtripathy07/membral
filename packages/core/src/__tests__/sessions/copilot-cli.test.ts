import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { SessionRootUnreadableError } from "../../sessions/claude-code.js";
import { copilotCliParser } from "../../sessions/copilot-cli.js";
import { FORGE_ACTIONS_VERSION } from "../../sessions/forge-actions.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Repo-root `fixtures/sessions/copilot-cli/` laid out as a Copilot home
// (`session-state/<id>/events.jsonl`), so detect() runs on it unchanged.
// Fictional content only.
const ROOT = join(__dirname, "..", "..", "..", "..", "..", "fixtures", "sessions", "copilot-cli");
const SMALL_ID = "7c0f3a52-1d4e-4b8a-9f61-2e5d8c4b1a01";
const KILLED_ID = "9e2b7d14-5a3c-4f80-b6d2-0c1e4a7f3b02";
// Mirrors a real Copilot CLI 1.0.91 event order: auto model, hook.* lines,
// auto_mode_resolved, usage_checkpoint, then shutdown after the hooks.
const AUTO_ID = "3d8a61f0-7b2e-4c95-a4d1-5f0b9e2c7a03";

function eventsPath(id: string): string {
  return join(ROOT, "session-state", id, "events.jsonl");
}
function parseFixture(id: string) {
  return copilotCliParser.parse(
    { source: "copilot-cli", sourceSessionId: id, path: eventsPath(id) },
    readFileSync(eventsPath(id)),
  );
}

describe("copilotCliParser.detect", () => {
  const tmp = mkdtempSync(join(tmpdir(), "copilot-detect-"));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it("finds every session-state/<id>/events.jsonl under the Copilot home", async () => {
    const refs = await copilotCliParser.detect(ROOT);
    expect(refs).toEqual([
      { source: "copilot-cli", sourceSessionId: AUTO_ID, path: eventsPath(AUTO_ID) },
      { source: "copilot-cli", sourceSessionId: SMALL_ID, path: eventsPath(SMALL_ID) },
      { source: "copilot-cli", sourceSessionId: KILLED_ID, path: eventsPath(KILLED_ID) },
    ]);
  });

  it("returns [] for a Copilot home with no session-state yet", async () => {
    expect(await copilotCliParser.detect(tmp)).toEqual([]);
  });

  it("skips a session directory with no events.jsonl", async () => {
    mkdirSync(join(tmp, "session-state", "empty-dir"), { recursive: true });
    mkdirSync(join(tmp, "session-state", "real"), { recursive: true });
    writeFileSync(join(tmp, "session-state", "real", "events.jsonl"), "");
    const refs = await copilotCliParser.detect(tmp);
    expect(refs.map((r) => r.sourceSessionId)).toEqual(["real"]);
  });

  it("throws SessionRootUnreadableError when the root itself is missing", async () => {
    await expect(copilotCliParser.detect(join(tmp, "nope"))).rejects.toBeInstanceOf(SessionRootUnreadableError);
  });
});

describe("copilotCliParser.parse — small session", () => {
  const parsed = parseFixture(SMALL_ID);

  it("stamps source, id, actionsVersion, repo and time bounds", () => {
    expect(parsed.source).toBe("copilot-cli");
    expect(parsed.sourceSessionId).toBe(SMALL_ID);
    expect(parsed.actionsVersion).toBe(FORGE_ACTIONS_VERSION);
    expect(parsed.repo).toEqual({ path: "/home/dev/codehub/ledger", branch: "main" });
    expect(parsed.startedAt).toBe("2026-09-30T10:00:00.000Z");
    expect(parsed.endedAt).toBe("2026-09-30T10:01:30.000Z");
  });

  it("takes the model from the last assistant.message, not the 'auto' model_change", () => {
    expect(parsed.model).toBe("claude-sonnet-4.5");
    expect(parsed.models).toEqual(["claude-sonnet-4.5", "claude-haiku-4.5"]);
  });

  it("uses user.message content, never transformedContent", () => {
    const user = parsed.turns.filter((t) => t.role === "user" && t.kind === "prose");
    expect(user).toHaveLength(1);
    expect(user[0].text).not.toContain("current_datetime");
    expect(user[0].action).toMatchObject({ verb: "referenced", source: "paste", ref: "codehub/ledger#42" });
  });

  it("counts each tool call once (toolRequests mirror is not double-counted)", () => {
    expect(parsed.toolCounts).toEqual({ bash: 2, view: 1, edit: 1, task: 1 });
    expect(parsed.turns.filter((t) => t.kind === "tool_use")).toHaveLength(5);
    expect(parsed.turns.filter((t) => t.kind === "tool_result")).toHaveLength(5);
  });

  it("derives the branch action from the bash git command", () => {
    const checkout = parsed.turns.find((t) => t.toolUseId === "call-01");
    expect(checkout?.action).toMatchObject({ verb: "navigated", refKind: "branch", branch: "feat/csv-export" });
    expect(checkout?.inputDigest).toBe("git checkout -b feat/csv-export");
  });

  it("records file tools and the edit's hunk count", () => {
    expect(parsed.filesTouched).toEqual(["/home/dev/codehub/ledger/src/export.ts"]);
    const edit = parsed.turns.find((t) => t.toolUseId === "call-03");
    expect(edit).toMatchObject({ toolName: "edit", resultType: "update", editHunks: 1 });
  });

  it("marks a failed tool's result as an error", () => {
    const idx = parsed.turns.findIndex((t) => t.toolUseId === "call-04");
    expect(parsed.turns[idx + 1]).toMatchObject({ kind: "tool_result", text: "[tool_result elided: error]" });
  });

  it("records the sub-agent from subagent.* markers", () => {
    expect(parsed.subAgents).toEqual([
      {
        toolUseId: "call-05",
        agentId: "call-05",
        agentType: "code-review",
        description: "Reviews a change for correctness",
        spawnDepth: 1,
        model: "claude-haiku-4.5",
      },
    ]);
  });

  it("sums shutdown modelMetrics into four-bucket usage (reasoning folded into output)", () => {
    expect(parsed.usage).toEqual({
      inputTokens: 15000,
      outputTokens: 340,
      cacheReadInputTokens: 8000,
      cacheCreationInputTokens: 1500,
    });
  });
});

describe("copilotCliParser.parse — killed session (no shutdown, truncated last line)", () => {
  const parsed = parseFixture(KILLED_ID);

  it("parses what is there and leaves usage undefined", () => {
    expect(parsed.usage).toBeUndefined();
    expect(parsed.turns.map((t) => t.kind)).toEqual(["prose", "prose", "tool_use"]);
    expect(parsed.endedAt).toBe("2026-09-30T14:00:07.000Z");
  });

  it("falls back to a non-auto model_change when no assistant.message names a model", () => {
    expect(parsed.model).toBe("gpt-5-mini");
  });
});

describe("copilotCliParser.parse — malformed input", () => {
  it("never throws on garbage and falls back to the ref's id", () => {
    const parsed = copilotCliParser.parse(
      { source: "copilot-cli", sourceSessionId: "dir-id", path: "n/a" },
      'not json\n{"type":7}\n',
    );
    expect(parsed.sourceSessionId).toBe("dir-id");
    expect(parsed.turns).toEqual([]);
    expect(parsed.startedAt).toBe("");
  });
});

describe("copilotCliParser.parse — model choice", () => {
  it("takes the LAST assistant.message model, as the claude-code and opencode parsers do", () => {
    const lines = [
      { type: "assistant.message", timestamp: "2026-10-01T10:00:00Z", data: { model: "gpt-5-mini", content: "a" } },
      {
        type: "assistant.message",
        timestamp: "2026-10-01T10:01:00Z",
        data: { model: "claude-sonnet-4.5", content: "b" },
      },
    ];
    const parsed = copilotCliParser.parse(
      { source: "copilot-cli", sourceSessionId: "m", path: "n/a" },
      lines.map((l) => JSON.stringify(l)).join("\n"),
    );
    expect(parsed.model).toBe("claude-sonnet-4.5");
    expect(parsed.models).toEqual(["gpt-5-mini", "claude-sonnet-4.5"]);
  });

  const parseLines = (lines: object[]) =>
    copilotCliParser.parse(
      { source: "copilot-cli", sourceSessionId: "m", path: "n/a" },
      lines.map((l) => JSON.stringify(l)).join("\n"),
    );

  it("an 'auto' assistant model falls back to auto_mode_resolved.chosenModel before shutdown.currentModel", () => {
    const parsed = parseLines([
      { type: "session.model_change", data: { newModel: "gpt-4.1" } },
      { type: "session.auto_mode_resolved", data: { chosenModel: "gpt-5-mini" } },
      { type: "assistant.message", data: { model: "auto", content: "a" } },
      { type: "session.shutdown", data: { currentModel: "claude-haiku-4.5" } },
    ]);
    expect(parsed.model).toBe("gpt-5-mini");
    expect(parsed.models).toEqual(["gpt-5-mini"]);
  });

  it("falls back to shutdown.currentModel, then a non-auto model_change", () => {
    expect(
      parseLines([
        { type: "session.model_change", data: { newModel: "gpt-4.1" } },
        { type: "assistant.message", data: { content: "a" } },
        { type: "session.shutdown", data: { currentModel: "claude-haiku-4.5" } },
      ]).model,
    ).toBe("claude-haiku-4.5");
    expect(
      parseLines([
        { type: "session.model_change", data: { newModel: "gpt-4.1" } },
        { type: "session.shutdown", data: { currentModel: "auto" } },
      ]).model,
    ).toBe("gpt-4.1");
  });

  it("a real assistant model still wins over every fallback", () => {
    const parsed = parseLines([
      { type: "session.auto_mode_resolved", data: { chosenModel: "gpt-5-mini" } },
      { type: "assistant.message", data: { model: "mai-code-1.1-flash", content: "a" } },
      { type: "session.shutdown", data: { currentModel: "auto" } },
    ]);
    expect(parsed.model).toBe("mai-code-1.1-flash");
  });

  it("the 1.0.91-order fixture resolves auto to chosenModel and reads shutdown usage", () => {
    const parsed = copilotCliParser.parse(
      { source: "copilot-cli", sourceSessionId: AUTO_ID, path: eventsPath(AUTO_ID) },
      readFileSync(eventsPath(AUTO_ID), "utf8"),
    );
    expect(parsed.model).toBe("gpt-5-mini");
    expect(parsed.usage).toBeDefined();
    expect(parsed.turns.map((t) => t.role)).toEqual(["user", "assistant"]);
  });
});
