import { beforeEach, describe, expect, it } from "vitest";
import {
  EMBED_BREAKER_FAILURES,
  embedBackoffDeps,
  embedInput,
  embedUnitTexts,
  resetEmbedBackoff,
  SPLIT_RETRY_FACTOR,
  UNIT_EMBED_BATCH_SIZE,
  type UnitEmbedder,
  unitTextHash,
} from "../embed";
import { fakeEmbedder } from "./helpers";

const err500 = () => Object.assign(new Error("500 do embedding request: EOF"), { status: 500 });
const texts = (n: number) => Array.from({ length: n }, (_, i) => `text number ${i}`);
/** Wraps the deterministic fake: `fail(batch)` returns an error to throw, or null to succeed. */
function flaky(fail: (batch: string[]) => Error | null) {
  const base = fakeEmbedder();
  const calls: string[][] = [];
  const e: UnitEmbedder = {
    family: base.family,
    embedBatch: async (batch) => {
      calls.push(batch);
      const f = fail(batch);
      if (f) throw f;
      return base.embedBatch(batch);
    },
  };
  return { e, calls };
}

describe("embedUnitTexts: split on transient failure", () => {
  const real = { ...embedBackoffDeps };
  beforeEach(() => {
    resetEmbedBackoff();
    embedBackoffDeps.sleep = async () => {};
    embedBackoffDeps.random = () => 0;
    return () => Object.assign(embedBackoffDeps, real);
  });

  it("a 500 on a batch of 8 recovers every text by splitting", async () => {
    let first = true;
    const { e, calls } = flaky(() => {
      if (first) {
        first = false;
        return err500();
      }
      return null;
    });
    const r = await embedUnitTexts(texts(8), e, e.family);
    expect(r.failed).toBe(0);
    expect(r.embedded).toBe(8);
    expect([...r.vectors.values()].every((v) => v?.some((n) => n !== 0))).toBe(true);
    expect(calls.map((c) => c.length)).toEqual([8, 4, 4]);
  });

  it("a connection error with no status also splits", async () => {
    let first = true;
    const { e } = flaky(() => {
      if (!first) return null;
      first = false;
      return new Error("socket hang up");
    });
    const r = await embedUnitTexts(texts(4), e, e.family);
    expect(r.embedded).toBe(4);
  });

  it("a 429 does not split (PR 2 behaviour: one paced retry, then the breaker)", async () => {
    const { e, calls } = flaky(() => Object.assign(new Error("rate"), { status: 429 }));
    const r = await embedUnitTexts(texts(8), e, e.family);
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.length === 8)).toBe(true);
    expect(r.failed).toBe(8);
    expect([...r.vectors.values()].every((v) => v === null)).toBe(true);
  });

  it("a 4xx other than 429 does not split", async () => {
    const { e, calls } = flaky(() => Object.assign(new Error("bad"), { status: 400 }));
    const r = await embedUnitTexts(texts(8), e, e.family);
    expect(calls).toHaveLength(1);
    expect(r.failed).toBe(8);
  });

  it("a permanently failing text ends null while its neighbours get vectors", async () => {
    const poison = "text number 5";
    const { e } = flaky((b) => (b.some((t) => t.endsWith(poison)) ? err500() : null));
    const r = await embedUnitTexts(texts(8), e, e.family);
    expect(r.embedded).toBe(7);
    expect(r.failed).toBe(1);
    const nulls = [...r.vectors.values()].filter((v) => v === null);
    expect(nulls).toHaveLength(1);
  });

  it("the retry budget binds: a small factor leaves texts failed, a larger one recovers them", async () => {
    const poison = "text number 5";
    const bad = (b: string[]) => (b.some((t) => t.endsWith(poison)) ? err500() : null);
    // factor 3, one batch: budget 3. The first expand spends 2 (both halves), leaving 1, so the failing half is
    // abandoned whole: 1 + 2 calls, 4 texts failed. Without the `retryBudget < 2` check the split would continue.
    const tight = flaky(bad);
    const r3 = await embedUnitTexts(texts(8), tight.e, tight.e.family, [], { splitRetryFactor: 3 });
    expect(tight.calls).toHaveLength(1 + 2);
    expect(r3.embedded).toBe(4);
    expect(r3.failed).toBe(4);
    expect([...r3.vectors.values()].filter((v) => v === null)).toHaveLength(4);
    // factor 1: budget 1 < 2, no split at all.
    const one = flaky(bad);
    const r1 = await embedUnitTexts(texts(8), one.e, one.e.family, [], { splitRetryFactor: 1 });
    expect(one.calls).toHaveLength(1);
    expect(r1.failed).toBe(8);
    // default factor: the same input isolates the poison text.
    const roomy = flaky(bad);
    const r16 = await embedUnitTexts(texts(8), roomy.e, roomy.e.family);
    expect(r16.embedded).toBe(7);
    expect(r16.failed).toBe(1);
    expect(roomy.calls.length).toBeGreaterThan(3);
    expect(roomy.calls.length - 1).toBeLessThanOrEqual(SPLIT_RETRY_FACTOR);
  });

  it("each vector maps back to its own text after a split", async () => {
    let first = true;
    const { e } = flaky(() => {
      if (!first) return null;
      first = false;
      return err500();
    });
    const t = texts(9);
    const r = await embedUnitTexts(t, e, e.family);
    const direct = await fakeEmbedder().embedBatch(t.map((x) => embedInput(x, e.family)));
    expect(r.failed).toBe(0);
    t.forEach((x, i) => {
      expect(r.vectors.get(unitTextHash(x, e.family))).toEqual(direct[i]);
    });
    expect(new Set(direct.map((v) => v.indexOf(1))).size).toBeGreaterThan(1); // the vectors really are distinct
  });

  it("the breaker still trips on a server that is down", async () => {
    const { e, calls } = flaky(() => err500());
    const r = await embedUnitTexts(texts(UNIT_EMBED_BATCH_SIZE * 3), e, e.family);
    expect(calls).toHaveLength(EMBED_BREAKER_FAILURES);
    expect(r.embedded).toBe(0);
    expect(r.failed).toBe(UNIT_EMBED_BATCH_SIZE * 3);
    expect([...r.vectors.values()].every((v) => v === null)).toBe(true);
  });
});
