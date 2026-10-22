// UX W6 item 7: a new record whose normalized text (case, whitespace and a
// trailing punctuation run) equals a live stored record's, same user and
// kind, is merged by the existing conventions — never inserted as a twin:
// from another session it is dropped (dropCrossSessionDuplicates); once
// inserted, the older exact twin is retired as "duplicate" (supersedeRecords).

import { makeMemoryFakeSupabase as makeFakeSupabase } from "@membral/test-kit";
import { describe, expect, it } from "vitest";
import { dropCrossSessionDuplicates, type InsertableRecord, supersedeRecords } from "@/lib/memory/write";
import { normalizeForDedup } from "../merge";

const SAID = "Ship the retry fix before the release branch cuts";

describe("normalizeForDedup", () => {
  it("drops case, whitespace and a trailing punctuation run only", () => {
    expect(normalizeForDedup(`${SAID}.`)).toBe(
      normalizeForDedup(`  ship the  retry fix before the release branch cuts `),
    );
    expect(normalizeForDedup(`${SAID}!"`)).toBe(normalizeForDedup(SAID));
    expect(normalizeForDedup("use #12, #3")).not.toBe(normalizeForDedup("use #123"));
  });
});

describe("You said twins differing by a trailing '.'", () => {
  const live = (over: Record<string, unknown>) => ({
    user_id: "u1",
    code_project_id: "p1",
    code_session_id: "sess-old",
    kind: "preference",
    retired_at: null,
    embedding: null,
    supersedes: null,
    created_at: "2026-09-20T00:00:00Z",
    ...over,
  });

  it("dropCrossSessionDuplicates drops the new copy from another session", async () => {
    const supabase = makeFakeSupabase({ session_memories: [live({ id: "old", text: `${SAID}.` })] });
    const records = [
      { kind: "preference", text: SAID, verified: true, embedding: null, contentHash: "a" } as InsertableRecord,
    ];
    const { kept, deduped } = await dropCrossSessionDuplicates(supabase, "u1", "p1", "sess-new", records);
    expect(deduped).toBe(1);
    expect(kept).toHaveLength(0);
  });

  it("supersedeRecords retires the older twin (any session) and links the new row to it", async () => {
    const older = live({ id: "old", code_session_id: "sess-new", text: `${SAID}.` });
    const newRow = { id: "new-1", user_id: "u1", supersedes: null };
    const supabase = makeFakeSupabase({ session_memories: [older, newRow] });
    const linked = await supersedeRecords(supabase, "u1", "p1", [
      { id: "new-1", kind: "preference", text: SAID, embedding: null },
    ]);
    expect(linked).toBe(1);
    expect(newRow.supersedes).toBe("old");
    expect(older.retired_at).not.toBeNull();
  });

  it("leaves a different kind alone", async () => {
    const other = live({ id: "old", kind: "decision", text: `${SAID}.` });
    const supabase = makeFakeSupabase({ session_memories: [other] });
    const records = [
      { kind: "preference", text: SAID, verified: true, embedding: null, contentHash: "a" } as InsertableRecord,
    ];
    const { kept } = await dropCrossSessionDuplicates(supabase, "u1", "p1", "sess-new", records);
    expect(kept).toHaveLength(1);
  });
});
