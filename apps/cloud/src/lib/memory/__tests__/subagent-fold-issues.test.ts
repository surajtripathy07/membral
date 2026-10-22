// S06 / D-051 B16: a sub-agent's commit and push fold into the PARENT's issue
// profile. The parent names #61 and hands the work to a sub-agent; the child
// edits, commits and pushes. The parent's own turns only discuss #61, so
// without the fold #61 stays `discussed`; with it, the parent shows the
// build rung the child reached.
import { claudeCodeParser, type RawTurn } from "@membral/core";
import { makeMemoryFakeSupabase as makeFakeSupabase } from "@membral/test-kit";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ProfileTurnInput } from "@/lib/code-sessions/profile";
import { groundSessionIssues } from "../extract";
import { fetchChildSessionsForProfile } from "../tail-capture";

// D-055: D-053 inference is OFF unless MEMBRAL_INFER_REF is set; these tests cover it switched on.
beforeAll(() => {
  vi.stubEnv("MEMBRAL_INFER_REF", "1");
});
afterAll(() => {
  vi.unstubAllEnvs();
});

const PROJECT = "codehub.example/acme/billing";
let clock = 0;
const ts = () => {
  clock += 1;
  return `2026-09-26T09:${String(Math.floor(clock / 60) % 60).padStart(2, "0")}:${String(clock % 60).padStart(2, "0")}.000Z`;
};

function user(sid: string, text: string): object {
  return {
    type: "user",
    message: { role: "user", content: text },
    cwd: "/home/dev/billing",
    timestamp: ts(),
    sessionId: sid,
  };
}
function assistant(sid: string, text: string): object {
  return {
    type: "assistant",
    message: {
      id: `msg_${sid}_${clock}`,
      role: "assistant",
      model: "codehub-model-1",
      content: [{ type: "text", text }],
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
    timestamp: ts(),
    sessionId: sid,
  };
}
let seq = 0;
function tool(sid: string, name: string, input: Record<string, unknown>, result = "ok", id = `tu_${++seq}`): object[] {
  return [
    {
      type: "assistant",
      message: {
        id: `msg_${id}`,
        role: "assistant",
        model: "codehub-model-1",
        content: [{ type: "tool_use", id, name, input }],
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
      timestamp: ts(),
      sessionId: sid,
    },
    {
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: false, content: result }] },
      toolUseResult: { stdout: result },
      timestamp: ts(),
      sessionId: sid,
    },
  ];
}
const bash = (sid: string, command: string, result = "") => tool(sid, "Bash", { command, description: "run" }, result);

type Turn = ProfileTurnInput & { text: string | null };
function turnsOf(sid: string, events: object[]): Turn[] {
  const s = claudeCodeParser.parse(
    { source: "claude-code", sourceSessionId: sid, path: "n/a" },
    `${events.map((e) => JSON.stringify(e)).join("\n")}\n`,
  );
  return s.turns.map((t: RawTurn) => ({
    idx: t.idx,
    role: t.role,
    kind: t.kind,
    tool_name: t.toolName ?? null,
    file_path: t.filePath ?? null,
    text: t.text ?? null,
    props: { toolUseId: t.toolUseId, action: t.action, actions: t.actions, inputDigest: t.inputDigest },
  }));
}

const PARENT = "parent-1";
const CHILD = "child-1";
const parent = turnsOf(PARENT, [
  user(PARENT, "For #61, add the CI badge link at the top of README.md"),
  ...tool(
    PARENT,
    "Agent",
    { description: "add the badge", prompt: "add the CI badge to README.md, commit, push" },
    "done",
    "toolu_spawn_61",
  ),
  assistant(PARENT, "The sub-agent added the badge and pushed."),
]);
const child = turnsOf(CHILD, [
  user(CHILD, "add the CI badge to README.md, commit, push"),
  ...tool(CHILD, "Edit", { file_path: "/home/dev/billing/README.md", old_string: "a", new_string: "b" }),
  ...bash(CHILD, "git commit -am 'docs: CI badge'", "[main d7e5977] docs: CI badge\n 1 file changed, 1 insertion(+)"),
  ...bash(CHILD, "git push origin main", "To codehub.example:acme/billing.git\n   a1b2c3d..d7e5977  main -> main"),
]);
const model61 = [
  {
    ref: "#61",
    kind: "issue" as const,
    evidence_quote: "For #61, add the CI badge link",
    // D-053 (prompt v13): the extractor names the developer's own line that named #61.
    mentions: [{ turn_idx: 0, quote: "For #61" }],
  },
];

describe("S06: a child session's build actions fold into the parent's issue profile (B16)", () => {
  it("the parent only discussed #61; with the child folded it shows the child's build rung", () => {
    const alone = groundSessionIssues(model61, parent, PROJECT, { actionsVersion: 1 });
    expect(alone.find((r) => r.number === 61)?.build_verb ?? null).toBeNull();

    const folded = groundSessionIssues(model61, parent, PROJECT, {
      actionsVersion: 1,
      childSessions: [{ id: CHILD, spawnToolUseId: "toolu_spawn_61", turns: child }],
    });
    const row = folded.find((r) => r.number === 61);
    expect(row?.build_verb).toBe("pushed");
    expect(row?.role).toBe("worked_on");
    // The receipt stays the parent's own line, never a child turn.
    expect(row?.evidence_quote).toBe("For #61, add the CI badge link");
  });

  it("fetchChildSessionsForProfile reads the sub-agents by the parent's source session id, with their spawn row", async () => {
    const supabase = makeFakeSupabase({
      code_sessions: [
        {
          id: "c-uuid",
          user_id: "u1",
          source: "claude-code",
          parent_source_session_id: "src-parent",
          props: { subAgent: { toolUseId: "toolu_spawn_61" } },
        },
        { id: "other", user_id: "u1", source: "claude-code", parent_source_session_id: "src-else", props: {} },
      ],
      code_session_turns: child.map((t) => ({ ...t, session_id: "c-uuid", user_id: "u1" })),
    });
    const kids = await fetchChildSessionsForProfile(supabase, "u1", {
      id: "p-uuid",
      source: "claude-code",
      source_session_id: "src-parent",
    });
    expect(kids.map((k) => [k.id, k.spawnToolUseId, k.turns.length])).toEqual([
      ["c-uuid", "toolu_spawn_61", child.length],
    ]);
  });
});
