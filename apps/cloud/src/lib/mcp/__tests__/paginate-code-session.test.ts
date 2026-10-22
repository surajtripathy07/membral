import { describe, expect, it } from "vitest";
import {
  clampWindow,
  DEFAULT_FOCUS_MAX_CHARS,
  DEFAULT_TURN_WINDOW,
  FILES_TOUCHED_CAP,
  paginateCodeSession,
  windowCodeSession,
} from "@/lib/mcp/paginate-code-session";

interface Turn {
  idx: number;
  role: string;
  kind: string;
  text: string | null;
  tool_name: string | null;
  file_path: string | null;
  ts: string | null;
}

const turn = (i: number, len: number): Turn => ({
  idx: i,
  role: "user",
  kind: "ask",
  text: `t${i}:`.padEnd(len, "x"),
  tool_name: null,
  file_path: null,
  ts: null,
});

const session = (sizes: number[], files: string[] | null = ["src/a.ts", "src/b.ts"]) => ({
  id: "sess-1",
  code_project_id: "proj-1",
  source: "claude-code",
  title: "CodeHub refactor",
  summary: "Split the importer.",
  files_touched: files,
  turns: sizes.map((len, i) => turn(i, len)),
});

describe("paginateCodeSession", () => {
  it("default call on a long session returns the first part, next_start and a note", () => {
    const { data, note } = paginateCodeSession(session(Array(35).fill(3_500)));
    expect(data.turns).toHaveLength(17);
    expect(data).toMatchObject({
      id: "sess-1",
      summary: "Split the importer.",
      files_touched: ["src/a.ts", "src/b.ts"],
      total_turns: 35,
      total_chars: 122_500,
      returned: { start: 0, end: 17 },
      next_start: 17,
    });
    expect(note).toBe(
      "Showing turns 0–16 of 35 (59,500 of 122,500 chars). Call get_code_session with start=17 for the rest.",
    );
  });

  it("continuing with next_start covers every turn exactly once; metadata on every part, files on the first only", () => {
    const sizes = [100, 9_000, 4_000, 20_000, 1, 1, 7_000, 50_000, 3_000, 12_000, 600, 6_000];
    const seen: number[] = [];
    let start: number | null = 0;
    while (start !== null) {
      const { data } = paginateCodeSession(session(sizes), { start, maxChars: 10_000 });
      expect(data.summary).toBe("Split the importer.");
      expect(data.title).toBe("CodeHub refactor");
      if (start === 0) expect(data.files_touched).toEqual(["src/a.ts", "src/b.ts"]);
      else expect(data).not.toHaveProperty("files_touched");
      for (const t of data.turns as { idx: number }[]) seen.push(t.idx);
      start = data.next_start as number | null;
    }
    expect(seen).toEqual(sizes.map((_, i) => i));
  });

  it("a small session comes back whole with next_start null and no note", () => {
    const { data, note } = paginateCodeSession(session([10, 20, 30]));
    expect(data.turns).toHaveLength(3);
    expect(data).toMatchObject({ total_turns: 3, total_chars: 60, returned: { start: 0, end: 3 }, next_start: null });
    expect(data).not.toHaveProperty("files_touched_total");
    expect(note).toBeNull();
  });

  it("a single turn larger than the budget is returned alone, cut, and flagged", () => {
    const { data } = paginateCodeSession(session([80_000, 10]));
    const turns = data.turns as { text: string; truncated?: boolean; truncation_note?: string; idx: number }[];
    expect(turns).toHaveLength(1);
    expect(turns[0].idx).toBe(0);
    expect(turns[0].text).toHaveLength(60_000);
    expect(turns[0].truncated).toBe(true);
    expect(turns[0].truncation_note).toBe("Content cut to 60,000 of 80,000 chars (20,000 omitted).");
    expect(data.next_start).toBe(1);
  });

  it("a turn with null text is sized by its JSON and kept whole", () => {
    const s = session([10]);
    s.turns.push({ ...turn(1, 0), text: null, tool_name: "Edit", file_path: "src/a.ts" });
    const { data } = paginateCodeSession(s);
    expect(data.turns).toHaveLength(2);
    expect(data.next_start).toBeNull();
  });

  it("clamps max_chars and start the same way as get_conversation", () => {
    const { data } = paginateCodeSession(session(Array(10).fill(3_500)), { start: 3, maxChars: 1 });
    expect(data.returned).toEqual({ start: 3, end: 4 });
    const past = paginateCodeSession(session([10, 10]), { start: 9 });
    expect(past.data.turns).toEqual([]);
    expect(past.note).toBe("start=9 is past the end: this session has 2 turns (indexes 0–1).");
  });

  it("files_touched is capped on the first part with counts of the rest", () => {
    const files = Array.from({ length: 450 }, (_, i) => `src/f${i}.ts`);
    const { data } = paginateCodeSession(session([10], files));
    expect(data.files_touched).toHaveLength(FILES_TOUCHED_CAP);
    expect((data.files_touched as string[])[0]).toBe("src/f0.ts");
    expect(data.files_touched_total).toBe(450);
    expect(data.files_touched_omitted).toBe(250);
  });

  it("null files_touched passes through unchanged on the first part", () => {
    const { data } = paginateCodeSession(session([10], null));
    expect(data.files_touched).toBeNull();
  });

  describe("sub-agents (migration 096)", () => {
    const subAgent = {
      id: "child-1",
      agent_type: "explore",
      description: "Survey the importer",
      started_at: "2026-09-24T10:00:00Z",
      ended_at: "2026-09-24T10:05:00Z",
      turn_count: 4,
      brief: "Find every caller of the importer",
    };

    it("a parent's sub_agents and sub_agents_total ride on the first part only", () => {
      const parent = {
        ...session(Array(35).fill(3_500)),
        parent_session_id: null,
        sub_agents: [subAgent],
        sub_agents_total: 1,
      };
      const first = paginateCodeSession(parent).data;
      expect(first.sub_agents).toEqual([subAgent]);
      expect(first.sub_agents_total).toBe(1);
      expect(first.parent_session_id).toBeNull();
      const second = paginateCodeSession(parent, { start: first.next_start as number }).data;
      expect(second).not.toHaveProperty("sub_agents");
      expect(second).not.toHaveProperty("sub_agents_total");
      expect(second.parent_session_id).toBeNull();
    });

    it("a sub-agent's parent_session_id rides on every part", () => {
      const child = {
        ...session(Array(35).fill(3_500)),
        parent_session_id: "parent-1",
        sub_agents: [],
        sub_agents_total: 0,
      };
      const first = paginateCodeSession(child).data;
      expect(first.parent_session_id).toBe("parent-1");
      expect(first.sub_agents).toEqual([]);
      const second = paginateCodeSession(child, { start: first.next_start as number }).data;
      expect(second.parent_session_id).toBe("parent-1");
    });
  });

  it("does not mutate the input session", () => {
    const s = session(
      Array(35).fill(3_500),
      Array.from({ length: 300 }, (_, i) => `f${i}`),
    );
    paginateCodeSession(s, { start: 5 });
    expect(s.turns).toHaveLength(35);
    expect(s.files_touched).toHaveLength(300);
  });
});

describe("windowCodeSession (get_code_session turn=)", () => {
  const idxs = (d: Record<string, unknown>) => (d.turns as Turn[]).map((t) => t.idx);

  it("default window is ±8 and the focus mode budget defaults to 12,000 chars", () => {
    const { data } = windowCodeSession(session(Array(60).fill(100)), { turn: 30 });
    expect(idxs(data)).toEqual(Array.from({ length: 17 }, (_, i) => 22 + i));
    expect(data.focus).toEqual({ turn: 30, window: DEFAULT_TURN_WINDOW, first_idx: 22, last_idx: 38, total_turns: 60 });
    expect(data.prev_start).toBe(5);
    expect(data.next_start).toBe(39);
    // 12,000 / 1,000 → 12 turns fit, filled outward from the focus turn.
    const cut = windowCodeSession(session(Array(60).fill(1_000)), { turn: 30 });
    expect(idxs(cut.data)).toEqual([24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35]);
    expect(DEFAULT_FOCUS_MAX_CHARS).toBe(12_000);
  });

  it("clamps the window to the session at both ends", () => {
    const head = windowCodeSession(session(Array(10).fill(10)), { turn: 1, window: 3 });
    expect(idxs(head.data)).toEqual([0, 1, 2, 3, 4]);
    expect(head.data.prev_start).toBeNull();
    expect(head.data.files_touched).toEqual(["src/a.ts", "src/b.ts"]);
    const tail = windowCodeSession(session(Array(10).fill(10)), { turn: 9, window: 3 });
    expect(idxs(tail.data)).toEqual([6, 7, 8, 9]);
    expect(tail.data.next_start).toBeNull();
    expect(tail.data).not.toHaveProperty("files_touched");
  });

  it("clamps window to 1–40", () => {
    expect(clampWindow(0)).toBe(1);
    expect(clampWindow(-5)).toBe(1);
    expect(clampWindow(99)).toBe(40);
    expect(clampWindow(undefined)).toBe(8);
    const { data } = windowCodeSession(session(Array(100).fill(10)), { turn: 50, window: 500 });
    expect((data.focus as { first_idx: number }).first_idx).toBe(10);
    expect((data.focus as { last_idx: number }).last_idx).toBe(90);
  });

  it("a turn past the end returns an empty slice with total_turns, not an error", () => {
    const { data, note } = windowCodeSession(session(Array(10).fill(10)), { turn: 10 });
    expect(data.turns).toEqual([]);
    expect(data.focus).toEqual({ turn: 10, window: 8, first_idx: null, last_idx: null, total_turns: 10 });
    expect(data.next_start).toBeNull();
    expect(note).toBe("turn=10 is past the end: this session has 10 turns (last turn 9).");
    expect(data.returned).toEqual({ start: 10, end: 10 });
  });

  it("an explicit max_chars wins (still clamped) and an oversized focus turn comes back alone, cut", () => {
    const wide = windowCodeSession(session(Array(60).fill(1_000)), { turn: 30, maxChars: 60_000 });
    expect(idxs(wide.data)).toHaveLength(17);
    const big = windowCodeSession(session([10, 9_000, 10]), { turn: 1, maxChars: 1 });
    const turns = big.data.turns as (Turn & { truncated?: boolean })[];
    expect(turns.map((t) => t.idx)).toEqual([1]);
    expect(turns[0].text).toHaveLength(5_000);
    expect(turns[0].truncated).toBe(true);
  });

  it("sparse idx with no turn in the window centres on the nearest turn (tie -> earlier) and says so", () => {
    const sparse = (ids: number[]) => ({ ...session(ids.map(() => 10)), turns: ids.map((i) => turn(i, 10)) });
    const { data, note } = windowCodeSession(sparse([0, 2, 4, 50, 52]), { turn: 30 });
    expect(idxs(data)).toEqual([50, 52]);
    expect(data.focus).toMatchObject({ turn: 30, first_idx: 50, last_idx: 52, total_turns: 5 });
    expect(data.returned).toEqual({ start: 3, end: 5 });
    expect(data.prev_start).toBe(1);
    expect(note).toContain("No turn within ±8 of turn 30; centred on the nearest, turn 50.");
    const tie = windowCodeSession(sparse([0, 20, 40]), { turn: 30, window: 2 });
    expect(idxs(tie.data)).toEqual([20]);
    const pastLast = windowCodeSession(sparse([0, 2, 50]), { turn: 51 });
    expect(pastLast.note).toBe("turn=51 is past the end: this session has 3 turns (last turn 50).");
  });

  it("does not mutate the input", () => {
    const s = session(Array(35).fill(10));
    windowCodeSession(s, { turn: 5 });
    expect(s.turns).toHaveLength(35);
  });
});
