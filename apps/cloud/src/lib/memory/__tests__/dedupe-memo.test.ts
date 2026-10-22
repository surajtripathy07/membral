// The derived token sets are memoized per text (the pairwise collapse otherwise re-tokenizes once per pair):
// the memo must not change any result, must return the same shared set on a repeat, and must stay bounded.
import { describe, expect, it } from "vitest";
import { sameFactByVector, sameThing, tokenSet } from "../dedupe";

describe("dedupe memo", () => {
  it("returns equal, shared sets for a repeated text", () => {
    const a = tokenSet("Retry the import on a 504 from the gateway");
    expect(tokenSet("Retry the import on a 504 from the gateway")).toBe(a);
    expect([...a].sort()).toEqual(["504", "gateway", "import", "retry"]);
  });

  it("keeps the identifier, verb and environment guards per pair, in either order", () => {
    const m118 = {
      kind: "outcome",
      ref: null,
      text: "Migration 118 applied to the local store and verified by the smoke run today",
    };
    const m119 = {
      kind: "outcome",
      ref: null,
      text: "Migration 119 applied to the local store and verified by the smoke run today",
    };
    for (let i = 0; i < 3; i++) {
      expect(sameThing(m118, m119)).toBe(false);
      expect(sameThing(m119, m118)).toBe(false);
      expect(sameThing(m118, { ...m118 })).toBe(true);
    }
    const staging = {
      kind: "outcome",
      ref: null,
      text: "Deployed the cloud app to staging after the smoke run passed cleanly",
    };
    const prod = {
      kind: "outcome",
      ref: null,
      text: "Deployed the cloud app to production after the smoke run passed cleanly",
    };
    expect(sameFactByVector(staging, prod, 0.99, 0.9)).toBe(false);
  });

  it("stays correct past the cache bound", () => {
    for (let i = 0; i < 4_500; i++) tokenSet(`unique text number ${i} about recall latency`);
    expect([...tokenSet("Retry the import on a 504")].sort()).toEqual(["504", "import", "retry"]);
  });
});
