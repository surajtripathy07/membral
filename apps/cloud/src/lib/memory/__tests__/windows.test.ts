import { describe, expect, it } from "vitest";
import { renderTurnLines, type TurnRow } from "../render";
import { buildWindows, WINDOW_TARGET_TOKENS } from "../windows";

function proseTurn(idx: number, role: "user" | "assistant", chars: number): TurnRow {
  return { idx, role, kind: "prose", text: "x".repeat(chars), tool_name: null, file_path: null, ts: null, props: null };
}

describe("buildWindows", () => {
  it("returns nothing for an empty turn list", () => {
    expect(buildWindows([])).toEqual([]);
  });

  it("keeps a small session in a single window", () => {
    const turns = [proseTurn(0, "user", 100), proseTurn(1, "assistant", 100)];
    const windows = buildWindows(renderTurnLines(turns));
    expect(windows).toHaveLength(1);
    expect(windows[0].turns.map((t) => t.idx)).toEqual([0, 1]);
  });

  it("splits on turn boundaries once the ~6k-token (24k-char) budget is exceeded, with a one-turn overlap (D3 decision C1: halved from 12k)", () => {
    // Each turn ~10,000 chars: two fit in a window (~20k < 24k budget), a third does not.
    const turns = [proseTurn(0, "user", 10_000), proseTurn(1, "assistant", 10_000), proseTurn(2, "user", 10_000)];
    const windows = buildWindows(renderTurnLines(turns));
    expect(windows.length).toBeGreaterThanOrEqual(2);
    // One-turn overlap: window N+1 starts at window N's last turn.
    for (let i = 1; i < windows.length; i++) {
      const prevLast = windows[i - 1].turns.at(-1)?.idx;
      const currFirst = windows[i].turns[0]?.idx;
      expect(currFirst).toBe(prevLast);
    }
    // Every original turn is covered by at least one window.
    const covered = new Set(windows.flatMap((w) => w.turns.map((t) => t.idx)));
    expect(covered).toEqual(new Set([0, 1, 2]));
  });

  it("never loops forever when a single turn's line alone exceeds the window budget, and does not overlap across it", () => {
    const turns = [proseTurn(0, "user", 30_000), proseTurn(1, "assistant", 30_000), proseTurn(2, "user", 30_000)];
    const windows = buildWindows(renderTurnLines(turns));
    expect(windows.map((w) => w.turns.map((t) => t.idx))).toEqual([[0], [1], [2]]);
  });

  it("flags containsUserProse / isToolOnly / proseDensity correctly", () => {
    const turns: TurnRow[] = [
      {
        idx: 0,
        role: "assistant",
        kind: "tool_use",
        text: null,
        tool_name: "Edit",
        file_path: "a.ts",
        ts: null,
        props: null,
      },
      {
        idx: 1,
        role: "user",
        kind: "prose",
        text: "please fix this",
        tool_name: null,
        file_path: null,
        ts: null,
        props: null,
      },
    ];
    const [window] = buildWindows(renderTurnLines(turns));
    expect(window.containsUserProse).toBe(true);
    expect(window.isToolOnly).toBe(false);
    expect(window.proseDensity).toBeGreaterThan(0);
    expect(window.proseDensity).toBeLessThan(1);
  });

  it("a tool_use turn carrying written text (Write/Edit content) makes its window not tool-only", () => {
    const turns: TurnRow[] = [
      {
        idx: 0,
        role: "assistant",
        kind: "tool_use",
        text: "Ruling: the queue worker keeps a 30 s visibility timeout.",
        tool_name: "Write",
        file_path: "docs/goals/queue.md",
        ts: null,
        props: null,
      },
      {
        idx: 1,
        role: "user",
        kind: "tool_result",
        text: "[tool_result elided: ok]",
        tool_name: null,
        file_path: null,
        ts: null,
        props: null,
      },
    ];
    expect(buildWindows(renderTurnLines(turns))[0].isToolOnly).toBe(false);
    const blank = turns.map((t) => (t.kind === "tool_use" ? { ...t, text: "   " } : t));
    expect(buildWindows(renderTurnLines(blank))[0].isToolOnly).toBe(true);
  });

  it("marks a window with only tool_use/tool_result turns as isToolOnly and containsUserProse=false", () => {
    const turns: TurnRow[] = [
      {
        idx: 0,
        role: "assistant",
        kind: "tool_use",
        text: null,
        tool_name: "Bash",
        file_path: null,
        ts: null,
        props: null,
      },
      {
        idx: 1,
        role: "user",
        kind: "tool_result",
        text: "[tool_result elided: ok]",
        tool_name: null,
        file_path: null,
        ts: null,
        props: null,
      },
    ];
    const [window] = buildWindows(renderTurnLines(turns));
    expect(window.isToolOnly).toBe(true);
    expect(window.containsUserProse).toBe(false);
  });

  it("targets 6,000 tokens per window (D3 decision C1; was 12,000)", () => {
    expect(WINDOW_TARGET_TOKENS).toBe(6_000);
  });
});
