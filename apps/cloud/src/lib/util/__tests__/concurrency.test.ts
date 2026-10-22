import { describe, expect, it } from "vitest";
import { mapWithConcurrency, runPool } from "../concurrency";

describe("mapWithConcurrency (#173)", () => {
  it("keeps input order and never exceeds the limit", async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapWithConcurrency([5, 1, 4, 2, 3, 0, 6], 3, async (n, i) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, n));
      inFlight -= 1;
      return `${i}:${n}`;
    });
    expect(out).toEqual(["0:5", "1:1", "2:4", "3:2", "4:3", "5:0", "6:6"]);
    expect(peak).toBe(3);
  });

  it("returns [] for no items", async () => {
    expect(await mapWithConcurrency([], 6, async () => 1)).toEqual([]);
  });

  it("rejects on the first failure and claims no new items after it", async () => {
    const started: number[] = [];
    await expect(
      mapWithConcurrency([0, 1, 2, 3, 4], 1, async (n) => {
        started.push(n);
        if (n === 1) throw new Error("boom");
        return n;
      }),
    ).rejects.toThrow("boom");
    expect(started).toEqual([0, 1]);
  });
});

describe("runPool", () => {
  it("runs every item through worker at the given concurrency", async () => {
    const seen: number[] = [];
    await runPool([1, 2, 3, 4], 2, async (n) => {
      seen.push(n);
    });
    expect(seen.sort()).toEqual([1, 2, 3, 4]);
  });

  it("is a no-op on an empty list", async () => {
    let calls = 0;
    await runPool([], 4, async () => {
      calls++;
    });
    expect(calls).toBe(0);
  });

  it("without shouldStop, behaves exactly as before (backward compatible)", async () => {
    const seen: number[] = [];
    await runPool([1, 2, 3], 1, async (n) => {
      seen.push(n);
    });
    expect(seen).toEqual([1, 2, 3]);
  });

  describe("shouldStop (issue #21)", () => {
    it("stops claiming NEW items once shouldStop() flips true, without aborting in-flight ones", async () => {
      let stop = false;
      const started: number[] = [];
      await runPool(
        [1, 2, 3, 4, 5],
        1,
        async (n) => {
          started.push(n);
          if (n === 2) stop = true; // flips after the 2nd item starts
        },
        () => stop,
      );
      // Item 3 onward is never claimed once stop flips true after item 2.
      expect(started).toEqual([1, 2]);
    });

    it("a shouldStop that is true from the start claims nothing", async () => {
      const started: number[] = [];
      await runPool(
        [1, 2, 3],
        2,
        async (n) => {
          started.push(n);
        },
        () => true,
      );
      expect(started).toEqual([]);
    });

    it("with concurrency > 1, halts every slot once the flag flips, leaving the remainder unclaimed", async () => {
      let stop = false;
      const started: number[] = [];
      await runPool(
        [1, 2, 3, 4, 5, 6],
        3,
        async (n) => {
          started.push(n);
          if (started.length >= 3) stop = true;
        },
        () => stop,
      );
      // Exactly the first wave (one per slot) runs; no slot claims a second item.
      expect(started.length).toBe(3);
    });
  });
});
