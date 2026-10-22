import { beforeEach, describe, expect, it } from "vitest";
import { enqueueRawUnitTask, RAW_UNIT_CONCURRENCY, RAW_UNIT_QUEUE_MAX, resetRawUnitQueue } from "../queue";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("raw-unit task queue", () => {
  beforeEach(resetRawUnitQueue);

  it("40 scheduled tasks never run more than the concurrency at once, in FIFO order", async () => {
    let active = 0;
    let peak = 0;
    const order: number[] = [];
    const all = Array.from({ length: 40 }, (_, i) =>
      enqueueRawUnitTask(`s${i}`, async () => {
        active++;
        peak = Math.max(peak, active);
        await tick();
        order.push(i);
        active--;
      }),
    );
    await Promise.all(all);
    expect(peak).toBe(RAW_UNIT_CONCURRENCY);
    expect(order).toEqual(Array.from({ length: 40 }, (_, i) => i));
  });

  it("a later task for the same session supersedes an earlier pending one", async () => {
    const ran: string[] = [];
    const gate = enqueueRawUnitTask("blocker", async () => {
      await tick();
      await tick();
    });
    const a = enqueueRawUnitTask("same", async () => void ran.push("old"));
    const b = enqueueRawUnitTask("same", async () => void ran.push("new"));
    await Promise.all([gate, a, b]);
    expect(ran).toEqual(["new"]);
  });

  it("a throwing task does not stop the queue", async () => {
    const ran: string[] = [];
    const a = enqueueRawUnitTask("a", async () => {
      throw new Error("boom");
    });
    const b = enqueueRawUnitTask("b", async () => void ran.push("b"));
    await expect(Promise.all([a, b])).resolves.toBeDefined();
    expect(ran).toEqual(["b"]);
  });

  it("past the bound the oldest pending task is dropped", async () => {
    const ran: string[] = [];
    const first = enqueueRawUnitTask("run", () => tick());
    const all = [first];
    for (let i = 0; i <= RAW_UNIT_QUEUE_MAX; i++)
      all.push(enqueueRawUnitTask(`p${i}`, async () => void ran.push(`p${i}`)));
    await Promise.all(all);
    expect(ran).not.toContain("p0");
    expect(ran).toContain(`p${RAW_UNIT_QUEUE_MAX}`);
  });
});
