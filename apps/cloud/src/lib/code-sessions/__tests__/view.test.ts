import { describe, expect, it } from "vitest";
import { formatAbsoluteUtc, formatRelativeDate } from "@/lib/format/dates";
import { formatDuration } from "@/lib/format/durations";
import { formatCostUsd, formatTokenCount } from "@/lib/format/numbers";
import { truncatePathLeft } from "@/lib/format/text";
import {
  buildSubAgentTree,
  type ChildSessionForMatch,
  type CodeFactEdgeRow,
  type CodeFactNodeRow,
  FILES_LIST_DEFAULT_SHOWN,
  firstLineTitle,
  groupSessionTurns,
  hasCodeSessions,
  isPulseEmpty,
  matchChildSessionsToTurns,
  parseCodeProjectRollup,
  parseSubAgentMeta,
  type RawTurnRow,
  sessionDisplayTitle,
  sessionPageTitle,
  shapeProjectFacts,
  shapeSessionFacts,
  shapeTurnRow,
  shortenSessionPath,
  type TurnRow,
  toolActivityLabel,
  toolResultStatus,
  totalTokens,
  visibleFiles,
} from "../view";

// -- Helpers to build fictional test data (CLAUDE.md: fictional fixtures) --

function makeTurn(overrides: Partial<TurnRow> = {}): TurnRow {
  return {
    idx: 0,
    role: "assistant",
    kind: "prose",
    text: null,
    tool_name: null,
    file_path: null,
    ts: "2026-01-01T00:00:00.000Z",
    toolUseId: null,
    ...overrides,
  };
}

function makeChild(overrides: Partial<ChildSessionForMatch> = {}): ChildSessionForMatch {
  return {
    id: "child-1",
    agentId: null,
    parentAgentId: null,
    agentType: "Explore",
    description: "look around",
    toolUseId: null,
    turnCount: 3,
    ...overrides,
  };
}

describe("hasCodeSessions (count gate)", () => {
  it("gates closed at zero", () => {
    expect(hasCodeSessions(0)).toBe(false);
  });
  it("gates closed on a negative count (defensive)", () => {
    expect(hasCodeSessions(-1)).toBe(false);
  });
  it("gates open at one", () => {
    expect(hasCodeSessions(1)).toBe(true);
  });
  it("gates open at many", () => {
    expect(hasCodeSessions(56)).toBe(true);
  });
});

describe("parseCodeProjectRollup", () => {
  it("returns an empty rollup (status 'pending') for null props", () => {
    expect(parseCodeProjectRollup(null)).toEqual({
      summary: "",
      what_built: "",
      key_decisions: "",
      recurring_files_tools: [],
      people: [],
      open_threads: "",
      status: "pending",
    });
  });

  it("returns an empty rollup (status 'pending') for props with no rollup key (pre-P1c synthesis, or never yet rolled up)", () => {
    expect(parseCodeProjectRollup({ portrait_dirty: true })).toEqual({
      summary: "",
      what_built: "",
      key_decisions: "",
      recurring_files_tools: [],
      people: [],
      open_threads: "",
      status: "pending",
    });
  });

  it("returns an empty rollup (status 'pending') when props is not an object", () => {
    expect(parseCodeProjectRollup("not an object")).toEqual({
      summary: "",
      what_built: "",
      key_decisions: "",
      recurring_files_tools: [],
      people: [],
      open_threads: "",
      status: "pending",
    });
    expect(parseCodeProjectRollup(undefined)).toEqual({
      summary: "",
      what_built: "",
      key_decisions: "",
      recurring_files_tools: [],
      people: [],
      open_threads: "",
      status: "pending",
    });
  });

  it("returns an empty rollup (status 'pending') when rollup itself is malformed (e.g. a string)", () => {
    expect(parseCodeProjectRollup({ rollup: "oops" })).toEqual({
      summary: "",
      what_built: "",
      key_decisions: "",
      recurring_files_tools: [],
      people: [],
      open_threads: "",
      status: "pending",
    });
  });

  it("parses a well-formed rollup, inferring status 'ok' for a legacy row with no rollup_status", () => {
    const props = {
      rollup: {
        summary: "Built a widget factory.",
        what_built: "The widget factory.",
        key_decisions: "Used TypeScript.",
        recurring_files_tools: ["src/factory.ts", "vitest"],
        people: ["Sam"],
        open_threads: "Add e2e tests.",
      },
      portrait_dirty: false,
    };
    expect(parseCodeProjectRollup(props)).toEqual({ ...props.rollup, status: "ok" });
  });

  it("passes through an explicit props.rollup_status", () => {
    const props = { rollup: { summary: "Built it." }, rollup_status: "failed" };
    expect(parseCodeProjectRollup(props).status).toBe("failed");
  });

  it("falls back field-by-field on wrong-typed values instead of throwing", () => {
    const props = {
      rollup: {
        summary: 42, // wrong type
        what_built: "The widget factory.", // correct
        key_decisions: null, // wrong type
        recurring_files_tools: "src/factory.ts", // not an array
        people: ["Sam", 7, null], // mixed-type array
        // open_threads missing entirely
      },
    };
    expect(parseCodeProjectRollup(props)).toEqual({
      summary: "",
      what_built: "The widget factory.",
      key_decisions: "",
      recurring_files_tools: [],
      people: [],
      open_threads: "",
      status: "ok",
    });
  });
});

describe("formatDuration", () => {
  it("renders null/undefined as an em dash", () => {
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(undefined)).toBe("—");
  });
  it("renders zero and negative durations as an em dash", () => {
    expect(formatDuration(0)).toBe("—");
    expect(formatDuration(-5)).toBe("—");
  });
  it("renders non-finite values as an em dash", () => {
    expect(formatDuration(Number.NaN)).toBe("—");
  });
  it("renders seconds under a minute", () => {
    expect(formatDuration(12)).toBe("12s");
    expect(formatDuration(59)).toBe("59s");
  });
  it("renders minutes", () => {
    expect(formatDuration(60)).toBe("1m");
    expect(formatDuration(150)).toBe("2m");
  });
  it("renders hours and minutes", () => {
    expect(formatDuration(3600)).toBe("1h");
    expect(formatDuration(9267)).toBe("2h 34m"); // 2h34m27s -> rounds to 2h34m
  });
  it("rounds fractional seconds", () => {
    expect(formatDuration(59.6)).toBe("1m");
  });
});

describe("sessionDisplayTitle", () => {
  it("prefers the title when set", () => {
    expect(sessionDisplayTitle({ title: "Fix the flaky test", summary: "Long summary text." })).toBe(
      "Fix the flaky test",
    );
  });
  it("falls back to summary when title is null", () => {
    expect(sessionDisplayTitle({ title: null, summary: "Fixed the parser bug." })).toBe("Fixed the parser bug.");
  });
  it("falls back to summary when title is an empty/whitespace string", () => {
    expect(sessionDisplayTitle({ title: "   ", summary: "Fixed the parser bug." })).toBe("Fixed the parser bug.");
  });
  it("truncates a long summary fallback", () => {
    const summary = "x".repeat(200);
    const result = sessionDisplayTitle({ title: null, summary });
    expect(result.length).toBe(121); // 120 chars + ellipsis
    expect(result.endsWith("…")).toBe(true);
  });
  it("falls back to a neutral placeholder when title, summary AND the first message are all missing", () => {
    expect(sessionDisplayTitle({ title: null, summary: null })).toBe("Untitled session");
    expect(sessionDisplayTitle({ title: "", summary: "" })).toBe("Untitled session");
    expect(sessionDisplayTitle({ title: null, summary: null, firstUserMessage: "   " })).toBe("Untitled session");
  });
  // D (2026-09-25): "no more Untitled session" — the first-user-message fallback tried after title and summary.
  it("falls back to the first user message when title and summary are both missing", () => {
    expect(
      sessionDisplayTitle({ title: null, summary: null, firstUserMessage: "fix the flaky test\nmore context" }),
    ).toBe("fix the flaky test");
  });
  it("prefers summary over the first user message", () => {
    expect(
      sessionDisplayTitle({ title: null, summary: "Fixed the parser bug.", firstUserMessage: "some other prompt" }),
    ).toBe("Fixed the parser bug.");
  });
});

describe("firstLineTitle", () => {
  it("returns the trimmed first line", () => {
    expect(firstLineTitle("  fix the flaky test  \nmore context on line two")).toBe("fix the flaky test");
  });
  it("returns the string as-is when at or under the char cap", () => {
    expect(firstLineTitle("short prompt")).toBe("short prompt");
  });
  it("cuts a long first line at a word boundary and adds an ellipsis", () => {
    const line = "please help me refactor the authentication module so it supports both OAuth and API key logins";
    const result = firstLineTitle(line);
    expect(result.length).toBeLessThanOrEqual(81); // <=80 chars + ellipsis
    expect(result.endsWith("…")).toBe(true);
    expect(line.startsWith(result.slice(0, -1))).toBe(true);
    expect(result.endsWith(" …")).toBe(false); // no trailing space before the ellipsis
  });
  it("cuts a single long word with no space with no word boundary to fall back on", () => {
    const line = "x".repeat(120);
    const result = firstLineTitle(line);
    expect(result).toBe(`${"x".repeat(80)}…`);
  });
  it("returns empty string for empty/whitespace-only input", () => {
    expect(firstLineTitle("")).toBe("");
    expect(firstLineTitle("   \n more")).toBe("");
  });
});

// W9 (2026-09-12 refocus goal, D9, priority issue P2): the session PAGE's
// <h1> fallback never renders summarize.ts's machine "no recorded prose"
// sentence — which can embed an absolute filesystem path — as a heading.
describe("sessionPageTitle", () => {
  it("prefers the title when set", () => {
    expect(
      sessionPageTitle({
        title: "Fix the flaky test",
        summary: null,
        gitBranch: "main",
        turnCount: 5,
        startedAt: "2026-09-12T00:00:00Z",
      }),
    ).toBe("Fix the flaky test");
  });

  it("falls back to a real, human summary when there is no title", () => {
    expect(
      sessionPageTitle({
        title: null,
        summary: "Fixed the parser bug.",
        gitBranch: "main",
        turnCount: 5,
        startedAt: "2026-09-12T00:00:00Z",
      }),
    ).toBe("Fixed the parser bug.");
  });

  it("NEVER renders the machine 'no recorded prose' sentence, even with an absolute path in it", () => {
    const summary =
      "A short session with no recorded prose. Touched 2 files: /Users/alice/repo/docs/goals/2026-09-12_x.md.";
    const result = sessionPageTitle({
      title: null,
      summary,
      gitBranch: "feature/x",
      turnCount: 2,
      startedAt: "2026-09-12T00:00:00Z",
    });
    expect(result).not.toContain("/Users/");
    expect(result).not.toContain("no recorded prose");
    expect(result).toBe("feature/x · 2 turns · 2026-09-12");
  });

  it("falls back to a path-free summary containing no branch/date info by rendering just turns+date when branch is null", () => {
    const summary = "A short session with no recorded prose.";
    const result = sessionPageTitle({
      title: null,
      summary,
      gitBranch: null,
      turnCount: 1,
      startedAt: "2026-09-12T00:00:00Z",
    });
    expect(result).toBe("1 turn · 2026-09-12");
  });

  it("falls back to Untitled session when nothing at all is available", () => {
    expect(sessionPageTitle({ title: null, summary: null, gitBranch: null, turnCount: 0, startedAt: null })).toBe(
      "Untitled session",
    );
  });
});

describe("groupSessionTurns (the user spine)", () => {
  it("returns an empty array for no turns", () => {
    expect(groupSessionTurns([])).toEqual([]);
  });

  it("opens a new group at every user/prose turn", () => {
    const turns = [
      makeTurn({ idx: 0, role: "user", kind: "prose", text: "Add a login page" }),
      makeTurn({ idx: 1, role: "assistant", kind: "tool_use", tool_name: "Write", file_path: "login.tsx" }),
      makeTurn({ idx: 2, role: "user", kind: "tool_result", text: "[tool_result elided: ok]", tool_name: "Write" }),
      makeTurn({ idx: 3, role: "assistant", kind: "prose", text: "Login page added." }),
      makeTurn({ idx: 4, role: "user", kind: "prose", text: "Now add logout" }),
      makeTurn({ idx: 5, role: "assistant", kind: "tool_use", tool_name: "Write", file_path: "logout.tsx" }),
    ];
    const groups = groupSessionTurns(turns);
    expect(groups).toHaveLength(2);
    expect(groups[0].anchor?.text).toBe("Add a login page");
    expect(groups[0].activity.map((t) => t.idx)).toEqual([1, 2, 3]);
    expect(groups[1].anchor?.text).toBe("Now add logout");
    expect(groups[1].activity.map((t) => t.idx)).toEqual([5]);
  });

  it("groups fully agent-initiated activity (no user prose at all) under a null-anchor leading group", () => {
    const turns = [
      makeTurn({ idx: 0, role: "assistant", kind: "prose", text: "Starting autonomous run." }),
      makeTurn({ idx: 1, role: "assistant", kind: "tool_use", tool_name: "Bash" }),
      makeTurn({ idx: 2, role: "user", kind: "tool_result", text: "[tool_result elided: ok]", tool_name: "Bash" }),
    ];
    const groups = groupSessionTurns(turns);
    expect(groups).toHaveLength(1);
    expect(groups[0].anchor).toBeNull();
    expect(groups[0].activity.map((t) => t.idx)).toEqual([0, 1, 2]);
  });

  it("puts pre-first-user-turn activity into its own leading group, separate from the first real user group", () => {
    const turns = [
      makeTurn({ idx: 0, role: "assistant", kind: "prose", text: "Environment check." }),
      makeTurn({ idx: 1, role: "user", kind: "prose", text: "Build the thing" }),
      makeTurn({ idx: 2, role: "assistant", kind: "tool_use", tool_name: "Edit" }),
    ];
    const groups = groupSessionTurns(turns);
    expect(groups).toHaveLength(2);
    expect(groups[0].anchor).toBeNull();
    expect(groups[0].activity.map((t) => t.idx)).toEqual([0]);
    expect(groups[1].anchor?.text).toBe("Build the thing");
    expect(groups[1].activity.map((t) => t.idx)).toEqual([2]);
  });

  it("sorts out-of-order turns by idx before grouping", () => {
    const turns = [
      makeTurn({ idx: 2, role: "assistant", kind: "tool_use", tool_name: "Bash" }),
      makeTurn({ idx: 0, role: "user", kind: "prose", text: "Do the thing" }),
      makeTurn({ idx: 1, role: "assistant", kind: "prose", text: "On it." }),
    ];
    const groups = groupSessionTurns(turns);
    expect(groups).toHaveLength(1);
    expect(groups[0].anchor?.idx).toBe(0);
    expect(groups[0].activity.map((t) => t.idx)).toEqual([1, 2]);
  });

  it("treats consecutive user/prose turns as separate consecutive groups, each with empty activity if nothing follows", () => {
    const turns = [
      makeTurn({ idx: 0, role: "user", kind: "prose", text: "First" }),
      makeTurn({ idx: 1, role: "user", kind: "prose", text: "Second" }),
    ];
    const groups = groupSessionTurns(turns);
    expect(groups).toHaveLength(2);
    expect(groups[0].activity).toEqual([]);
    expect(groups[1].anchor?.text).toBe("Second");
  });
});

describe("shapeTurnRow", () => {
  it("extracts toolUseId out of props", () => {
    const raw: RawTurnRow = {
      idx: 1,
      role: "assistant",
      kind: "tool_use",
      text: null,
      tool_name: "Task",
      file_path: null,
      ts: null,
      props: { toolUseId: "toolu_1" },
    };
    expect(shapeTurnRow(raw).toolUseId).toBe("toolu_1");
  });

  it("is null when props is missing, null, or carries no toolUseId", () => {
    const base: RawTurnRow = {
      idx: 0,
      role: "user",
      kind: "prose",
      text: "hi",
      tool_name: null,
      file_path: null,
      ts: null,
    };
    expect(shapeTurnRow(base).toolUseId).toBeNull();
    expect(shapeTurnRow({ ...base, props: null }).toolUseId).toBeNull();
    expect(shapeTurnRow({ ...base, props: { resultType: "ok" } }).toolUseId).toBeNull();
  });
});

describe("matchChildSessionsToTurns (migration 089)", () => {
  it("joins a child to the Task/Agent tool_use turn sharing its toolUseId", () => {
    const turns = [
      makeTurn({ idx: 0, role: "user", kind: "prose", text: "Explore the repo" }),
      makeTurn({ idx: 1, role: "assistant", kind: "tool_use", tool_name: "Task", toolUseId: "toolu_1" }),
      makeTurn({ idx: 2, role: "user", kind: "tool_result", tool_name: "Task" }),
    ];
    const child = makeChild({ toolUseId: "toolu_1" });
    const { byTurnIdx, unmatched } = matchChildSessionsToTurns(turns, [child]);
    expect(byTurnIdx.get(1)).toEqual(child);
    expect(unmatched).toEqual([]);
  });

  it("falls back to unmatched when toolUseId is null (opencode child) or doesn't name any turn in this session", () => {
    const turns = [makeTurn({ idx: 0, role: "assistant", kind: "tool_use", tool_name: "Task", toolUseId: "toolu_1" })];
    const noId = makeChild({ id: "c1", toolUseId: null });
    const wrongId = makeChild({ id: "c2", toolUseId: "toolu_nested" });
    const { byTurnIdx, unmatched } = matchChildSessionsToTurns(turns, [noId, wrongId]);
    expect(byTurnIdx.size).toBe(0);
    expect(unmatched).toEqual([noId, wrongId]);
  });

  it("never joins to a non-tool_use turn even if it happens to carry a matching toolUseId", () => {
    const turns = [makeTurn({ idx: 0, role: "assistant", kind: "prose", toolUseId: "toolu_1" })];
    const child = makeChild({ toolUseId: "toolu_1" });
    const { byTurnIdx, unmatched } = matchChildSessionsToTurns(turns, [child]);
    expect(byTurnIdx.size).toBe(0);
    expect(unmatched).toEqual([child]);
  });
});

describe("buildSubAgentTree (migration 089 nesting)", () => {
  it("returns every child as a root when none nest", () => {
    const a = makeChild({ id: "a" });
    const b = makeChild({ id: "b" });
    const tree = buildSubAgentTree([a, b]);
    expect(tree).toEqual([
      { child: a, children: [] },
      { child: b, children: [] },
    ]);
  });

  it("nests a child under its parentAgentId", () => {
    const parent = makeChild({ id: "p", agentId: "agent-1" });
    const nested = makeChild({ id: "n", agentId: "agent-2", parentAgentId: "agent-1" });
    const tree = buildSubAgentTree([parent, nested]);
    expect(tree).toEqual([{ child: parent, children: [{ child: nested, children: [] }] }]);
  });

  it("treats a parentAgentId that names no agent in this list as a root (the parent is elsewhere, e.g. inline-linked)", () => {
    const orphan = makeChild({ id: "o", agentId: "agent-2", parentAgentId: "agent-does-not-exist" });
    expect(buildSubAgentTree([orphan])).toEqual([{ child: orphan, children: [] }]);
  });

  it("treats a child that names itself as its own parent as a root, not an infinite self-nest", () => {
    const selfParented = makeChild({ id: "s", agentId: "agent-1", parentAgentId: "agent-1" });
    const tree = buildSubAgentTree([selfParented]);
    expect(tree).toEqual([{ child: selfParented, children: [] }]);
  });

  it("treats every member of a parentAgentId cycle as a root, and still nests a real child under one", () => {
    const a = makeChild({ id: "a", agentId: "agent-a", parentAgentId: "agent-b" });
    const b = makeChild({ id: "b", agentId: "agent-b", parentAgentId: "agent-a" });
    const c = makeChild({ id: "c", agentId: "agent-c", parentAgentId: "agent-a" });
    const tree = buildSubAgentTree([a, b, c]);
    expect(tree).toHaveLength(2);
    const byChildId = new Map(tree.map((node) => [node.child.id, node]));
    expect(byChildId.get("a")).toEqual({ child: a, children: [{ child: c, children: [] }] });
    expect(byChildId.get("b")).toEqual({ child: b, children: [] });
  });
});

describe("parseSubAgentMeta", () => {
  it("parses agentType/description/model off props.subAgent", () => {
    const meta = parseSubAgentMeta({ subAgent: { agentType: "Explore", description: "look around", model: "opus" } });
    expect(meta).toEqual({ agentType: "Explore", description: "look around", model: "opus" });
  });

  it("is null for missing/malformed props or a missing subAgent block", () => {
    expect(parseSubAgentMeta(null)).toBeNull();
    expect(parseSubAgentMeta({})).toBeNull();
    expect(parseSubAgentMeta({ subAgent: "not an object" })).toBeNull();
  });

  it("defaults each field independently when wrong-typed or absent", () => {
    expect(parseSubAgentMeta({ subAgent: { agentType: 5 } })).toEqual({
      agentType: null,
      description: null,
      model: null,
    });
  });
});

describe("toolActivityLabel", () => {
  it("renders tool name + file path when both present", () => {
    expect(toolActivityLabel(makeTurn({ tool_name: "Read", file_path: "src/index.ts" }))).toBe("Read src/index.ts");
  });
  it("renders just the tool name when there's no file path", () => {
    expect(toolActivityLabel(makeTurn({ tool_name: "Bash", file_path: null }))).toBe("Bash");
  });
  it("falls back to a neutral label when tool_name is also missing", () => {
    expect(toolActivityLabel(makeTurn({ tool_name: null, file_path: null }))).toBe("tool");
  });
});

describe("toolResultStatus", () => {
  it("classifies an ok marker", () => {
    expect(toolResultStatus(makeTurn({ text: "[tool_result elided: ok]" }))).toBe("ok");
  });
  it("classifies an error marker", () => {
    expect(toolResultStatus(makeTurn({ text: "[tool_result elided: error]" }))).toBe("error");
  });
  it("classifies unrecognized/missing text as unknown", () => {
    expect(toolResultStatus(makeTurn({ text: null }))).toBe("unknown");
    expect(toolResultStatus(makeTurn({ text: "something else entirely" }))).toBe("unknown");
  });
});

describe("formatRelativeDate", () => {
  const now = new Date("2026-07-24T12:00:00.000Z");

  it("renders null as an em dash", () => {
    expect(formatRelativeDate(null, now)).toBe("—");
  });
  it("renders an invalid date string as an em dash", () => {
    expect(formatRelativeDate("not-a-date", now)).toBe("—");
  });
  it("renders today", () => {
    expect(formatRelativeDate("2026-07-24T01:00:00.000Z", now)).toBe("today");
  });
  it("renders yesterday", () => {
    expect(formatRelativeDate("2026-07-23T01:00:00.000Z", now)).toBe("yesterday");
  });
  it("renders days ago under a week", () => {
    expect(formatRelativeDate("2026-07-20T01:00:00.000Z", now)).toBe("4d ago");
  });
  it("renders weeks ago under a month", () => {
    expect(formatRelativeDate("2026-07-01T01:00:00.000Z", now)).toBe("3w ago");
  });
  it("renders months ago under a year", () => {
    expect(formatRelativeDate("2026-02-01T01:00:00.000Z", now)).toBe("5mo ago");
  });
  it("renders years ago", () => {
    expect(formatRelativeDate("2024-01-01T01:00:00.000Z", now)).toBe("2y ago");
  });
});

describe("formatAbsoluteUtc", () => {
  // Locked to UTC getters (getUTCFullYear/getUTCHours/etc), NEVER
  // toLocaleString/toLocaleDateString — those resolve the runtime's default
  // locale/timezone, which differs between Node (SSR) and a browser
  // (hydration) and caused a live React hydration mismatch on
  // /code/[projectId]'s session-row hover title.
  it("formats an ISO instant as YYYY-MM-DD HH:mm UTC", () => {
    expect(formatAbsoluteUtc("2026-08-24T12:58:16.000Z")).toBe("2026-08-24 12:58 UTC");
  });

  it("zero-pads single-digit month/day/hour/minute", () => {
    expect(formatAbsoluteUtc("2026-01-02T03:04:00.000Z")).toBe("2026-01-02 03:04 UTC");
  });

  it("renders null as an empty string", () => {
    expect(formatAbsoluteUtc(null)).toBe("");
  });

  it("renders an invalid date string as an empty string", () => {
    expect(formatAbsoluteUtc("not-a-date")).toBe("");
  });

  it("is stable across repeated calls for the same instant (no locale/timezone drift)", () => {
    const iso = "2026-08-24T00:30:00.000Z";
    expect(formatAbsoluteUtc(iso)).toBe(formatAbsoluteUtc(iso));
  });
});

// -- Code-graph facts (GitHub issue #87) -------------------------------------

function makeFactRow(overrides: Partial<CodeFactNodeRow> = {}): CodeFactNodeRow {
  return { node_type: "file", key: "src/App.tsx", label: "src/App.tsx", session_count: 1, ...overrides };
}

describe("shapeProjectFacts", () => {
  it("returns null for an empty row set (no empty skeleton)", () => {
    expect(shapeProjectFacts([])).toBeNull();
  });

  it("splits rows by node_type into files/tools/subagents buckets", () => {
    const rows: CodeFactNodeRow[] = [
      makeFactRow({ node_type: "file", key: "src/App.tsx", label: "src/App.tsx", session_count: 3 }),
      makeFactRow({ node_type: "tool", key: "Edit", label: "Edit", session_count: 5 }),
      makeFactRow({ node_type: "subagent", key: "explore-1", label: "Explore", session_count: 2 }),
    ];
    const shaped = shapeProjectFacts(rows);
    expect(shaped).not.toBeNull();
    expect(shaped?.files.items.map((f) => f.key)).toEqual(["src/App.tsx"]);
    expect(shaped?.tools.items.map((t) => t.key)).toEqual(["Edit"]);
    expect(shaped?.subagents.items.map((s) => s.key)).toEqual(["explore-1"]);
  });

  it("recurring filter (>=2 sessions) keeps items that clearly recur, sorted by session_count desc, and flags hasRecurring", () => {
    const rows: CodeFactNodeRow[] = [
      makeFactRow({ key: "a.ts", label: "a.ts", session_count: 2 }),
      makeFactRow({ key: "b.ts", label: "b.ts", session_count: 6 }),
      makeFactRow({ key: "c.ts", label: "c.ts", session_count: 4 }),
    ];
    const shaped = shapeProjectFacts(rows);
    expect(shaped?.files.items.map((f) => f.key)).toEqual(["b.ts", "c.ts", "a.ts"]);
    expect(shaped?.files.moreCount).toBe(0);
    expect(shaped?.files.hasRecurring).toBe(true);
  });

  it("top-N backfill: when NOTHING clears the >=2 bar (fragmentation depresses every key to 1), still shows the top-N by count instead of an empty bucket, and hasRecurring is false (F4)", () => {
    const rows: CodeFactNodeRow[] = Array.from({ length: 3 }, (_, i) =>
      makeFactRow({ key: `path-${i}/App.tsx`, label: `path-${i}/App.tsx`, session_count: 1 }),
    );
    const shaped = shapeProjectFacts(rows);
    expect(shaped?.files.items).toHaveLength(3);
    expect(shaped?.files.moreCount).toBe(0);
    expect(shaped?.files.hasRecurring).toBe(false);
  });

  it("caps at 10 per list and reports the remainder as moreCount", () => {
    const rows: CodeFactNodeRow[] = Array.from({ length: 15 }, (_, i) =>
      makeFactRow({ key: `file-${i}.ts`, label: `file-${i}.ts`, session_count: 15 - i }),
    );
    const shaped = shapeProjectFacts(rows);
    expect(shaped?.files.items).toHaveLength(10);
    // 14 of the 15 rows qualify (session_count >= 2); the pool is those 14
    // (>= the display cap of 10), so moreCount is 14 - 10 = 4.
    expect(shaped?.files.moreCount).toBe(4);
    // top-10 by session_count descending
    expect(shaped?.files.items[0].key).toBe("file-0.ts");
    expect(shaped?.files.items[9].key).toBe("file-9.ts");
  });

  it("does NOT merge two distinct keys sharing the same basename (cwd fragmentation must stay visible)", () => {
    const rows: CodeFactNodeRow[] = [
      makeFactRow({ key: "/home/alice/repo/src/App.tsx", label: "/home/alice/repo/src/App.tsx", session_count: 1 }),
      makeFactRow({ key: "/home/bob/repo/src/App.tsx", label: "/home/bob/repo/src/App.tsx", session_count: 1 }),
    ];
    const shaped = shapeProjectFacts(rows);
    expect(shaped?.files.items).toHaveLength(2);
    expect(new Set(shaped?.files.items.map((f) => f.key)).size).toBe(2);
  });

  // F3 adversarial finding: getCodeProjectFacts's per-type fetch is capped
  // (40 rows), so a project with MORE matching rows than that must still
  // report the TRUE moreCount via the trueCountsByType param — never derive
  // it from the (possibly truncated) `rows` array alone.
  describe("F3: trueCountsByType drives moreCount/hasRecurring instead of the (possibly truncated) fetched rows", () => {
    it("uses the true qualifying/total counts, not the fetched row count, to compute moreCount", () => {
      // Only 10 rows were actually fetched (as if fetch-capped), but the
      // true corpus has 37 qualifying files — moreCount must reflect 37, not 10.
      const rows: CodeFactNodeRow[] = Array.from({ length: 10 }, (_, i) =>
        makeFactRow({ key: `file-${i}.ts`, label: `file-${i}.ts`, session_count: 50 - i }),
      );
      const shaped = shapeProjectFacts(rows, { file: { total: 40, qualifying: 37 } });
      expect(shaped?.files.items).toHaveLength(10);
      expect(shaped?.files.moreCount).toBe(27); // 37 qualifying - 10 shown
      expect(shaped?.files.hasRecurring).toBe(true);
    });

    it("hasRecurring is false when the true qualifying count is 0, even if items non-empty (top-N backfill)", () => {
      const rows: CodeFactNodeRow[] = [makeFactRow({ key: "a.ts", label: "a.ts", session_count: 1 })];
      const shaped = shapeProjectFacts(rows, { file: { total: 1, qualifying: 0 } });
      expect(shaped?.files.hasRecurring).toBe(false);
    });

    it("per-type trueCounts are independent — a starved type (few true rows) isn't inflated by another type's large count", () => {
      const rows: CodeFactNodeRow[] = [
        ...Array.from({ length: 10 }, (_, i) =>
          makeFactRow({ node_type: "file", key: `file-${i}.ts`, label: `file-${i}.ts`, session_count: 50 - i }),
        ),
        makeFactRow({ node_type: "subagent", key: "explore", label: "Explore", session_count: 1 }),
      ];
      const shaped = shapeProjectFacts(rows, {
        file: { total: 45, qualifying: 45 },
        subagent: { total: 1, qualifying: 0 },
      });
      expect(shaped?.files.moreCount).toBe(35); // 45 qualifying - 10 cap
      expect(shaped?.subagents.moreCount).toBe(0);
      expect(shaped?.subagents.hasRecurring).toBe(false);
    });
  });
});

// -- Session facts (GitHub issue #87) -----------------------------------------

function makeEdgeRow(overrides: Partial<CodeFactEdgeRow> = {}): CodeFactEdgeRow {
  return { rel_type: "used", weight: 1, props: {}, key: "Edit", label: "Edit", ...overrides };
}

describe("shapeSessionFacts", () => {
  it("returns null when there's no session mirror node at all", () => {
    expect(shapeSessionFacts(null)).toBeNull();
    expect(shapeSessionFacts({ sessionProps: null, edges: [] })).toBeNull();
  });

  it("returns null when the session node exists but carries nothing usable (defensive)", () => {
    expect(shapeSessionFacts({ sessionProps: {}, edges: [] })).toBeNull();
  });

  it("extracts models and usage from session node props", () => {
    const shaped = shapeSessionFacts({
      sessionProps: {
        models: ["claude-sonnet-4-5", 42, "claude-haiku"],
        usage: { inputTokens: 1000, outputTokens: 200, cacheReadInputTokens: 50, cacheCreationInputTokens: 10 },
      },
      edges: [],
    });
    expect(shaped?.models).toEqual(["claude-sonnet-4-5", "claude-haiku"]);
    expect(shaped?.usage).toEqual({
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadInputTokens: 50,
      cacheCreationInputTokens: 10,
    });
  });

  it("UX W5: never reads the mirror's stored est_cost_usd — a cost-only node shapes to nothing", () => {
    const withCost = shapeSessionFacts({
      sessionProps: { models: ["m"], est_cost_usd: { amount: 0.0231, currency: "USD", price_table_version: "v1" } },
      edges: [],
    });
    expect(withCost).toEqual({
      models: ["m"],
      usage: null,
      tools: { items: [], moreCount: 0 },
      files: { items: [], moreCount: 0 },
    });
    expect(withCost && "estCostUsd" in withCost).toBe(false);
    expect(shapeSessionFacts({ sessionProps: { est_cost_usd: { amount: 0.01 } }, edges: [] })).toBeNull();
  });

  it("tolerates a malformed usage blob (falls back to null usage, not a throw)", () => {
    const shaped = shapeSessionFacts({
      sessionProps: { models: ["m"], usage: { inputTokens: 1 } },
      edges: [],
    });
    expect(shaped?.usage).toBeNull();
    expect(shaped?.models).toEqual(["m"]);
  });

  it("shapes tool facts from 'used' edges with call counts, sorted desc", () => {
    const shaped = shapeSessionFacts({
      sessionProps: { models: ["m"] },
      edges: [
        makeEdgeRow({ rel_type: "used", key: "Read", label: "Read", weight: 3 }),
        makeEdgeRow({ rel_type: "used", key: "Edit", label: "Edit", weight: 9 }),
      ],
    });
    expect(shaped?.tools.items.map((t) => t.key)).toEqual(["Edit", "Read"]);
    expect(shaped?.tools.items[0].callCount).toBe(9);
    expect(shaped?.tools.moreCount).toBe(0);
  });

  it("shapes file facts from 'touched' edges with edit_count + created/updated, sorted desc by edit_count", () => {
    const shaped = shapeSessionFacts({
      sessionProps: { models: ["m"] },
      edges: [
        makeEdgeRow({
          rel_type: "touched",
          key: "a.ts",
          label: "a.ts",
          weight: 1,
          props: { edit_count: 1, created: false },
        }),
        makeEdgeRow({
          rel_type: "touched",
          key: "b.ts",
          label: "b.ts",
          weight: 3,
          props: { edit_count: 4, created: true },
        }),
        makeEdgeRow({ rel_type: "touched", key: "c.ts", label: "c.ts", weight: 1, props: {} }),
      ],
    });
    expect(shaped?.files.items.map((f) => f.key)).toEqual(["b.ts", "a.ts", "c.ts"]);
    expect(shaped?.files.items[0]).toEqual({ key: "b.ts", label: "b.ts", editCount: 4, created: true });
    expect(shaped?.files.items[2]).toEqual({ key: "c.ts", label: "c.ts", editCount: 0, created: null });
    expect(shaped?.files.moreCount).toBe(0);
  });

  // NEW (adversarial browser finding): a real session can touch/use well over
  // a hundred distinct files/tools (112 chips observed on one founder-1k
  // session) — both lists must cap the same way the project page's buckets do.
  it("caps tools/files at 10 chips each and reports the remainder as moreCount", () => {
    const shaped = shapeSessionFacts({
      sessionProps: { models: ["m"] },
      edges: [
        ...Array.from({ length: 15 }, (_, i) =>
          makeEdgeRow({ rel_type: "used", key: `tool-${i}`, label: `tool-${i}`, weight: 15 - i }),
        ),
        ...Array.from({ length: 20 }, (_, i) =>
          makeEdgeRow({
            rel_type: "touched",
            key: `file-${i}.ts`,
            label: `file-${i}.ts`,
            weight: 1,
            props: { edit_count: 20 - i },
          }),
        ),
      ],
    });
    expect(shaped?.tools.items).toHaveLength(10);
    expect(shaped?.tools.moreCount).toBe(5);
    expect(shaped?.files.items).toHaveLength(10);
    expect(shaped?.files.moreCount).toBe(10);
  });
});

describe("totalTokens / formatTokenCount / formatCostUsd", () => {
  it("totalTokens sums all four buckets, and is 0 for null usage", () => {
    expect(
      totalTokens({ inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 5, cacheCreationInputTokens: 3 }),
    ).toBe(128);
    expect(totalTokens(null)).toBe(0);
  });

  it("formatTokenCount renders compact k/M suffixes", () => {
    expect(formatTokenCount(0)).toBe("0");
    expect(formatTokenCount(500)).toBe("500");
    expect(formatTokenCount(1500)).toBe("1.5k");
    expect(formatTokenCount(2_300_000)).toBe("2.3M");
  });

  it("formatCostUsd renders a dash for null/non-finite, extra precision for sub-cent amounts", () => {
    expect(formatCostUsd(null)).toBe("—");
    expect(formatCostUsd(Number.NaN)).toBe("—");
    expect(formatCostUsd(0.0042)).toBe("$0.0042");
    expect(formatCostUsd(0.0231)).toBe("$0.0231");
    expect(formatCostUsd(1.5)).toBe("$1.50");
  });
});

// -- Pulse empty-state gate (F1 adversarial finding) -------------------------
//
// Extracted from pulse/page.tsx's inline predicate (which used to ignore
// code sessions entirely) so this logic has direct, mutation-resistant
// coverage instead of only being exercised transitively through unrelated
// tests. See pulse-content.test.tsx for the corresponding rendering-level
// proof of the inline-CTA branch this predicate unlocks.
describe("isPulseEmpty", () => {
  it("pure-conversation user (has conversations, no code sessions): NOT empty", () => {
    expect(isPulseEmpty({ recentCount: 3, codeCount: 0, censusConversations: "12" })).toBe(false);
  });

  it("truly-empty user (no conversations, no code sessions, zero census): empty", () => {
    expect(isPulseEmpty({ recentCount: 0, codeCount: 0, censusConversations: "0" })).toBe(true);
  });

  it('truly-empty user with an undefined census (defensive — ?? "0" fallback): empty', () => {
    expect(isPulseEmpty({ recentCount: 0, codeCount: 0, censusConversations: undefined })).toBe(true);
  });

  it("code-only user (no conversations, but has code sessions): NOT empty — the F1 bug this predicate fixes", () => {
    expect(isPulseEmpty({ recentCount: 0, codeCount: 4, censusConversations: "0" })).toBe(false);
  });

  it("a mutated `=== false` / always-false predicate is NOT what this locks down — sanity: the true-empty case must actually return true", () => {
    // (Documents intent for the mutation-testing pass: flipping isPulseEmpty
    // to unconditionally return `false` must fail this assertion.)
    expect(isPulseEmpty({ recentCount: 0, codeCount: 0, censusConversations: "0" })).toBe(true);
  });
});

// ---- Files-touched list (maintainer product-review feedback) --------------

describe("visibleFiles", () => {
  const files = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts", "g.ts"];

  it("collapsed (expanded=false): slices to the default shown count", () => {
    expect(visibleFiles(files, false)).toEqual(["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"]);
    expect(visibleFiles(files, false).length).toBe(FILES_LIST_DEFAULT_SHOWN);
  });

  it("expanded=true: returns every file, not just the default count", () => {
    expect(visibleFiles(files, true)).toEqual(files);
  });

  it("fewer files than the default count: collapsed and expanded are identical", () => {
    const short = ["a.ts", "b.ts"];
    expect(visibleFiles(short, false)).toEqual(short);
    expect(visibleFiles(short, true)).toEqual(short);
  });

  it("empty list: both states return empty", () => {
    expect(visibleFiles([], false)).toEqual([]);
    expect(visibleFiles([], true)).toEqual([]);
  });

  it("respects a custom defaultCount override", () => {
    expect(visibleFiles(files, false, 2)).toEqual(["a.ts", "b.ts"]);
  });
});

describe("truncatePathLeft", () => {
  it("returns short paths unchanged", () => {
    expect(truncatePathLeft("src/App.tsx")).toBe("src/App.tsx");
  });

  it("truncates a long path from the LEFT, keeping the tail", () => {
    const long = "/Users/alice/dev/some-monorepo/packages/app/src/components/very/deep/health.test.ts";
    const result = truncatePathLeft(long, 30);
    expect(result.length).toBe(30);
    expect(result.startsWith("…")).toBe(true);
    // The tail (the informative, distinguishing part of the path) survives.
    expect(result.endsWith("health.test.ts")).toBe(true);
    // The uninformative shared-prefix directories are what got dropped.
    expect(result).not.toContain("Users/alice");
  });

  it("respects a custom maxChars", () => {
    const long = "a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p/q/r/s/t/u/v/w/x/y/z.ts";
    expect(truncatePathLeft(long, 10).length).toBe(10);
  });
});

describe("shortenSessionPath", () => {
  it("strips the project cwd prefix -> repo-relative, group source", () => {
    expect(shortenSessionPath("/repo/src/App.tsx", "/repo")).toEqual({ display: "src/App.tsx", group: "source" });
  });

  it("path equal to cwd -> '.'", () => {
    expect(shortenSessionPath("/repo", "/repo")).toEqual({ display: ".", group: "source" });
  });

  it("tolerates a cwd with a trailing slash", () => {
    expect(shortenSessionPath("/repo/src/App.tsx", "/repo/")).toEqual({ display: "src/App.tsx", group: "source" });
  });

  it("collapses a Claude Code memory-dir path -> memory/X, group scratch", () => {
    const path = "/Users/alice/.claude/projects/-Users-alice-dev-repo/memory/MEMORY.md";
    expect(shortenSessionPath(path, "/Users/alice/dev/repo")).toEqual({
      display: "memory/MEMORY.md",
      group: "scratch",
    });
  });

  it("collapses a scratchpad path -> scratchpad/X, group scratch", () => {
    const path = "/private/tmp/claude-501/-Users-alice-dev-repo/7feaf453-8128/scratchpad/notes.md";
    expect(shortenSessionPath(path, null)).toEqual({ display: "scratchpad/notes.md", group: "scratch" });
  });

  it("no cwd given: still applies the memory/scratchpad rules", () => {
    const path = "/Users/alice/.claude/projects/foo/memory/bar.md";
    expect(shortenSessionPath(path)).toEqual({ display: "memory/bar.md", group: "scratch" });
  });

  it("fallback: an unrecognized long absolute path keeps the last 3 segments, prefixed with …/, group source", () => {
    const path = "/home/bob/other-repo/packages/app/src/deep/nested/file.ts";
    expect(shortenSessionPath(path, "/repo")).toEqual({ display: "…/deep/nested/file.ts", group: "source" });
  });

  it("a path already at or under 3 segments passes through unchanged", () => {
    expect(shortenSessionPath("src/App.tsx")).toEqual({ display: "src/App.tsx", group: "source" });
    expect(shortenSessionPath("a/b/c")).toEqual({ display: "a/b/c", group: "source" });
  });

  it("empty path -> empty display, group source (defensive)", () => {
    expect(shortenSessionPath("")).toEqual({ display: "", group: "source" });
  });
});
