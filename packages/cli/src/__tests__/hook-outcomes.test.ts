import { describe, expect, it } from "vitest";
import { classifyHookOutcome, summarizeHookLog, withHookOutcomes } from "../hook-outcomes.js";

describe("classifyHookOutcome", () => {
  it("buckets each outcome line", () => {
    expect(classifyHookOutcome("prompt-recall: served 3 records in 120 ms")).toBe("injected");
    expect(classifyHookOutcome("prompt-recall: continuation served 1 record in 90 ms")).toBe("injected");
    expect(classifyHookOutcome("prompt-recall: timeout after 4000 ms")).toBe("timeout");
    expect(classifyHookOutcome("prompt-recall: timeout in 1500 ms")).toBe("budget_hit");
    expect(classifyHookOutcome("prompt-recall: deferred after 4003 ms (budget 4000 ms, sent=true)")).toBe("timeout");
    expect(classifyHookOutcome("prompt-recall: deferred after 4003 ms (budget 4000 ms, sent=false)")).toBe("timeout");
    expect(classifyHookOutcome("prompt-recall: timeout in 2010 ms (request sent, no response)")).toBe("timeout");
    expect(classifyHookOutcome("prompt-recall: continuation deferred after 4003 ms (budget 4000 ms, sent=true)")).toBe(
      "timeout",
    );
    expect(classifyHookOutcome("prompt-recall: http 500 in 20 ms")).toBe("errors");
    expect(classifyHookOutcome("prompt-recall: network error in 20 ms")).toBe("errors");
    expect(classifyHookOutcome("prompt-recall: no_match in 300 ms")).toBe("empty");
    expect(classifyHookOutcome("prompt-recall: skipped short_prompt")).toBeNull();
  });
});

describe("summarizeHookLog", () => {
  it("sums per session and ignores lines without one", () => {
    const text = [
      JSON.stringify({ ts: "t", hook: "prompt", reason: "prompt-recall: served 2 records in 1 ms", session: "a" }),
      JSON.stringify({ ts: "t", hook: "prompt", reason: "prompt-recall: timeout in 1500 ms", session: "a" }),
      JSON.stringify({ ts: "t", hook: "prompt", reason: "prompt-recall: skipped short_prompt", session: "a" }),
      JSON.stringify({ ts: "t", hook: "prompt", reason: "prompt-recall: no_match in 3 ms" }),
      "not json",
    ].join("\n");
    const m = summarizeHookLog(text);
    expect(m.get("a")).toEqual({ calls: 3, injected: 1, empty: 0, budget_hit: 1, timeout: 0, errors: 0 });
    expect(m.size).toBe(1);
  });
  it("attaches only to a matching session", () => {
    const m = summarizeHookLog(
      JSON.stringify({ hook: "prompt", reason: "prompt-recall: no_match in 3 ms", session: "a" }),
    );
    // biome-ignore lint/suspicious/noExplicitAny: minimal session double
    const s = { sourceSessionId: "a" } as any;
    expect(withHookOutcomes(s, m).hookOutcomes?.empty).toBe(1);
    expect(withHookOutcomes({ ...s, sourceSessionId: "b" }, m)).toEqual({ sourceSessionId: "b" });
  });
});
