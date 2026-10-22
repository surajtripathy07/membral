import { describe, expect, expectTypeOf, it } from "vitest";
import {
  AGENT_RESOLVED_RETIRE_REASON,
  CARRIED_SUFFIX,
  DUPLICATE_RETIRE_REASON,
  type FixedRetireReason,
  isRetireReason,
  RERUN_RETIRE_REASON,
  RESOLVED_IN_SESSION_RETIRE_REASON,
  RESOLVED_LATER_RETIRE_REASON,
  RESOLVED_OBSERVED_RETIRE_REASON,
  RETIRE_REASONS,
  type RetireReason,
  SEMANTIC_DUPLICATE_RETIRE_REASON,
  SUBAGENT_BRIEF_RETIRE_REASON,
  UNVERIFIED_RETIRE_PREFIX,
  USER_IGNORED_RETIRE_REASON,
  USER_RESOLVED_RETIRE_REASON,
} from "../retire-reasons";

// The stored strings, typed in by hand: a change here is a data change, not a refactor.
const FIXTURE = [
  "agent_resolved",
  "duplicate",
  "rerun",
  "resolved_in_session",
  "resolved_later",
  "resolved_observed",
  "semantic_duplicate",
  "subagent_brief",
  "user_ignored",
  "user_resolved",
] as const;

describe("retire reasons", () => {
  it("names each literal with its exact stored string", () => {
    expect({
      AGENT_RESOLVED_RETIRE_REASON,
      DUPLICATE_RETIRE_REASON,
      RERUN_RETIRE_REASON,
      RESOLVED_IN_SESSION_RETIRE_REASON,
      RESOLVED_LATER_RETIRE_REASON,
      RESOLVED_OBSERVED_RETIRE_REASON,
      SEMANTIC_DUPLICATE_RETIRE_REASON,
      SUBAGENT_BRIEF_RETIRE_REASON,
      USER_IGNORED_RETIRE_REASON,
      USER_RESOLVED_RETIRE_REASON,
      UNVERIFIED_RETIRE_PREFIX,
      CARRIED_SUFFIX,
    }).toEqual({
      AGENT_RESOLVED_RETIRE_REASON: "agent_resolved",
      DUPLICATE_RETIRE_REASON: "duplicate",
      RERUN_RETIRE_REASON: "rerun",
      RESOLVED_IN_SESSION_RETIRE_REASON: "resolved_in_session",
      RESOLVED_LATER_RETIRE_REASON: "resolved_later",
      RESOLVED_OBSERVED_RETIRE_REASON: "resolved_observed",
      SEMANTIC_DUPLICATE_RETIRE_REASON: "semantic_duplicate",
      SUBAGENT_BRIEF_RETIRE_REASON: "subagent_brief",
      USER_IGNORED_RETIRE_REASON: "user_ignored",
      USER_RESOLVED_RETIRE_REASON: "user_resolved",
      UNVERIFIED_RETIRE_PREFIX: "unverified",
      CARRIED_SUFFIX: ":carried",
    });
  });

  it("RETIRE_REASONS is the sorted, duplicate-free fixture set", () => {
    expect(new Set(RETIRE_REASONS).size).toBe(RETIRE_REASONS.length);
    expect([...RETIRE_REASONS]).toEqual([...FIXTURE]);
    expect([...RETIRE_REASONS].sort()).toEqual([...RETIRE_REASONS]);
  });

  it("isRetireReason accepts every member and the parameterised forms", () => {
    for (const r of FIXTURE) expect(isRetireReason(r)).toBe(true);
    expect(isRetireReason("unverified")).toBe(true);
    expect(isRetireReason("unverified:x")).toBe(true);
    expect(isRetireReason("user_resolved:carried")).toBe(true);
    expect(isRetireReason("user_ignored:carried")).toBe(true);
  });

  it("isRetireReason rejects anything else", () => {
    for (const r of ["nope", "", "resolved", "ignored", "rerun:carried", "unverifiedx", "RERUN"]) {
      expect(isRetireReason(r)).toBe(false);
    }
  });

  it("pins the union members", () => {
    expectTypeOf<FixedRetireReason>().toEqualTypeOf<(typeof FIXTURE)[number]>();
    expectTypeOf<RetireReason>().toEqualTypeOf<
      | (typeof FIXTURE)[number]
      | "unverified"
      | `unverified:${string}`
      | "user_resolved:carried"
      | "user_ignored:carried"
      | "agent_resolved:carried"
    >();
  });
});
