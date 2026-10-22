// Pure-logic tests for the /import page's upload loop (NEW-3, round-2
// review). This repo has no jsdom/@testing-library set up (see
// src/components/second-brain/__tests__/bootstrap-panel.test.tsx's header),
// so the batch-loop's accumulation/stall-tracking lives in upload-loop.ts as
// two pure, exported functions (foldUploadResponse, nextStallState) that can
// be unit-tested directly without rendering the component or mocking fetch —
// this also sidesteps Next.js's typed-routes restriction on what a page.tsx
// file is allowed to export (see upload-loop.ts's header).
//
// The bug this covers: the batch loop used to throw (on a non-ok response,
// or on exceeding MAX_STALL_RETRIES) WITHOUT ever calling setResult(cumulative)
// first — so a failure partway through a multi-chunk import silently
// discarded every import/update/error count already accumulated in that run.
// The component now calls setResult(running) immediately before each throw
// (see page.tsx); this file verifies the `running` value being preserved is
// actually correct at every step.
import { describe, expect, it } from "vitest";
import { foldUploadResponse, INITIAL_STALL_STATE, nextStallState } from "../upload-loop";

function baseResult() {
  return {
    provider: null as "chatgpt" | "claude" | null,
    total: 0,
    imported: 0,
    updated: 0,
    skipped: [],
    skippedCount: 0,
    errors: [],
    durationMs: 0,
  };
}

describe("foldUploadResponse", () => {
  it("accumulates imported/updated/durationMs across responses", () => {
    const step1 = foldUploadResponse(baseResult(), {
      total: 100,
      imported: 40,
      updated: 10,
      skipped: [],
      durationMs: 500,
      partial: true,
      nextOffset: 50,
    });
    expect(step1.imported).toBe(40);
    expect(step1.updated).toBe(10);
    expect(step1.durationMs).toBe(500);

    const step2 = foldUploadResponse(step1, {
      total: 100,
      imported: 30,
      updated: 5,
      skipped: [],
      durationMs: 300,
      partial: false,
    });
    expect(step2.imported).toBe(70);
    expect(step2.updated).toBe(15);
    expect(step2.durationMs).toBe(800);
  });

  it("NEW-3: preserves errors accumulated across earlier responses instead of overwriting them", () => {
    const step1 = foldUploadResponse(baseResult(), {
      total: 10,
      imported: 5,
      updated: 0,
      skipped: [],
      errors: ["chatgpt:c2: unsupported Unicode escape sequence"],
      durationMs: 100,
      partial: true,
      nextOffset: 10,
    });
    expect(step1.errors).toEqual(["chatgpt:c2: unsupported Unicode escape sequence"]);

    // A LATER response with its own error must ADD to, not replace, the
    // errors already collected — this is exactly what was silently lost
    // before NEW-3 when the loop threw without ever folding this response in.
    const step2 = foldUploadResponse(step1, {
      total: 10,
      imported: 4,
      updated: 0,
      skipped: [],
      errors: ["chatgpt:c7: db exploded"],
      durationMs: 50,
      partial: false,
    });
    expect(step2.errors).toEqual(["chatgpt:c2: unsupported Unicode escape sequence", "chatgpt:c7: db exploded"]);
    expect(step2.imported).toBe(9);
  });

  it("latches the detected provider from the first response that reports one", () => {
    const step1 = foldUploadResponse(baseResult(), {
      total: 10,
      imported: 10,
      updated: 0,
      skipped: [],
      durationMs: 10,
      partial: true,
      nextOffset: 10,
      provider: "chatgpt",
    });
    expect(step1.provider).toBe("chatgpt");

    // A later response with no `provider` field (e.g. resumed offset >= end)
    // doesn't clobber the already-detected provider.
    const step2 = foldUploadResponse(step1, {
      total: 10,
      imported: 0,
      updated: 0,
      skipped: [],
      durationMs: 5,
      partial: false,
    });
    expect(step2.provider).toBe("chatgpt");
  });

  it("uses the response's skippedCount when present, else falls back to skipped.length", () => {
    const withCount = foldUploadResponse(baseResult(), {
      total: 10,
      imported: 8,
      updated: 0,
      skipped: [{ id: "a", reason: "bad" }],
      skippedCount: 25,
      durationMs: 10,
      partial: false,
    });
    expect(withCount.skippedCount).toBe(25);

    const withoutCount = foldUploadResponse(baseResult(), {
      total: 10,
      imported: 8,
      updated: 0,
      skipped: [{ id: "a", reason: "bad" }],
      durationMs: 10,
      partial: false,
    });
    expect(withoutCount.skippedCount).toBe(1);
  });

  it("replaces `total` with each response's value (server-authoritative, not additive)", () => {
    const step1 = foldUploadResponse(baseResult(), {
      total: 150,
      imported: 100,
      updated: 0,
      skipped: [],
      durationMs: 10,
      partial: true,
      nextOffset: 100,
    });
    expect(step1.total).toBe(150);
    const step2 = foldUploadResponse(step1, {
      total: 150,
      imported: 50,
      updated: 0,
      skipped: [],
      durationMs: 10,
      partial: false,
    });
    expect(step2.total).toBe(150);
  });
});

describe("nextStallState", () => {
  it("resets stallRetries to 0 whenever nextOffset makes forward progress", () => {
    const s1 = nextStallState(INITIAL_STALL_STATE, 0, 100);
    expect(s1.stallRetries).toBe(0);
    const s2 = nextStallState(s1, 100, 200);
    expect(s2.stallRetries).toBe(0);
  });

  it("increments stallRetries on each consecutive no-progress response at the SAME offset", () => {
    let s = nextStallState(INITIAL_STALL_STATE, 100, 100);
    expect(s.stallRetries).toBe(1);
    s = nextStallState(s, 100, 100);
    expect(s.stallRetries).toBe(2);
    s = nextStallState(s, 100, 100);
    expect(s.stallRetries).toBe(3);
  });

  it("resets the streak (starts a new one at 1) if the no-progress offset changes", () => {
    let s = nextStallState(INITIAL_STALL_STATE, 100, 100);
    expect(s.stallRetries).toBe(1);
    s = nextStallState(s, 100, 100);
    expect(s.stallRetries).toBe(2);
    // Progress happens once (nextOffset 150 > offset 100) resetting the streak...
    s = nextStallState(s, 100, 150);
    expect(s.stallRetries).toBe(0);
    // ...then stalls again at a NEW offset — starts back at 1, not 3.
    s = nextStallState(s, 150, 150);
    expect(s.stallRetries).toBe(1);
  });

  it("treats nextOffset < offset (should never happen, but defensively) the same as a stall", () => {
    const s = nextStallState(INITIAL_STALL_STATE, 100, 50);
    expect(s.stallRetries).toBe(1);
  });
});
