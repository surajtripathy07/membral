import { describe, expect, it } from "vitest";
import { BlockerResolutionCheck, ExtractionWire, parseMemoryRecord, startsWithNarrationOpener } from "../schema";

// step2e finding 6 (docs/goals/2026-09-13_memory-v1-build_goal.md; issue
// #151): a preference is emitted under its OWN field names (`statement`/
// `owner_quote`), and a narrated statement is rejected by the SCHEMA, not
// rewritten.
describe("startsWithNarrationOpener", () => {
  it("catches every documented narration opener, case-insensitively", () => {
    expect(startsWithNarrationOpener("The owner prefers dark mode")).toBe(true);
    expect(startsWithNarrationOpener("the user wants tabs")).toBe(true);
    expect(startsWithNarrationOpener("User needs a clean setup")).toBe(true);
    expect(startsWithNarrationOpener("Owner said keep it simple")).toBe(true);
    expect(startsWithNarrationOpener("The assistant should ask first")).toBe(true);
    expect(startsWithNarrationOpener("The maintainer decided on tabs")).toBe(true);
    expect(startsWithNarrationOpener("Maintainer wants tabs")).toBe(true);
    expect(startsWithNarrationOpener("He wants dark mode by default")).toBe(true);
    expect(startsWithNarrationOpener("She prefers tabs over spaces")).toBe(true);
    expect(startsWithNarrationOpener("They want a clean setup")).toBe(true);
    expect(startsWithNarrationOpener("Desire for a clean setup")).toBe(true);
    expect(startsWithNarrationOpener("A preference for tabs over spaces")).toBe(true);
  });

  it("does not flag an imperative/standing-rule statement", () => {
    expect(startsWithNarrationOpener("Setup should stay clean, with no extra background services.")).toBe(false);
    expect(startsWithNarrationOpener("Decisions are judged by user experience first; cost breaks ties.")).toBe(false);
  });
});

describe("parseMemoryRecord (step2e finding 6)", () => {
  const commonPreferenceFields = {
    turn_idx: 3,
    turn_role: "user" as const,
    durable: true,
    thread: "editor prefs",
  };

  it("rejects a preference whose statement reads as narration — dropped, never rewritten", () => {
    const result = parseMemoryRecord({
      kind: "preference",
      statement: "The owner prefers dark mode by default",
      owner_quote: "I want dark mode by default please",
      ...commonPreferenceFields,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.message.includes("reads as narration"))).toBe(true);
    }
  });

  it("accepts a well-formed preference and maps statement/owner_quote onto text/quote", () => {
    const result = parseMemoryRecord({
      kind: "preference",
      statement: "Setup should stay clean, with no extra background services.",
      owner_quote: "I want dark mode by default please",
      ...commonPreferenceFields,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.text).toBe("Setup should stay clean, with no extra background services.");
      expect(result.data.quote).toBe("I want dark mode by default please");
      expect(result.data.kind).toBe("preference");
      // The wire-only field names never leak into the normalized shape.
      expect(result.data).not.toHaveProperty("statement");
      expect(result.data).not.toHaveProperty("owner_quote");
    }
  });

  it("rejects a preference whose turn_role is not 'user'", () => {
    const result = parseMemoryRecord({
      kind: "preference",
      statement: "Setup should stay clean, with no extra background services.",
      turn_idx: 3,
      turn_role: "assistant",
      durable: true,
      thread: "editor prefs",
    });
    expect(result.success).toBe(false);
  });

  it("accepts a well-formed non-preference record (text/quote, unchanged shape)", () => {
    const result = parseMemoryRecord({
      kind: "decision",
      text: "Switched retry backoff to exponential",
      quote: "we switched to exponential backoff",
      turn_idx: 1,
      turn_role: "assistant",
      durable: true,
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.text).toBe("Switched retry backoff to exponential");
  });

  it("rejects an outcome with no ref", () => {
    const result = parseMemoryRecord({
      kind: "outcome",
      text: "Filed an issue",
      turn_idx: 0,
      turn_role: "user",
      durable: false,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a completely malformed input without throwing", () => {
    expect(() => parseMemoryRecord({ kind: "decision" })).not.toThrow();
    expect(parseMemoryRecord({ kind: "decision" }).success).toBe(false);
    expect(() => parseMemoryRecord(null)).not.toThrow();
    expect(() => parseMemoryRecord("not an object")).not.toThrow();
  });
});

// step2f fix 1 (issue #151): `durable` is optional at the wire boundary —
// gpt-4o-mini omits it on ~100 records across the step2e one-repo gate's 19
// sessions, overwhelmingly on blockers. A missing `durable` must never drop
// the record; `parseMemoryRecord` fills in a deterministic default instead.
describe("parseMemoryRecord — durable defaulting (step2f fix 1)", () => {
  it("a blocker missing durable but with resolved_in_session:false lands durable=true, durableDefaulted:true", () => {
    const result = parseMemoryRecord({
      kind: "blocker",
      text: "Missing SUPABASE_SERVICE_ROLE_KEY blocks the migration",
      quote: "the migration needs SUPABASE_SERVICE_ROLE_KEY which is not set",
      turn_idx: 2,
      turn_role: "assistant",
      resolved_in_session: false,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.durable).toBe(true);
      expect(result.durableDefaulted).toBe(true);
    }
  });

  it("a blocker missing durable but with resolved_in_session:true lands durable=false, durableDefaulted:true", () => {
    const result = parseMemoryRecord({
      kind: "blocker",
      text: "Missing SUPABASE_SERVICE_ROLE_KEY blocks the migration",
      quote: "the migration needs SUPABASE_SERVICE_ROLE_KEY which is not set",
      turn_idx: 2,
      turn_role: "assistant",
      resolved_in_session: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.durable).toBe(false);
      expect(result.durableDefaulted).toBe(true);
    }
  });

  it("a blocker missing BOTH durable and resolved_in_session defaults to durable=false (conservative)", () => {
    const result = parseMemoryRecord({
      kind: "blocker",
      text: "Missing SUPABASE_SERVICE_ROLE_KEY blocks the migration",
      quote: "the migration needs SUPABASE_SERVICE_ROLE_KEY which is not set",
      turn_idx: 2,
      turn_role: "assistant",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.durable).toBe(false);
      expect(result.durableDefaulted).toBe(true);
    }
  });

  it("a learning missing durable lands durable=false, durableDefaulted:true — nothing is dropped", () => {
    const result = parseMemoryRecord({
      kind: "learning",
      text: "Running turbo build while the dev server is up corrupts the shared .next cache",
      quote: "running turbo build while the dev server is up corrupts the shared cache",
      turn_idx: 4,
      turn_role: "assistant",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.durable).toBe(false);
      expect(result.durableDefaulted).toBe(true);
    }
  });

  it("a preference missing durable lands durable=false, durableDefaulted:true", () => {
    const result = parseMemoryRecord({
      kind: "preference",
      statement: "Setup should stay clean, with no extra background services.",
      owner_quote: "I want dark mode by default please",
      turn_idx: 3,
      turn_role: "user",
      thread: "editor prefs",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.durable).toBe(false);
      expect(result.durableDefaulted).toBe(true);
    }
  });

  it("an explicit durable is kept as-is and durableDefaulted is false", () => {
    const result = parseMemoryRecord({
      kind: "decision",
      text: "Switched retry backoff to exponential",
      quote: "we switched to exponential backoff",
      turn_idx: 1,
      turn_role: "assistant",
      durable: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.durable).toBe(true);
      expect(result.durableDefaulted).toBe(false);
    }
  });
});

describe("ExtractionWire", () => {
  it("accepts any array of plain objects, up to 20, without per-record validation", () => {
    const result = ExtractionWire.safeParse({ records: [{ kind: "preference", statement: "The owner..." }] });
    expect(result.success).toBe(true);
  });

  it("rejects a non-object records array", () => {
    expect(ExtractionWire.safeParse({ records: "not an array" }).success).toBe(false);
  });
});

describe("BlockerResolutionCheck (step2e finding 5)", () => {
  it("accepts a well-formed resolution list", () => {
    const result = BlockerResolutionCheck.safeParse({
      resolutions: [
        { index: 0, resolved_in_session: true },
        { index: 1, resolved_in_session: false },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects a malformed entry", () => {
    expect(
      BlockerResolutionCheck.safeParse({ resolutions: [{ index: "zero", resolved_in_session: true }] }).success,
    ).toBe(false);
  });
});
