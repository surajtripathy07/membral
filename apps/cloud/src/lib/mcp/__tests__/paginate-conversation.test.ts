import { describe, expect, it } from "vitest";
import {
  clampMaxChars,
  DEFAULT_MAX_CHARS,
  MAX_MAX_CHARS,
  MIN_MAX_CHARS,
  paginateConversation,
} from "@/lib/mcp/paginate-conversation";

const msg = (i: number, len: number) => ({
  role: i % 2 === 0 ? "user" : "assistant",
  content: `m${i}:`.padEnd(len, "x"),
  timestamp: null,
  metadata: {},
});

const convo = (sizes: number[]) => ({
  id: "conv-1",
  source: "claude",
  title: "CodeHub planning",
  messages: sizes.map((len, i) => msg(i, len)),
});

describe("paginateConversation", () => {
  it("default call on a large conversation returns the first part, next_start and a note", () => {
    const { data, note } = paginateConversation(convo(Array(35).fill(3_500)));
    expect(data.messages).toHaveLength(17);
    expect(data).toMatchObject({
      total_messages: 35,
      total_chars: 122_500,
      returned: { start: 0, end: 17 },
      next_start: 17,
    });
    expect(note).toBe(
      "Showing messages 0–16 of 35 (59,500 of 122,500 chars). Call get_conversation with start=17 for the rest.",
    );
  });

  it("continuing with next_start covers every message exactly once with no gaps", () => {
    const sizes = [100, 9_000, 4_000, 20_000, 1, 1, 7_000, 50_000, 3_000, 12_000, 600, 6_000];
    const c = convo(sizes);
    const seen: number[] = [];
    let start: number | null = 0;
    let parts = 0;
    while (start !== null) {
      const { data } = paginateConversation(c, { start, maxChars: 21_000 });
      const returned = data.returned as { start: number; end: number };
      expect(returned.start).toBe(start);
      const msgs = data.messages as { content: string }[];
      expect(msgs.length).toBe(returned.end - returned.start);
      for (const m of msgs) seen.push(Number(m.content.slice(1, m.content.indexOf(":"))));
      start = data.next_start as number | null;
      parts++;
    }
    expect(seen).toEqual(sizes.map((_, i) => i));
    expect(parts).toBeGreaterThan(1);
  });

  it("small conversation returns everything, next_start null, no note", () => {
    const c = convo([10, 20, 30]);
    const { data, note } = paginateConversation(c);
    expect(data.messages).toEqual(c.messages);
    expect(data).toMatchObject({
      total_messages: 3,
      total_chars: 60,
      returned: { start: 0, end: 3 },
      next_start: null,
    });
    expect(note).toBeNull();
  });

  it("an oversized single message is returned alone, cut to max_chars and flagged", () => {
    const { data, note } = paginateConversation(convo([12_345, 10]), { maxChars: 5_000 });
    const msgs = data.messages as Record<string, unknown>[];
    expect(msgs).toHaveLength(1);
    expect((msgs[0].content as string).length).toBe(5_000);
    expect(msgs[0].truncated).toBe(true);
    expect(msgs[0].truncation_note).toBe("Content cut to 5,000 of 12,345 chars (7,345 omitted).");
    expect(data.next_start).toBe(1);
    expect(note).toContain("start=1");
  });

  it("an oversized message after others waits for the next part, where it is returned alone", () => {
    const c = convo([100, 9_000]);
    const first = paginateConversation(c, { maxChars: 5_000 });
    expect(first.data.returned).toEqual({ start: 0, end: 1 });
    const second = paginateConversation(c, { start: 1, maxChars: 5_000 });
    expect(second.data.returned).toEqual({ start: 1, end: 2 });
    expect((second.data.messages as Record<string, unknown>[])[0].truncated).toBe(true);
    expect(second.data.next_start).toBeNull();
  });

  it("clamps max_chars to [5000, 200000] and defaults to 60000", () => {
    expect(clampMaxChars(undefined)).toBe(DEFAULT_MAX_CHARS);
    expect(clampMaxChars(1)).toBe(MIN_MAX_CHARS);
    expect(clampMaxChars(10_000_000)).toBe(MAX_MAX_CHARS);
    expect(clampMaxChars(Number.NaN)).toBe(DEFAULT_MAX_CHARS);
    expect(clampMaxChars(12_345.9)).toBe(12_345);
    const { data } = paginateConversation(convo(Array(100).fill(3_000)), { maxChars: 10_000_000 });
    expect(data.returned).toEqual({ start: 0, end: 66 });
  });

  it("negative start is treated as 0; start past the end returns no messages and a note", () => {
    const c = convo([10, 10]);
    expect(paginateConversation(c, { start: -5 }).data.returned).toEqual({ start: 0, end: 2 });
    const past = paginateConversation(c, { start: 9 });
    expect(past.data.messages).toEqual([]);
    expect(past.data.next_start).toBeNull();
    expect(past.note).toContain("past the end");
  });

  it("id-only shape (no options) keeps every other conversation field", () => {
    const c = { ...convo([10]), model: "m", metadata: { a: 1 }, created_at: null, updated_at: null };
    const { data } = paginateConversation(c);
    expect(data).toMatchObject({ id: "conv-1", source: "claude", model: "m", metadata: { a: 1 } });
  });

  it("messages without string content are sized by their JSON", () => {
    const { data } = paginateConversation({ id: "c", messages: [{ text: "hello" }] });
    expect(data.total_chars).toBe(JSON.stringify({ text: "hello" }).length);
  });
});
