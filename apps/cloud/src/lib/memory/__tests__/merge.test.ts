import { describe, expect, it, vi } from "vitest";
import {
  applyBlockerDurableOverride,
  applyDeterministicFixes,
  computeContentHash,
  computePaths,
  dedupeByContentHash,
  dedupeByCosine,
  type EmbeddedGroundedRecord,
  findRefInDigestOrText,
  type GroundedRecord,
  groundRecord,
  isValidOutcomeRefShape,
  overrideRefKind,
  redactRecordPii,
  repairOutcomeRef,
  splitRangeRef,
} from "../merge";
import type { TurnRow } from "../render";
import type { MemoryRecordParsed } from "../schema";

function baseRecord(overrides: Partial<MemoryRecordParsed>): MemoryRecordParsed {
  return {
    kind: "decision",
    text: "Switched retry backoff to exponential",
    turn_idx: 0,
    turn_role: "assistant",
    durable: true,
    paths: [],
    scope: "project",
    confidence: 0.7,
    ...overrides,
  };
}

function turn(overrides: Partial<TurnRow> & Pick<TurnRow, "idx" | "role" | "kind">): TurnRow {
  return { text: null, tool_name: null, file_path: null, ts: null, props: null, ...overrides };
}

describe("groundRecord", () => {
  const turns: TurnRow[] = [
    turn({ idx: 0, role: "user", kind: "prose", text: "please fix the flaky retry test" }),
    turn({
      idx: 1,
      role: "assistant",
      kind: "prose",
      text: "Switched to exponential backoff for retries, waiting longer between each attempt",
    }),
    turn({ idx: 2, role: "user", kind: "prose", text: "thanks" }),
  ];
  // step2e finding 4: a "decision"/"blocker"/"learning" quote must be >= 8
  // words or >= 40 chars AND share a content token with `text` — this
  // fixture's quote/text pair satisfies both (shares "exponential"/
  // "backoff") for every test below that reuses it.
  const LONG_QUOTE = "exponential backoff for retries, waiting longer";

  it("verifies a quote that matches at the claimed turn_idx", () => {
    const raw = baseRecord({ turn_idx: 1, quote: LONG_QUOTE, turn_role: "assistant" });
    const g = groundRecord(raw, turns, "v1", 0);
    expect(g?.verified).toBe(true);
    expect(g?.turn_idx).toBe(1);
  });

  it("keeps the model's validated paths through grounding (prompt v21: a ruling names its file)", () => {
    const withFile = [
      ...turns,
      turn({ idx: 3, role: "assistant", kind: "tool_use", tool_name: "Edit", file_path: "src/retry/backoff.ts" }),
    ];
    const raw = baseRecord({ turn_idx: 1, quote: LONG_QUOTE, paths: ["src/retry/backoff.ts"] });
    expect(groundRecord(raw, withFile, "v1", 0)?.paths).toEqual(["src/retry/backoff.ts"]);
  });

  it("repairs turn_idx when the quote is found elsewhere", () => {
    const raw = baseRecord({ turn_idx: 0, quote: LONG_QUOTE, turn_role: "user" });
    const g = groundRecord(raw, turns, "v1", 0);
    expect(g?.verified).toBe(true);
    expect(g?.turn_idx).toBe(1);
    expect(g?.turn_role).toBe("assistant");
  });

  it("marks verified=false, but still returns the record, when the quote is nowhere in the session", () => {
    const raw = baseRecord({ turn_idx: 1, quote: "this text does not exist anywhere at all" });
    const g = groundRecord(raw, turns, "v1", 0);
    expect(g?.verified).toBe(false);
    expect(g?.text).toBe(raw.text); // never dropped
  });

  it("verifies via normalizeQuote when the model appends trailing punctuation the source doesn't have (step2c residual 2, #151)", () => {
    const trailingTurns: TurnRow[] = [
      turn({
        idx: 1,
        role: "assistant",
        kind: "prose",
        text: "Switched to exponential backoff for retries, so every retry now waits longer",
      }),
    ];
    const raw = baseRecord({
      turn_idx: 1,
      quote: "exponential backoff for retries, so every retry now waits...",
      turn_role: "assistant",
    });
    const g = groundRecord(raw, trailingTurns, "v1", 0);
    expect(g?.verified).toBe(true);
  });

  it("verifies an outcome via ref-in-inputDigest even with no quote", () => {
    const outcomeTurns: TurnRow[] = [
      turn({
        idx: 5,
        role: "assistant",
        kind: "tool_use",
        tool_name: "Bash",
        props: { inputDigest: "gh issue create --title x #151" },
      }),
    ];
    const raw = baseRecord({
      kind: "outcome",
      turn_idx: 5,
      turn_role: "assistant",
      ref: "#151",
      ref_kind: "issue",
      quote: undefined,
    });
    const g = groundRecord(raw, outcomeTurns, "v1", 0);
    expect(g?.verified).toBe(true);
  });

  it("never repairs a preference's turn_role away from user, even when the quote also appears on an assistant turn (would violate the session_memories DB check)", () => {
    const ambiguousTurns: TurnRow[] = [
      turn({ idx: 0, role: "assistant", kind: "prose", text: "dark mode by default for every new account" }),
      turn({ idx: 1, role: "user", kind: "prose", text: "I want dark mode by default for every new account please" }),
    ];
    // Model claims turn_idx 5 (doesn't exist) but the quote also happens to
    // match the assistant's turn 0 as well as the real user turn 1. The quote
    // is specific enough to move (review v6 M2 — a generic one never moves).
    const raw = baseRecord({
      kind: "preference",
      text: "Dark mode by default",
      turn_idx: 5,
      turn_role: "user",
      quote: "dark mode by default for every new account",
    });
    const g = groundRecord(raw, ambiguousTurns, "v1", 0);
    expect(g?.turn_role).toBe("user");
    expect(g?.turn_idx).toBe(1); // repaired to the USER turn, never the assistant one
    expect(g?.verified).toBe(true);
  });

  it("leaves a preference unverified (never assistant-repaired, never dropped) when its quote only matches an assistant turn and no receipt idx resolves", () => {
    const turnsOnlyAssistant: TurnRow[] = [
      turn({ idx: 0, role: "assistant", kind: "prose", text: "dark mode by default" }),
    ];
    const raw = baseRecord({ kind: "preference", turn_idx: 5, turn_role: "user", quote: "dark mode by default" });
    const g = groundRecord(raw, turnsOnlyAssistant, "v1", 0);
    expect(g).not.toBeNull();
    expect(g?.turn_role).toBe("user"); // never flipped to assistant
    expect(g?.verified).toBe(false);
  });

  it("does not verify an outcome whose ref is absent from the receipt turn", () => {
    const outcomeTurns: TurnRow[] = [
      turn({ idx: 5, role: "assistant", kind: "tool_use", tool_name: "Bash", props: { inputDigest: "gh pr create" } }),
    ];
    const raw = baseRecord({ kind: "outcome", turn_idx: 5, turn_role: "assistant", ref: "#999", ref_kind: "issue" });
    const g = groundRecord(raw, outcomeTurns, "v1", 0);
    expect(g?.verified).toBe(false);
  });

  // --- step2d finding 4: turn_role always from the transcript, never the model.

  it("takes turn_role from the receipt turn, never the model's own (wrong) claim, even on a direct quote match (finding 4)", () => {
    const raw = baseRecord({ kind: "decision", turn_idx: 1, turn_role: "user", quote: LONG_QUOTE });
    const g = groundRecord(raw, turns, "v1", 0);
    expect(g?.turn_role).toBe("assistant"); // turn 1 is actually assistant-authored
    expect(g?.verified).toBe(true);
  });

  it("drops a preference whose receipt turn (resolved by idx, even with no quote) is an assistant turn (finding 4)", () => {
    const raw = baseRecord({ kind: "preference", turn_idx: 1, turn_role: "user", quote: undefined });
    const g = groundRecord(raw, turns, "v1", 0); // turn 1 is assistant
    expect(g).toBeNull();
  });

  it("logs the owner-voice-mismatch drop above (issue #162), never the quote", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const raw = baseRecord({ kind: "preference", turn_idx: 1, turn_role: "user", quote: undefined });
    groundRecord(raw, turns, "v1", 0); // turn 1 is assistant
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(warnSpy.mock.calls[0][0] as string);
    expect(logged).toMatchObject({
      level: "warn",
      step: "owner_voice_mismatch",
      action: "dropped",
      kind: "preference",
    });
    warnSpy.mockRestore();
  });

  // --- step2d finding 12: a PII-redacted quote must still ground against the turn's raw text.

  it("verifies a quote whose phone number was already redacted (by redactRecordPii, upstream) against the turn's raw text (finding 12)", () => {
    const piiTurns: TurnRow[] = [
      turn({ idx: 0, role: "assistant", kind: "prose", text: "call me at 555-123-4567 today if the deploy fails" }),
    ];
    const raw = baseRecord({
      turn_idx: 0,
      quote: "call me at [redacted] today if the deploy fails",
      turn_role: "assistant",
      text: "A callback today is needed if the deploy fails",
    });
    const g = groundRecord(raw, piiTurns, "v1", 0);
    expect(g?.verified).toBe(true);
  });

  // --- step2d finding 15: a dangling receipt (turn_idx matching no turn) is clamped, not stored raw.

  it("clamps a dangling receipt's turn_idx to the session's last turn, keeping the record verified=false (finding 15)", () => {
    const raw = baseRecord({ kind: "decision", turn_idx: 9999, quote: undefined });
    const g = groundRecord(raw, turns, "v1", 0);
    expect(g).not.toBeNull();
    expect(g?.verified).toBe(false);
    expect(g?.turn_idx).toBe(2); // turns' max idx
    expect(g?.dangling).toBe(true);
  });

  it("does not mark a resolved receipt as dangling", () => {
    const raw = baseRecord({ turn_idx: 1, quote: LONG_QUOTE });
    const g = groundRecord(raw, turns, "v1", 0);
    expect(g?.dangling).toBe(false);
  });
});

describe("computeContentHash", () => {
  it("is stable for the same inputs and differs when text changes", () => {
    const a = computeContentHash("same text", "receipt", "v1");
    const b = computeContentHash("same text", "receipt", "v1");
    const c = computeContentHash("different text", "receipt", "v1");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("computePaths", () => {
  it("collects Edit/Write file paths between the receipt turn and the next user prose turn", () => {
    const turns: TurnRow[] = [
      turn({ idx: 0, role: "assistant", kind: "prose", text: "I'll fix this" }), // receipt turn
      turn({ idx: 1, role: "assistant", kind: "tool_use", tool_name: "Edit", file_path: "apps/x.ts" }),
      turn({ idx: 2, role: "assistant", kind: "tool_use", tool_name: "Write", file_path: "apps/y.ts" }),
      turn({ idx: 3, role: "assistant", kind: "tool_use", tool_name: "Bash" }), // not a file edit — ignored
      turn({ idx: 4, role: "user", kind: "prose", text: "looks good" }), // boundary — excluded
      turn({ idx: 5, role: "assistant", kind: "tool_use", tool_name: "Edit", file_path: "apps/z.ts" }), // after boundary — excluded
    ];
    expect(computePaths(0, turns)).toEqual(["apps/x.ts", "apps/y.ts"]);
  });

  it("relativizes an absolute path under repoPath and drops one outside it (step2d finding 2)", () => {
    const repoPath = "/Users/jane/dev/some-repo";
    const turns: TurnRow[] = [
      turn({ idx: 0, role: "assistant", kind: "prose", text: "I'll fix this" }),
      turn({ idx: 1, role: "assistant", kind: "tool_use", tool_name: "Edit", file_path: `${repoPath}/apps/x.ts` }),
      turn({
        idx: 2,
        role: "assistant",
        kind: "tool_use",
        tool_name: "Edit",
        file_path: "/Users/jane/dev/other-repo/y.ts",
      }),
      turn({ idx: 3, role: "assistant", kind: "tool_use", tool_name: "Write", file_path: "apps/already-relative.ts" }),
    ];
    expect(computePaths(0, turns, repoPath)).toEqual(["apps/x.ts", "apps/already-relative.ts"]);
  });
});

function grounded(overrides: Partial<GroundedRecord>): GroundedRecord {
  return {
    windowIndex: 0,
    kind: "decision",
    text: "text",
    quote: "quote",
    turn_idx: 0,
    turn_role: "assistant",
    ref: null,
    ref_kind: null,
    durable: true,
    thread: null,
    scope: "project",
    confidence: 0.5,
    verified: true,
    contentHash: "hash-a",
    paths: [],
    dangling: false,
    priority: false,
    ...overrides,
  };
}

describe("dedupeByContentHash", () => {
  it("keeps the later window's record when hashes collide", () => {
    const records = [
      grounded({ windowIndex: 0, contentHash: "same", text: "from window 0" }),
      grounded({ windowIndex: 1, contentHash: "same", text: "from window 1" }),
    ];
    const result = dedupeByContentHash(records);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe("from window 1");
  });

  it("leaves distinct hashes untouched", () => {
    const records = [grounded({ contentHash: "a" }), grounded({ contentHash: "b" })];
    expect(dedupeByContentHash(records)).toHaveLength(2);
  });
});

function embedded(overrides: Partial<EmbeddedGroundedRecord>): EmbeddedGroundedRecord {
  return { ...grounded({}), embedding: [1, 0, 0], ...overrides };
}

describe("dedupeByCosine", () => {
  it("merges near-duplicate embeddings, keeping the later window's record", () => {
    const records = [
      embedded({ windowIndex: 0, contentHash: "a", text: "first phrasing", embedding: [1, 0, 0] }),
      embedded({ windowIndex: 1, contentHash: "b", text: "second phrasing", embedding: [0.999, 0.001, 0] }),
    ];
    const result = dedupeByCosine(records, 0.93);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe("second phrasing");
  });

  it("keeps records below the cosine threshold separate", () => {
    const records = [
      embedded({ windowIndex: 0, contentHash: "a", embedding: [1, 0, 0] }),
      embedded({ windowIndex: 1, contentHash: "b", embedding: [0, 1, 0] }),
    ];
    expect(dedupeByCosine(records, 0.93)).toHaveLength(2);
  });

  it("never matches or merges a record with a null embedding (finding 8: a failed embed batch), keeping it as its own record", () => {
    const records = [
      embedded({ windowIndex: 0, contentHash: "a", embedding: [1, 0, 0] }),
      embedded({ windowIndex: 1, contentHash: "b", embedding: null }),
      embedded({ windowIndex: 2, contentHash: "c", embedding: [0.999, 0.001, 0] }), // near-dup of the FIRST record
    ];
    const result = dedupeByCosine(records, 0.93);
    expect(result).toHaveLength(2);
    expect(result.some((r) => r.embedding === null)).toBe(true);
  });
});

// --- step2b deterministic fixes ---

describe("applyBlockerDurableOverride (finding G)", () => {
  it("sets durable = !resolved_in_session for a blocker that answered it", () => {
    const resolved = baseRecord({ kind: "blocker", durable: true, resolved_in_session: true });
    expect(applyBlockerDurableOverride(resolved).durable).toBe(false);

    const open = baseRecord({ kind: "blocker", durable: false, resolved_in_session: false });
    expect(applyBlockerDurableOverride(open).durable).toBe(true);
  });

  it("leaves durable untouched for a blocker that left resolved_in_session unanswered", () => {
    const raw = baseRecord({ kind: "blocker", durable: true });
    expect(applyBlockerDurableOverride(raw).durable).toBe(true);
  });

  it("never touches a non-blocker kind", () => {
    const raw = baseRecord({ kind: "decision", durable: true, resolved_in_session: true });
    expect(applyBlockerDurableOverride(raw).durable).toBe(true);
  });
});

describe("splitRangeRef (finding E)", () => {
  it("splits a #N-#M range into one ref per member", () => {
    expect(splitRangeRef("#133-#138")).toEqual(["#133", "#134", "#135", "#136", "#137", "#138"]);
  });

  it("returns null for a non-range ref", () => {
    expect(splitRangeRef("#151")).toBeNull();
    expect(splitRangeRef("abc1234")).toBeNull();
  });

  it("returns null for an absurdly large or inverted range", () => {
    expect(splitRangeRef("#1-#99999")).toBeNull();
    expect(splitRangeRef("#10-#1")).toBeNull();
  });
});

describe("findRefInDigestOrText (finding E)", () => {
  function turn(overrides: Partial<TurnRow> & Pick<TurnRow, "idx" | "role" | "kind">): TurnRow {
    return { text: null, tool_name: null, file_path: null, ts: null, props: null, ...overrides };
  }

  it("finds a sha in inputDigest when the model's ref is not present", () => {
    const t = turn({
      idx: 5,
      role: "assistant",
      kind: "tool_use",
      props: { inputDigest: "git commit -m fix a1b2c3d4e5f" },
    });
    expect(findRefInDigestOrText(t)).toBe("a1b2c3d4e5f");
  });

  it("finds a #N issue reference", () => {
    const t = turn({ idx: 5, role: "assistant", kind: "tool_use", props: { inputDigest: "gh issue comment #151" } });
    expect(findRefInDigestOrText(t)).toBe("#151");
  });

  it("finds a URL, trimmed of trailing punctuation", () => {
    const t = turn({
      idx: 5,
      role: "assistant",
      kind: "tool_result",
      text: "created https://github.com/o/r/pull/12.",
    });
    expect(findRefInDigestOrText(t)).toBe("https://github.com/o/r/pull/12");
  });

  it("returns null when there's nothing better and for an undefined turn", () => {
    expect(findRefInDigestOrText(turn({ idx: 5, role: "assistant", kind: "tool_use" }))).toBeNull();
    expect(findRefInDigestOrText(undefined)).toBeNull();
  });
});

describe("repairOutcomeRef (finding E)", () => {
  function turn(overrides: Partial<TurnRow> & Pick<TurnRow, "idx" | "role" | "kind">): TurnRow {
    return { text: null, tool_name: null, file_path: null, ts: null, props: null, ...overrides };
  }

  it("leaves a non-outcome record untouched", () => {
    const raw = baseRecord({ kind: "decision" });
    expect(repairOutcomeRef(raw, [])).toEqual([raw]);
  });

  it("leaves an outcome untouched when its ref already appears in the receipt turn", () => {
    const turns = [
      turn({ idx: 5, role: "assistant", kind: "tool_use", props: { inputDigest: "gh issue create #151" } }),
    ];
    const raw = baseRecord({ kind: "outcome", turn_idx: 5, ref: "#151", ref_kind: "issue" });
    expect(repairOutcomeRef(raw, turns)).toEqual([raw]);
  });

  it("repairs a file-path ref from the receipt turn's digest", () => {
    const turns = [
      turn({
        idx: 5,
        role: "assistant",
        kind: "tool_use",
        props: { inputDigest: "gh pr create ... https://github.com/o/r/pull/12" },
      }),
    ];
    const raw = baseRecord({ kind: "outcome", turn_idx: 5, ref: "apps/x.ts", ref_kind: "file" });
    const [repaired] = repairOutcomeRef(raw, turns);
    expect(repaired.ref).toBe("https://github.com/o/r/pull/12");
  });

  it("splits a range ref into one record per member when every member is present in the digest", () => {
    const turns = [turn({ idx: 5, role: "assistant", kind: "tool_use", props: { inputDigest: "closes #133 #134" } })];
    const raw = baseRecord({ kind: "outcome", turn_idx: 5, ref: "#133-#134", ref_kind: "issue" });
    const repaired = repairOutcomeRef(raw, turns);
    expect(repaired.map((r) => r.ref)).toEqual(["#133", "#134"]);
  });

  it("keeps only the first member of a range ref when not every member is present", () => {
    const turns = [turn({ idx: 5, role: "assistant", kind: "tool_use", props: { inputDigest: "closes #133" } })];
    const raw = baseRecord({ kind: "outcome", turn_idx: 5, ref: "#133-#138", ref_kind: "issue" });
    const repaired = repairOutcomeRef(raw, turns);
    expect(repaired).toHaveLength(1);
    expect(repaired[0].ref).toBe("#133");
  });

  it("leaves the ref as-is when nothing better can be found (will surface as unverified downstream)", () => {
    const turns = [turn({ idx: 5, role: "assistant", kind: "tool_use" })];
    const raw = baseRecord({ kind: "outcome", turn_idx: 5, ref: "some-file.ts", ref_kind: "file" });
    expect(repairOutcomeRef(raw, turns)).toEqual([raw]);
  });
});

// step2e finding 1 (docs/goals/2026-09-13_memory-v1-build_goal.md; issue
// #151): a "commit: <subject>" quote is the Delivered-block hint's own
// text, not a transcript line — the mechanism behind six of fable-pass.md's
// twenty outcomes (a real `git commit` tool_use turn's own line number
// mislabeled as an issue ref, paired with an unrelated receipt turn).
describe("repairOutcomeRef — commit-hinted outcomes (step2e finding 1)", () => {
  function commitTurns(): TurnRow[] {
    return [
      turn({ idx: 0, role: "user", kind: "prose", text: "please fix the flaky retry test" }),
      turn({
        idx: 50,
        role: "assistant",
        kind: "tool_use",
        tool_name: "Bash",
        ts: "2026-01-01T00:00:01Z",
        props: { inputDigest: 'git commit -m "Fix retry bug"' },
      }),
      turn({
        idx: 51,
        role: "assistant",
        kind: "prose",
        text: "Committed as a1b2c3d.",
        ts: "2026-01-01T00:00:02Z",
      }),
    ];
  }

  it("re-grounds turn_idx/turn_role/ref against the real commit hint, taking the sha, and drops the synthesized quote (live pattern e740ba57 etc.)", () => {
    const turns = commitTurns();
    // The buggy shape the sample showed: turn_idx points at unrelated turn
    // 0, ref is the commit tool_use turn's OWN line number mislabeled as an
    // issue, and the quote is the hint's own "commit: <subject>" text.
    const raw = baseRecord({
      kind: "outcome",
      turn_idx: 0,
      turn_role: "user",
      quote: "commit: Fix retry bug",
      ref: "#50",
      ref_kind: "issue",
    });
    const [repaired] = repairOutcomeRef(raw, turns);
    expect(repaired.turn_idx).toBe(50); // the real git commit tool_use turn
    expect(repaired.turn_role).toBe("assistant");
    expect(repaired.ref).toBe("a1b2c3d"); // the real sha, not the turn-index-as-issue
    expect(repaired.ref_kind).toBe("commit");
    expect(repaired.quote).toBeUndefined(); // never a synthesized "commit:" prefix (finding 3)
  });

  it("drops the record (hallucinated ref) when no matching commit hint exists at all", () => {
    const turns = [turn({ idx: 0, role: "user", kind: "prose", text: "please fix the flaky retry test" })];
    const raw = baseRecord({
      kind: "outcome",
      turn_idx: 0,
      turn_role: "user",
      quote: "commit: something that never happened",
      ref: "#0",
      ref_kind: "issue",
    });
    expect(repairOutcomeRef(raw, turns)).toEqual([]);
  });

  // --- Issue #162: every drop/repair above now logs exactly one structured line.

  it("logs a 'repaired' line when the sha is recovered from the commit hint", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const turns = commitTurns();
    const raw = baseRecord({
      kind: "outcome",
      turn_idx: 0,
      turn_role: "user",
      quote: "commit: Fix retry bug",
      ref: "#50",
      ref_kind: "issue",
    });
    repairOutcomeRef(raw, turns);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(warnSpy.mock.calls[0][0] as string);
    expect(logged).toMatchObject({ level: "warn", step: "hallucinated_ref", action: "repaired", kind: "outcome" });
    expect(logged.reason).not.toMatch(/Fix retry bug|a1b2c3d/); // never the quote/sha itself
    warnSpy.mockRestore();
  });

  it("logs a 'dropped' line when no matching commit hint exists at all (issue #162)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const turns = [turn({ idx: 0, role: "user", kind: "prose", text: "please fix the flaky retry test" })];
    const raw = baseRecord({
      kind: "outcome",
      turn_idx: 0,
      turn_role: "user",
      quote: "commit: something that never happened",
      ref: "#0",
      ref_kind: "issue",
    });
    repairOutcomeRef(raw, turns);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(warnSpy.mock.calls[0][0] as string);
    expect(logged).toMatchObject({ level: "warn", step: "hallucinated_ref", action: "dropped", kind: "outcome" });
    warnSpy.mockRestore();
  });
});

// step2e finding 1 (general)/finding 2 (docs/goals/2026-09-13_memory-v1-build_goal.md;
// issue #151): a bare-integer or hex-shaped ref must be corroborated by the
// receipt turn before it is trusted — otherwise it's dropped as hallucinated
// (never silently kept as before step2e).
describe("repairOutcomeRef — ref corroboration (step2e findings 1/2)", () => {
  it("drops a bare-integer ref the receipt turn never mentions as an issue (live pattern e740ba57's mechanism, generalized)", () => {
    const turns = [turn({ idx: 0, role: "user", kind: "prose", text: "totally unrelated prose, no numbers here" })];
    const raw = baseRecord({ kind: "outcome", turn_idx: 0, ref: "#42", ref_kind: "issue" });
    expect(repairOutcomeRef(raw, turns)).toEqual([]);
  });

  it("keeps a bare-integer ref the receipt turn DOES corroborate as an issue", () => {
    const turns = [turn({ idx: 0, role: "assistant", kind: "prose", text: "closing #42 now that the fix landed" })];
    const raw = baseRecord({ kind: "outcome", turn_idx: 0, ref: "#42", ref_kind: "issue" });
    expect(repairOutcomeRef(raw, turns)).toEqual([raw]);
  });

  it("drops a hex-shaped ref that is really a dummy PAN/phone-shaped token with no commit/sha/hash context (live cases 7f4aee8e, e293f613)", () => {
    const turns = [
      turn({ idx: 0, role: "assistant", kind: "prose", text: "the dummy record is ABCDE1234F for the test flow" }),
    ];
    const raw = baseRecord({ kind: "outcome", turn_idx: 0, ref: "ABCDE1234F", ref_kind: "commit" });
    expect(repairOutcomeRef(raw, turns)).toEqual([]);
  });

  it("keeps a hex-shaped ref that IS corroborated by a nearby commit/sha/hash keyword", () => {
    const turns = [
      turn({ idx: 0, role: "assistant", kind: "prose", text: "committed as e617ee5a6f, all checks green" }),
    ];
    const raw = baseRecord({ kind: "outcome", turn_idx: 0, ref: "e617ee5a6f", ref_kind: "commit" });
    expect(repairOutcomeRef(raw, turns)).toEqual([raw]);
  });

  it("keeps a hex-shaped ref when the receipt turn IS itself the git commit/push tool call (no keyword needed — the whole turn IS the commit)", () => {
    const turns = [
      turn({
        idx: 5,
        role: "assistant",
        kind: "tool_use",
        props: { inputDigest: "git commit -m fix e617ee5a6f" },
      }),
    ];
    const raw = baseRecord({ kind: "outcome", turn_idx: 5, ref: "e617ee5a6f", ref_kind: "commit" });
    expect(repairOutcomeRef(raw, turns)).toEqual([raw]);
  });

  it("a bare integer classified as a pure-digit phone-like string (finding 2) is reclassified away from 'commit' by ref-kind's stricter HEX_SHA and then dropped as an unconfirmed issue", () => {
    const turns = [
      turn({
        idx: 0,
        role: "assistant",
        kind: "prose",
        text: "also still open: the `kit 0000000000` test whenever you get a second.",
      }),
    ];
    const raw = baseRecord({ kind: "outcome", turn_idx: 0, ref: "0000000000", ref_kind: "commit" });
    expect(repairOutcomeRef(raw, turns)).toEqual([]);
  });

  // --- Issue #162: repair vs. drop logging for the corroboration gates.

  it("logs 'repaired' when an uncorroborated bare-integer ref is replaced from the receipt turn's digest", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const turns = [
      turn({ idx: 5, role: "assistant", kind: "tool_use", props: { inputDigest: "closes https://x/issues/99" } }),
    ];
    const raw = baseRecord({ kind: "outcome", turn_idx: 5, ref: "#42", ref_kind: "issue" });
    const repaired = repairOutcomeRef(raw, turns);
    expect(repaired).toHaveLength(1);
    expect(repaired[0].ref).not.toBe("#42"); // actually replaced, not just kept
    const logged = JSON.parse(warnSpy.mock.calls[0][0] as string);
    expect(logged).toMatchObject({ step: "hallucinated_ref", action: "repaired", kind: "outcome" });
    warnSpy.mockRestore();
  });

  it("logs 'dropped' when an uncorroborated bare-integer ref cannot be repaired from the receipt turn (issue #162)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const turns = [turn({ idx: 0, role: "user", kind: "prose", text: "totally unrelated prose, no numbers here" })];
    const raw = baseRecord({ kind: "outcome", turn_idx: 0, ref: "#42", ref_kind: "issue" });
    repairOutcomeRef(raw, turns);
    const logged = JSON.parse(warnSpy.mock.calls[0][0] as string);
    expect(logged).toMatchObject({ step: "hallucinated_ref", action: "dropped", kind: "outcome" });
    warnSpy.mockRestore();
  });
});

describe("isSpecificEnoughQuote via groundRecord (step2e finding 4)", () => {
  it("does not verify a blocker whose quote is too short/generic even though it matches verbatim somewhere", () => {
    const turns: TurnRow[] = [
      turn({ idx: 0, role: "assistant", kind: "prose", text: "blocked on ci for now, moving to the next task" }),
    ];
    const raw = baseRecord({
      kind: "blocker",
      turn_idx: 0,
      turn_role: "assistant",
      text: "CI is blocking the merge",
      quote: "blocked on ci",
    });
    const g = groundRecord(raw, turns, "v1", 0);
    expect(g?.verified).toBe(false); // quote is real but too short/generic (< 8 words, < 40 chars)
  });

  it("does not verify a blocker whose quote is long enough but shares no content word with text (a generic span coincidentally matched)", () => {
    const turns: TurnRow[] = [
      turn({
        idx: 0,
        role: "assistant",
        kind: "prose",
        text: "notice period is thirty days from the rent date for every unit in the building",
      }),
    ];
    const raw = baseRecord({
      kind: "blocker",
      turn_idx: 0,
      turn_role: "assistant",
      text: "Missing SUPABASE_SERVICE_ROLE_KEY blocks the migration.",
      quote: "notice period is thirty days from the rent date for every unit in the building",
    });
    const g = groundRecord(raw, turns, "v1", 0);
    expect(g?.verified).toBe(false); // long enough, but shares no content token with `text`
  });

  it("verifies a blocker whose quote is substantial AND shares a content word with text", () => {
    const turns: TurnRow[] = [
      turn({
        idx: 0,
        role: "assistant",
        kind: "prose",
        text: "Missing SUPABASE_SERVICE_ROLE_KEY blocks the migration from running against the hosted project.",
      }),
    ];
    const raw = baseRecord({
      kind: "blocker",
      turn_idx: 0,
      turn_role: "assistant",
      text: "Missing SUPABASE_SERVICE_ROLE_KEY blocks the migration.",
      quote: "Missing SUPABASE_SERVICE_ROLE_KEY blocks the migration from running against the hosted project.",
    });
    const g = groundRecord(raw, turns, "v1", 0);
    expect(g?.verified).toBe(true);
  });

  it("leaves outcome/preference verification untouched by the specificity gate (a short outcome ref-only verification still works)", () => {
    const outcomeTurns: TurnRow[] = [
      turn({
        idx: 5,
        role: "assistant",
        kind: "tool_use",
        tool_name: "Bash",
        props: { inputDigest: "gh issue create --title x #151" },
      }),
    ];
    const raw = baseRecord({
      kind: "outcome",
      turn_idx: 5,
      turn_role: "assistant",
      ref: "#151",
      ref_kind: "issue",
      quote: undefined,
    });
    const g = groundRecord(raw, outcomeTurns, "v1", 0);
    expect(g?.verified).toBe(true);
  });
});

describe("overrideRefKind (finding D)", () => {
  it("overrides an unambiguous shape even when the model guessed wrong", () => {
    const raw = baseRecord({ kind: "outcome", ref: "https://github.com/o/r/commit/abc1234", ref_kind: "other" });
    expect(overrideRefKind(raw).ref_kind).toBe("commit");
  });

  it("keeps the model's ref_kind when the shape is ambiguous", () => {
    const raw = baseRecord({ kind: "outcome", ref: "some-opaque-id", ref_kind: "pr" });
    expect(overrideRefKind(raw).ref_kind).toBe("pr");
  });

  it("never touches a non-outcome record", () => {
    const raw = baseRecord({ kind: "decision" });
    expect(overrideRefKind(raw)).toEqual(raw);
  });
});

describe("isValidOutcomeRefShape (finding F)", () => {
  it("accepts URL/sha/issue/tag/branch/repo-relative-path/artifact-id shapes", () => {
    expect(isValidOutcomeRefShape("https://github.com/o/r/pull/12")).toBe(true);
    expect(isValidOutcomeRefShape("a1b2c3d")).toBe(true);
    expect(isValidOutcomeRefShape("#151")).toBe(true);
    expect(isValidOutcomeRefShape("v1.2.3")).toBe(true);
    expect(isValidOutcomeRefShape("origin/feature-x")).toBe(true);
    expect(isValidOutcomeRefShape("docs/design/memory-v1.md")).toBe(true);
    expect(isValidOutcomeRefShape("cAM123xyzABC")).toBe(true);
  });

  it("rejects an empty ref or one still carrying the redaction marker", () => {
    expect(isValidOutcomeRefShape("")).toBe(false);
    expect(isValidOutcomeRefShape("[redacted]")).toBe(false);
    expect(isValidOutcomeRefShape("call [redacted] for details")).toBe(false);
  });

  it("accepts an absolute or home-relative path as a valid (off-repo) opener (step2d finding 2: not PII)", () => {
    expect(isValidOutcomeRefShape("/Users/jane/notes.md")).toBe(true);
    expect(isValidOutcomeRefShape("~/dev/life/fd-notes.md")).toBe(true);
    expect(isValidOutcomeRefShape("Users/jane/dev/other-project/notes.md")).toBe(true);
  });

  it("accepts a real git branch name — not PII (issue #162 repro: was silently dropped)", () => {
    expect(isValidOutcomeRefShape("feature/some-branch-adr")).toBe(true);
    expect(isValidOutcomeRefShape("fix/162-something")).toBe(true);
    expect(isValidOutcomeRefShape("release/1.2.0")).toBe(true);
  });

  it("S1 (review round 2): rejects plain multi-segment slash text that only LOOKED branch-shaped under the round-1 fix", () => {
    expect(isValidOutcomeRefShape("github.com/acme/repo")).toBe(false);
    expect(isValidOutcomeRefShape("www.example.com/path")).toBe(false);
    expect(isValidOutcomeRefShape("and/or")).toBe(false);
    expect(isValidOutcomeRefShape("yes/no")).toBe(false);
    expect(isValidOutcomeRefShape("Jane/Doe")).toBe(false);
    expect(isValidOutcomeRefShape("home/jdoe/notes")).toBe(false);
    expect(isValidOutcomeRefShape("src/lib/memory")).toBe(false);
  });
});

describe("redactRecordPii (finding F, narrowed by step2d finding 2)", () => {
  it("redacts phone/email in text/quote but never touches a path", () => {
    const raw = baseRecord({
      text: "Call the office at 555-123-4567 to confirm",
      quote: "reach me at jane@example.com",
      ref: undefined,
    });
    const redacted = redactRecordPii(raw, undefined);
    expect(redacted.text).toBe("Call the office at [redacted] to confirm");
    expect(redacted.quote).toBe("reach me at [redacted]");
  });

  it("relativizes an outcome ref path under repoPath, and keeps an off-repo path as-is", () => {
    const repoPath = "/Users/jane/dev/some-repo";
    const inRepo = baseRecord({ kind: "outcome", ref: `${repoPath}/README.md`, ref_kind: "doc" });
    expect(redactRecordPii(inRepo, repoPath).ref).toBe("README.md");

    const offRepo = baseRecord({ kind: "outcome", ref: "/Users/jane/dev/other-project/notes.md", ref_kind: "doc" });
    expect(redactRecordPii(offRepo, repoPath).ref).toBe("/Users/jane/dev/other-project/notes.md");
  });

  it("redacts phone/email in thread", () => {
    const raw = baseRecord({ thread: "call 555-123-4567 about the release" });
    expect(redactRecordPii(raw, undefined).thread).toBe("call [redacted] about the release");
  });
});

describe("applyDeterministicFixes (orchestrator)", () => {
  function turn(overrides: Partial<TurnRow> & Pick<TurnRow, "idx" | "role" | "kind">): TurnRow {
    return { text: null, tool_name: null, file_path: null, ts: null, props: null, ...overrides };
  }

  it("runs G, E, D, F in order and returns the fixed record", () => {
    const turns = [
      turn({
        idx: 5,
        role: "assistant",
        kind: "tool_use",
        props: { inputDigest: "gh pr create https://github.com/o/r/pull/12" },
      }),
    ];
    const raw = baseRecord({ kind: "outcome", turn_idx: 5, ref: "some-stale-ref", ref_kind: "other" });
    const { records, droppedPii } = applyDeterministicFixes(raw, turns, undefined);
    expect(droppedPii).toBe(0);
    expect(records).toHaveLength(1);
    expect(records[0].ref).toBe("https://github.com/o/r/pull/12");
    expect(records[0].ref_kind).toBe("pr");
  });

  it("drops an outcome whose ref is PII with nothing left to ground it on", () => {
    const raw = baseRecord({ kind: "outcome", turn_idx: 0, ref: "+15551234567", ref_kind: "other" });
    const { records, droppedPii } = applyDeterministicFixes(raw, [], undefined);
    expect(records).toEqual([]);
    expect(droppedPii).toBe(1);
  });

  it("logs the PII drop above, never the ref itself (issue #162)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const raw = baseRecord({ kind: "outcome", turn_idx: 0, ref: "+15551234567", ref_kind: "other" });
    applyDeterministicFixes(raw, [], undefined);
    const logged = JSON.parse(warnSpy.mock.calls[0][0] as string);
    expect(logged).toMatchObject({ step: "pii_scrub", action: "dropped", kind: "outcome" });
    expect(JSON.stringify(logged)).not.toContain("15551234567");
    warnSpy.mockRestore();
  });

  it("applies the blocker durable override before anything else", () => {
    const raw = baseRecord({ kind: "blocker", durable: true, resolved_in_session: true });
    const { records } = applyDeterministicFixes(raw, [], undefined);
    expect(records[0].durable).toBe(false);
  });

  // --- Issue #162: a git branch name is kept, not dropped as PII (the repro).

  it("keeps an outcome whose ref is a git branch name literally present in the receipt turn, end to end", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const turns = [
      turn({
        idx: 0,
        role: "assistant",
        kind: "tool_use",
        props: { inputDigest: "git push -u origin feature/some-branch-adr" },
      }),
    ];
    const raw = baseRecord({ kind: "outcome", turn_idx: 0, ref: "feature/some-branch-adr", ref_kind: "other" });
    const { records, droppedPii } = applyDeterministicFixes(raw, turns, undefined);
    expect(droppedPii).toBe(0);
    expect(records).toHaveLength(1);
    expect(records[0].ref).toBe("feature/some-branch-adr");
    expect(records[0].ref_kind).toBe("branch"); // classifyRef (finding D) now recognizes it too
    expect(warnSpy).not.toHaveBeenCalled(); // nothing dropped or repaired — never PII in the first place, and it's literal in the turn
    warnSpy.mockRestore();
  });

  it("S1 (review round 2): drops a branch-shaped ref that never appears in the receipt turn or its digest — fabricated-but-plausible-shaped, not PII", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const turns = [
      turn({ idx: 0, role: "assistant", kind: "tool_use", props: { inputDigest: "ran the tests, all green" } }),
    ];
    const raw = baseRecord({ kind: "outcome", turn_idx: 0, ref: "fix/162-something", ref_kind: "other" });
    const { records } = applyDeterministicFixes(raw, turns, undefined);
    expect(records).toEqual([]);
    const logged = JSON.parse(warnSpy.mock.calls[0][0] as string);
    expect(logged).toMatchObject({ step: "hallucinated_ref", action: "dropped", kind: "outcome" });
    warnSpy.mockRestore();
  });

  it("R2-S1 (review round 3): keeps ref 'origin/feature/x' when the turn only names 'feature/x' — origin/ is stripped before the check", () => {
    const turns = [
      turn({ idx: 0, role: "assistant", kind: "tool_use", props: { inputDigest: "git push -u origin feature/x" } }),
    ];
    const raw = baseRecord({ kind: "outcome", turn_idx: 0, ref: "origin/feature/x", ref_kind: "other" });
    const { records } = applyDeterministicFixes(raw, turns, undefined);
    expect(records).toHaveLength(1);
    expect(records[0].ref).toBe("origin/feature/x");
  });

  it("R2-S1 (review round 3): keeps ref 'main' on trust — a well-known default branch, never demanded verbatim in a turn", () => {
    const turns = [
      turn({ idx: 0, role: "assistant", kind: "tool_use", props: { inputDigest: "git push -u origin feature/x" } }),
    ];
    const raw = baseRecord({ kind: "outcome", turn_idx: 0, ref: "main", ref_kind: "other" });
    const { records } = applyDeterministicFixes(raw, turns, undefined);
    expect(records).toHaveLength(1);
    expect(records[0].ref).toBe("main");
  });

  it("R2-S1 (review round 3): keeps a branch named only in a NEIGHBOURING turn, not the cited receipt turn", () => {
    const turns = [
      turn({ idx: 0, role: "assistant", kind: "tool_use", props: { inputDigest: "pushing the new branch now" } }),
      turn({ idx: 1, role: "assistant", kind: "tool_result", text: "* [new branch]      feature/x -> feature/x" }),
    ];
    // model cites turn 0 (no "feature/x" there at all) — only the neighbouring tool_result at turn 1 names it
    const raw = baseRecord({ kind: "outcome", turn_idx: 0, ref: "feature/x", ref_kind: "other" });
    const { records } = applyDeterministicFixes(raw, turns, undefined);
    expect(records).toHaveLength(1);
    expect(records[0].ref).toBe("feature/x");
  });

  it("R2-S1 (review round 3): still drops a branch-shaped ref absent from the whole session, not just the receipt turn", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const turns = [
      turn({ idx: 0, role: "assistant", kind: "tool_use", props: { inputDigest: "ran the tests, all green" } }),
      turn({ idx: 1, role: "user", kind: "prose", text: "thanks!" }),
    ];
    const raw = baseRecord({ kind: "outcome", turn_idx: 0, ref: "jane-doe/wip", ref_kind: "other" });
    const { records } = applyDeterministicFixes(raw, turns, undefined);
    expect(records).toEqual([]);
    const logged = JSON.parse(warnSpy.mock.calls[0][0] as string);
    expect(logged).toMatchObject({ step: "hallucinated_ref", action: "dropped", kind: "outcome" });
    warnSpy.mockRestore();
  });

  it("counts and logs a PII repair that keeps the record (text redacted, ref untouched)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const raw = baseRecord({
      kind: "decision",
      turn_idx: 0,
      text: "Call the office at 555-123-4567 to confirm the release",
    });
    const { records, repairedPii } = applyDeterministicFixes(raw, [], undefined);
    expect(repairedPii).toBe(1);
    expect(records).toHaveLength(1);
    expect(records[0].text).toBe("Call the office at [redacted] to confirm the release");
    const logged = JSON.parse(warnSpy.mock.calls[0][0] as string);
    expect(logged).toMatchObject({ step: "pii_scrub", action: "repaired", kind: "decision" });
    warnSpy.mockRestore();
  });

  it("S2 (review round 2): does NOT count or log a PII repair when only relativizeRefPath changed the ref (no [redacted] introduced)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const repoPath = "/Users/jane/dev/some-repo";
    const raw = baseRecord({ kind: "outcome", turn_idx: 0, ref: `${repoPath}/src/foo.ts`, ref_kind: "file" });
    const { records, repairedPii } = applyDeterministicFixes(raw, [], repoPath);
    expect(repairedPii).toBe(0);
    expect(records[0].ref).toBe("src/foo.ts"); // relativized, but that's not a PII repair
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('"step":"pii_scrub"'));
    warnSpy.mockRestore();
  });

  it("N1 (review round 2): logs the repair when a range ref is split into members present in the receipt turn", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const turns = [turn({ idx: 5, role: "assistant", kind: "tool_use", props: { inputDigest: "closes #133 #134" } })];
    const raw = baseRecord({ kind: "outcome", turn_idx: 5, ref: "#133-#134", ref_kind: "issue" });
    const { records } = applyDeterministicFixes(raw, turns, undefined);
    expect(records.map((r) => r.ref)).toEqual(["#133", "#134"]);
    const logged = JSON.parse(warnSpy.mock.calls[0][0] as string);
    expect(logged).toMatchObject({ step: "hallucinated_ref", action: "repaired", kind: "outcome" });
    warnSpy.mockRestore();
  });

  it("N1 (review round 2): logs the repair when findRefInDigestOrText replaces an uncorroborated ref", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const turns = [
      turn({
        idx: 5,
        role: "assistant",
        kind: "tool_use",
        props: { inputDigest: "gh pr create ... https://github.com/o/r/pull/12" },
      }),
    ];
    const raw = baseRecord({ kind: "outcome", turn_idx: 5, ref: "apps/x.ts", ref_kind: "file" });
    const { records } = applyDeterministicFixes(raw, turns, undefined);
    expect(records[0].ref).toBe("https://github.com/o/r/pull/12");
    const logged = JSON.parse(warnSpy.mock.calls[0][0] as string);
    expect(logged).toMatchObject({ step: "hallucinated_ref", action: "repaired", kind: "outcome" });
    warnSpy.mockRestore();
  });
});
