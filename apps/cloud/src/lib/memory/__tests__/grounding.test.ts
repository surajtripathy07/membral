// D3 decisions A2/A3/A4 (2026-09-24): write time (merge.ts groundRecord) and
// serve time (verify.ts verifyRecords) run ONE predicate (grounding.ts), so
// the stored `verified` flag can never disagree with the render re-check.

import { makeMemoryFakeSupabase as makeFakeSupabase } from "@membral/test-kit";
import { describe, expect, it } from "vitest";
import { groundAgainstTurns } from "../grounding";
import { groundRecord } from "../merge";
import type { TurnRow } from "../render";
import type { MemoryRecordParsed } from "../schema";
import { verifyRecords } from "../verify";

function turn(idx: number, role: "user" | "assistant", text: string): TurnRow {
  return { idx, role, kind: "prose", text, tool_name: null, file_path: null, ts: null, props: {} };
}

const TURNS: TurnRow[] = [
  turn(0, "user", "please switch the cache key to include the branch name, it keeps colliding"),
  turn(1, "assistant", "I keyed the cache on repo + branch for every run so parallel branches stop colliding."),
  turn(2, "assistant", "Opened the pull request with the cache fix after the full test suite passed."),
  turn(3, "user", "I prefer “small” commits, one concern per commit, always."),
  turn(
    4,
    "assistant",
    "Don’t call the webhook handler before the raw body is read; signature checks need the raw bytes.",
  ),
  turn(5, "assistant", "CodeHub PR #42 is open for review now."),
];

function rec(over: Partial<MemoryRecordParsed> & Pick<MemoryRecordParsed, "kind" | "text">): MemoryRecordParsed {
  return {
    turn_idx: 1,
    turn_role: "assistant",
    durable: true,
    paths: [],
    scope: "project",
    confidence: 0.9,
    ...over,
  };
}

// Synthetic versions of the 11 write-vs-serve disagreement shapes.
const SHAPES: Array<{ name: string; record: MemoryRecordParsed; verified: boolean; turnIdx?: number }> = [
  {
    name: "null quote on a non-outcome",
    record: rec({ kind: "decision", text: "Cache keyed on repo and branch" }),
    verified: false,
  },
  {
    name: "short quote",
    record: rec({ kind: "decision", text: "Cache keyed on repo and branch", quote: "keyed the cache" }),
    verified: false,
  },
  {
    name: "generic quote sharing no content token",
    record: rec({
      kind: "learning",
      text: "Webhook signatures need raw bytes",
      quote: "I keyed the cache on repo + branch for every run",
    }),
    verified: false,
  },
  {
    name: "verbatim quote cited at the wrong turn",
    record: rec({
      kind: "decision",
      text: "Cache keyed on repo and branch for every run",
      quote: "keyed the cache on repo + branch for every run so parallel branches stop colliding",
      turn_idx: 0,
    }),
    verified: true,
    turnIdx: 1,
  },
  {
    name: "straight apostrophe + case vs curly source",
    record: rec({
      kind: "learning",
      text: "Webhook signature checks need the raw body bytes",
      quote: "don't call the webhook handler before the raw body is read",
      turn_idx: 4,
    }),
    verified: true,
    turnIdx: 4,
  },
  {
    name: "straight double quotes vs curly source on a preference",
    record: rec({
      kind: "preference",
      text: "Small commits, one concern each",
      quote: 'I prefer "small" commits, one concern per commit',
      turn_idx: 3,
      turn_role: "user",
    }),
    verified: true,
    turnIdx: 3,
  },
  {
    name: "outcome ref found in a later turn than the quote",
    record: rec({
      kind: "outcome",
      text: "Opened the cache fix pull request",
      quote: "Opened the pull request with the cache fix",
      ref: "#42",
      turn_idx: 2,
    }),
    verified: true,
    turnIdx: 2,
  },
  {
    name: "outcome ref absent from the whole session",
    record: rec({
      kind: "outcome",
      text: "Opened the cache fix pull request",
      quote: "Opened the pull request with the cache fix",
      ref: "#977",
      turn_idx: 2,
    }),
    verified: false,
  },
  {
    name: "quote-less outcome grounds on the turn holding its ref",
    record: rec({ kind: "outcome", text: "PR opened", ref: "#42", turn_idx: 2 }),
    verified: true,
    turnIdx: 5,
  },
  {
    name: "paraphrased quote",
    record: rec({
      kind: "decision",
      text: "Cache keyed on repo and branch",
      quote: "we changed the cache key so it now includes the branch name too",
    }),
    verified: false,
  },
  {
    name: "dangling turn_idx with a verbatim quote elsewhere",
    record: rec({
      kind: "learning",
      text: "Webhook signature checks need the raw body bytes",
      quote: "the raw body is read; signature checks need the raw bytes",
      turn_idx: 99,
    }),
    verified: true,
    turnIdx: 4,
  },
];

describe("shared grounding predicate (D3 A2): write == serve", () => {
  it.each(SHAPES)("$name", async ({ record, verified, turnIdx }) => {
    const written = groundRecord(record, TURNS, "memory-extract-v6", 0);
    expect(written).not.toBeNull();
    expect(written?.verified).toBe(verified);
    if (turnIdx !== undefined) expect(written?.turn_idx).toBe(turnIdx);

    const supabase = makeFakeSupabase({
      code_session_turns: TURNS.map((t) => ({
        session_id: "s1",
        idx: t.idx,
        role: t.role,
        text: t.text,
        props: t.props,
      })),
    });
    const served = await verifyRecords(supabase, [
      {
        id: "r1",
        code_session_id: "s1",
        turn_idx: record.turn_idx,
        kind: record.kind,
        text: record.text,
        quote: record.quote ?? null,
        ref: record.ref ?? null,
      },
    ]);
    expect(served.get("r1")?.verified).toBe(written?.verified);
    if (verified) expect(served.get("r1")?.turn_idx).toBe(written?.turn_idx);
  });

  it("an unverified write carries the failure reason for retire_reason", () => {
    const written = groundRecord(SHAPES[1].record, TURNS, "memory-extract-v6", 0);
    expect(written?.unverifiedReason).toBe("quote_not_specific");
    expect(groundRecord(SHAPES[0].record, TURNS, "v", 0)?.unverifiedReason).toBe("no_quote");
  });
});

describe("wrong-turn repair (D3 A3): nearest matching turn wins", () => {
  const quote = "the retry budget decays by a tenth on every success";
  const turns = [
    turn(1, "assistant", `First: ${quote}.`),
    turn(4, "assistant", "unrelated filler"),
    turn(5, "assistant", `Again: ${quote}.`),
    turn(7, "assistant", `And once more: ${quote}.`),
  ];
  const input = { kind: "learning" as const, text: "Retry budget decays on every success", quote, ref: null };

  it("picks the closest other turn, not the first one in the session", () => {
    expect(groundAgainstTurns({ ...input, turn_idx: 4 }, turns)).toMatchObject({ verified: true, turn_idx: 5 });
  });

  it("breaks a distance tie toward the earlier turn", () => {
    expect(groundAgainstTurns({ ...input, turn_idx: 6 }, turns)).toMatchObject({ verified: true, turn_idx: 5 });
  });

  it("keeps the cited turn when it matches", () => {
    expect(groundAgainstTurns({ ...input, turn_idx: 7 }, turns)).toMatchObject({ verified: true, turn_idx: 7 });
  });
});

describe("outcome ref anywhere in the session (D3 A4)", () => {
  it("verifies when the ref is only in another turn, keeping the quote's turn as the receipt", () => {
    const result = groundAgainstTurns(
      {
        kind: "outcome",
        text: "Opened the cache fix pull request",
        quote: "Opened the pull request with the cache fix",
        ref: "#42",
        turn_idx: 2,
      },
      TURNS,
    );
    expect(result).toMatchObject({ verified: true, turn_idx: 2, reason: null });
  });

  it("fails with ref_not_found when no turn carries the ref", () => {
    const result = groundAgainstTurns(
      {
        kind: "outcome",
        text: "Opened the cache fix pull request",
        quote: "Opened the pull request with the cache fix",
        ref: "#977",
        turn_idx: 2,
      },
      TURNS,
    );
    expect(result).toMatchObject({ verified: false, reason: "ref_not_found" });
  });
});
