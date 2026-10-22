// Regression tests for the fresh adversarial review of the v6 fix set
// (handoff/d3-v5/review-v6.md): one describe per finding id.

import { makeMemoryFakeSupabase as makeFakeSupabase, type Row } from "@membral/test-kit";
import { describe, expect, it } from "vitest";
import { insertMemoryRecords, REVERIFY_SCOPE_OR_FILTER } from "@/lib/memory/write";
import { type GroundingTurn, groundAgainstTurns, isSpecificRef } from "../grounding";
import {
  dedupeByContentHash,
  type EmbeddedGroundedRecord,
  type GroundedRecord,
  groundRecord,
  normalizedTextKey,
} from "../merge";
import type { TurnRow } from "../render";
import type { MemoryRecordParsed } from "../schema";
import { verifyRecords } from "../verify";

function t(idx: number, role: "user" | "assistant", text: string, digest?: string): TurnRow & GroundingTurn {
  return {
    idx,
    role,
    kind: "prose",
    text,
    tool_name: null,
    file_path: null,
    ts: null,
    props: digest ? { inputDigest: digest } : {},
  };
}

function rec(over: Partial<MemoryRecordParsed> & Pick<MemoryRecordParsed, "kind" | "text">): MemoryRecordParsed {
  return { turn_idx: 0, turn_role: "assistant", durable: true, paths: [], scope: "project", confidence: 0.9, ...over };
}

describe("B1: outcome refs match as typed whole tokens", () => {
  const turns = [t(0, "user", "ok thanks, looks good"), t(5, "assistant", "Done. The domain config is updated.")];

  it("a generic ref inside another word never grounds (reviewer probe 1)", () => {
    const r = groundAgainstTurns(
      { kind: "outcome", text: "Shipped", quote: "looks good", ref: "main", turn_idx: 3 },
      turns,
    );
    expect(r.verified).toBe(false);
    // same substring hole with a specific, correctly cited quote
    const quote = "updated the domain config for the staging environment";
    const own = [t(5, "assistant", `Done, I ${quote}.`)];
    expect(
      groundAgainstTurns({ kind: "outcome", text: "Domain config updated", quote, ref: "main", turn_idx: 5 }, own)
        .verified,
    ).toBe(false);
  });

  it("a quote-less outcome with a non-specific ref never grounds (reviewer probe 2)", () => {
    const r = groundAgainstTurns({ kind: "outcome", text: "Tagged release", quote: null, ref: "v1", turn_idx: 0 }, [
      t(9, "assistant", "Tagged v10 release notes"),
    ]);
    expect(r.verified).toBe(false);
  });

  it("a branch ref grounds only as a whole token in the quote's own turn", () => {
    const quote = "pushed the fix and opened the merge into the default branch";
    const own = [t(1, "assistant", `I ${quote}: git push origin main`)];
    const elsewhere = [t(1, "assistant", `I ${quote}.`), t(2, "assistant", "git push origin main")];
    const input = { kind: "outcome" as const, text: "Fix pushed", quote, ref: "main", turn_idx: 1 };
    expect(groundAgainstTurns(input, own).verified).toBe(true);
    expect(groundAgainstTurns(input, elsewhere).verified).toBe(false);
  });

  it("a specific ref may be anywhere: sha prefix of a full sha, #N, a whole path token (R2-m2: a path suffix only in the quote's own turn)", () => {
    const quote = "committed the cache key change after the suite went green";
    const turns2 = [
      t(1, "assistant", `I ${quote}.`),
      t(2, "assistant", "[abc1234def5678] fix cache key; see #42", "Edit apps/cloud/cache.ts"),
    ];
    for (const ref of ["abc1234", "#42", "apps/cloud/cache.ts"]) {
      expect(groundAgainstTurns({ kind: "outcome", text: "Committed", quote, ref, turn_idx: 1 }, turns2).verified).toBe(
        true,
      );
    }
    expect(
      groundAgainstTurns({ kind: "outcome", text: "Committed", quote, ref: "#4", turn_idx: 1 }, turns2).verified,
    ).toBe(false);
  });

  it("isSpecificRef accepts only URL / hex sha with a letter / #N / slash path", () => {
    expect(["https://codehub.example/pr/42", "abc1234", "#42", "apps/x.ts"].map(isSpecificRef)).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect(["main", "v1", "README.md", "1234567", "origin/main", "42"].map(isSpecificRef)).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
  });
});

describe("M2: a generic quote never moves the receipt", () => {
  const turns = [t(0, "user", "ok thanks, looks good"), t(5, "assistant", "Here is the plan, it looks good to me.")];

  it("a preference citing an assistant turn does not repair to a user turn on a generic quote (reviewer probe 3)", () => {
    const r = groundAgainstTurns(
      { kind: "preference", text: "Keep it good", quote: "looks good", ref: null, turn_idx: 5 },
      turns,
    );
    expect(r.verified).toBe(false);
    // write side: its receipt stays the assistant turn -> dropped, never stored
    expect(
      groundRecord(rec({ kind: "preference", text: "Keep it good", quote: "looks good", turn_idx: 5 }), turns, "v", 0),
    ).toBeNull();
  });

  it("an outcome's short quote at the wrong turn does not move", () => {
    const r = groundAgainstTurns({ kind: "outcome", text: "PR opened", quote: "looks good", ref: "#42", turn_idx: 7 }, [
      ...turns,
      t(7, "assistant", "Opened #42."),
    ]);
    expect(r.verified).toBe(false);
  });

  it("a preference whose quote is only on assistant turns stays unverified and is dropped at write", () => {
    const quote = "always run the linter before pushing any change to the repo";
    const onlyAssistant = [t(2, "assistant", `Noted: ${quote}.`), t(3, "assistant", `Again: ${quote}.`)];
    expect(
      groundAgainstTurns(
        { kind: "preference", text: "Run the linter before pushing", quote, ref: null, turn_idx: 2 },
        onlyAssistant,
      ).verified,
    ).toBe(false);
    expect(
      groundRecord(
        rec({ kind: "preference", text: "Run the linter before pushing", quote, turn_idx: 2 }),
        onlyAssistant,
        "v",
        0,
      ),
    ).toBeNull();
  });
});

describe("m1: a quote that normalises to almost nothing matches nothing", () => {
  it("'........' is not a receipt (reviewer probe 4)", () => {
    const r = groundAgainstTurns({ kind: "preference", text: "Anything", quote: "........", ref: null, turn_idx: 0 }, [
      t(0, "user", "use tabs"),
    ]);
    expect(r).toMatchObject({ verified: false, reason: "quote_not_found" });
  });
});

describe("m3: user-pass records ground only on user turns", () => {
  const quote = "the staging deploy is blocked until the certificate is renewed";
  const turns = [t(4, "assistant", `Heads up: ${quote}.`), t(5, "user", "ok, what next?")];

  it("a user-pass blocker quoting the assistant context line is dropped", () => {
    const blocker = rec({
      kind: "blocker",
      text: "Staging deploy blocked on certificate renewal",
      quote,
      turn_idx: 4,
      turn_role: "user",
    });
    expect(groundRecord(blocker, turns, "v", 0, { userTurnsOnly: true })).toBeNull();
    // the main pass may still keep it (assistant-stated blocker)
    expect(groundRecord(blocker, turns, "v", 0)?.verified).toBe(true);
  });

  it("a user-pass blocker quoting a user turn is kept", () => {
    const own = [t(4, "assistant", "What is blocking?"), t(5, "user", `Well, ${quote}.`)];
    const blocker = rec({
      kind: "blocker",
      text: "Staging deploy blocked on certificate renewal",
      quote,
      turn_idx: 5,
      turn_role: "user",
    });
    expect(groundRecord(blocker, own, "v", 0, { userTurnsOnly: true })).toMatchObject({
      verified: true,
      turn_role: "user",
    });
  });
});

describe("m2: normalizedTextKey keeps separators between tokens", () => {
  it("distinct issue numbers and versions stay distinct (reviewer probe 5)", () => {
    expect(normalizedTextKey("Waiting on #12, #3 to merge")).not.toBe(normalizedTextKey("Waiting on #123 to merge"));
    expect(normalizedTextKey("Pin node to 1.20")).not.toBe(normalizedTextKey("Pin node to 12.0"));
    expect(normalizedTextKey("Use zsh, not bash.")).toBe(normalizedTextKey("use ZSH   not bash"));
  });
});

function g(over: Partial<EmbeddedGroundedRecord>): EmbeddedGroundedRecord {
  return {
    windowIndex: 0,
    kind: "decision",
    text: "Cache keyed on repo and branch",
    quote: "keyed the cache on repo + branch for every run",
    turn_idx: 1,
    turn_role: "assistant",
    ref: null,
    ref_kind: null,
    durable: true,
    thread: null,
    scope: "project",
    confidence: 0.9,
    verified: true,
    unverifiedReason: null,
    contentHash: "H",
    paths: [],
    dangling: false,
    priority: false,
    embedding: null,
    ...over,
  };
}

describe("M3: content-hash dedupe prefers the verified copy", () => {
  it("keeps window k's verified copy over window k+1's unverified one", () => {
    const kept = dedupeByContentHash<GroundedRecord>([
      g({ windowIndex: 0 }),
      g({ windowIndex: 1, verified: false, quote: "stitched" }),
    ]);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ verified: true, windowIndex: 0 });
  });

  it("is order-independent for mixed status", () => {
    const kept = dedupeByContentHash<GroundedRecord>([g({ windowIndex: 1, verified: false }), g({ windowIndex: 2 })]);
    expect(kept[0].verified).toBe(true);
  });
});

describe("M4: the content-hash upsert merge rule", () => {
  const existing = (over: Row): Row => ({
    id: "row-H",
    user_id: "u1",
    code_session_id: "s1",
    content_hash: "H",
    verified: true,
    quote: "keyed the cache on repo + branch for every run",
    retired_at: null,
    retire_reason: null,
    ...over,
  });

  it("(a) a verified re-derivation lifts a row retired as rerun and reports it live", async () => {
    const rows = [existing({ retired_at: "2026-09-01T00:00:00Z", retire_reason: "rerun" })];
    const out = await insertMemoryRecords(makeFakeSupabase({ session_memories: rows }), "u1", "p1", "s1", "main", [
      g({}),
    ]);
    expect(rows[0].retired_at).toBeNull();
    expect(rows[0].retire_reason).toBeNull();
    expect(out[0]).toMatchObject({ id: "row-H", live: true });
  });

  it("(a) a verified re-derivation onto a row retired as duplicate stays retired and is NOT reported live", async () => {
    const rows = [existing({ retired_at: "2026-09-01T00:00:00Z", retire_reason: "duplicate" })];
    const out = await insertMemoryRecords(makeFakeSupabase({ session_memories: rows }), "u1", "p1", "s1", "main", [
      g({}),
    ]);
    expect(rows[0].retired_at).toBe("2026-09-01T00:00:00Z");
    expect(out[0]).toMatchObject({ id: "row-H", live: false });
  });

  it("(b) an unverified re-derivation never overwrites or retires a live verified row", async () => {
    const rows = [existing({})];
    const out = await insertMemoryRecords(makeFakeSupabase({ session_memories: rows }), "u1", "p1", "s1", "main", [
      g({ verified: false, unverifiedReason: "quote_not_found", quote: "a worse, stitched quote" }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      verified: true,
      retired_at: null,
      quote: "keyed the cache on repo + branch for every run",
    });
    expect(out[0]).toMatchObject({ id: "row-H", live: true, verified: true });
  });
});

describe("m5: --reverify scope filter", () => {
  it("matches exactly `unverified` and `unverified:*`, not any `unverified…` prefix", () => {
    expect(REVERIFY_SCOPE_OR_FILTER.split(",")).toEqual([
      "retired_at.is.null",
      "retire_reason.eq.unverified",
      "retire_reason.like.unverified:*",
    ]);
  });
});

// --- review v6, round 2 ---

describe("R2-m1: a hex-spelled English word is not a sha", () => {
  it("isSpecificRef needs a digit AND an a-f letter", () => {
    expect(["defaced", "decade", "facade", "effaced"].map(isSpecificRef)).toEqual([false, false, false, false]);
    expect(["abc1234", "0a1b2c3d"].map(isSpecificRef)).toEqual([true, true]);
  });

  it("an outcome ref 'defaced' in an unrelated turn does not ground (reviewer probe)", () => {
    const quote = "committed the cache key change after the suite went green";
    const turns = [t(1, "assistant", `I ${quote}.`), t(41, "assistant", "the old banner looked defaced")];
    const r = groundAgainstTurns({ kind: "outcome", text: "Committed", quote, ref: "defaced", turn_idx: 1 }, turns);
    expect(r).toMatchObject({ verified: false, reason: "ref_not_found" });
  });
});

describe("R2-m2: a partial path ref matches a longer path only in the quote's own turn", () => {
  const quote = "committed the entry point change after the suite went green";

  it("src/index.ts does not ground on another package's file in another turn (reviewer probe)", () => {
    const turns = [t(1, "assistant", `I ${quote}.`), t(2, "assistant", "ok", "Edit /repo/packages/other/src/index.ts")];
    const r = groundAgainstTurns(
      { kind: "outcome", text: "Committed", quote, ref: "src/index.ts", turn_idx: 1 },
      turns,
    );
    expect(r).toMatchObject({ verified: false, reason: "ref_not_found" });
  });

  it("the same suffix grounds in the quote's own turn, and a whole path token grounds anywhere", () => {
    const own = [t(1, "assistant", `I ${quote}.`, "Edit /repo/packages/core/src/index.ts")];
    expect(
      groundAgainstTurns({ kind: "outcome", text: "Committed", quote, ref: "src/index.ts", turn_idx: 1 }, own).verified,
    ).toBe(true);
    const whole = [t(1, "assistant", `I ${quote}.`), t(2, "assistant", "ok", "Edit src/index.ts")];
    expect(
      groundAgainstTurns({ kind: "outcome", text: "Committed", quote, ref: "src/index.ts", turn_idx: 1 }, whole)
        .verified,
    ).toBe(true);
  });

  it("a quote-less outcome grounds a path suffix only at its cited turn", () => {
    const turns = [t(1, "assistant", "ok"), t(2, "assistant", "ok", "Edit /repo/packages/other/src/index.ts")];
    const input = { kind: "outcome" as const, text: "Committed", quote: null, ref: "src/index.ts" };
    expect(groundAgainstTurns({ ...input, turn_idx: 1 }, turns).verified).toBe(false);
    expect(groundAgainstTurns({ ...input, turn_idx: 2 }, turns).verified).toBe(true);
  });
});

describe("R2-m3: an unverified re-derivation of a row the --force run re-tagged gets its reason back", () => {
  it("rerun -> unverified:<reason>, still retired, still open to --reverify", async () => {
    const rows: Row[] = [
      {
        id: "row-H",
        user_id: "u1",
        code_session_id: "s1",
        content_hash: "H",
        verified: false,
        retired_at: "2026-09-01T00:00:00Z",
        retire_reason: "rerun",
      },
    ];
    const out = await insertMemoryRecords(makeFakeSupabase({ session_memories: rows }), "u1", "p1", "s1", "main", [
      g({ verified: false, unverifiedReason: "quote_not_specific" }),
    ]);
    expect(rows[0]).toMatchObject({
      retired_at: "2026-09-01T00:00:00Z",
      retire_reason: "unverified:quote_not_specific",
    });
    expect(out[0]).toMatchObject({ id: "row-H", live: false });
  });
});

describe("R2-m4: the user-pass origin is stored and --reverify honours it", () => {
  it("insertMemoryRecords writes extraction_pass 'user' for a user-pass record and null otherwise", async () => {
    const rows: Row[] = [];
    await insertMemoryRecords(makeFakeSupabase({ session_memories: rows }), "u1", "p1", "s1", "main", [
      g({ contentHash: "A", userPass: true }),
      g({ contentHash: "B" }),
    ]);
    expect(rows.map((r) => [r.content_hash, r.extraction_pass])).toEqual([
      ["A", "user"],
      ["B", null],
    ]);
  });

  it("groundRecord marks a user-pass record; verifyRecords never repairs a 'user' row onto an assistant turn", async () => {
    const quote = "we are still blocked on the missing staging credentials for the deploy step";
    const turns = [t(0, "user", "please ship the deploy"), t(1, "assistant", `Right, ${quote}.`)];
    const raw = rec({ kind: "blocker", text: "Deploy blocked on missing staging credentials", quote, turn_idx: 0 });
    expect(groundRecord(raw, turns, "v", 0, { userTurnsOnly: true })).toMatchObject({ verified: false, turn_idx: 0 });
    const userTurn = [t(0, "user", `Right, ${quote}.`)];
    expect(groundRecord({ ...raw, turn_role: "user" }, userTurn, "v", 0, { userTurnsOnly: true })?.userPass).toBe(true);

    const sb = makeFakeSupabase({
      code_session_turns: turns.map((x) => ({ ...x, session_id: "s1" })),
    });
    const base = { code_session_id: "s1", turn_idx: 0, kind: "blocker" as const, text: raw.text, quote, ref: null };
    const res = await verifyRecords(sb, [
      { ...base, id: "main-row", extraction_pass: null },
      { ...base, id: "user-row", extraction_pass: "user" },
    ]);
    expect(res.get("main-row")).toMatchObject({ verified: true, turn_idx: 1 });
    expect(res.get("user-row")).toMatchObject({ verified: false });
  });
});
