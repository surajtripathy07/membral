// L8: the nomic-embed-text cosine table is the output of scripts/eval/recall-precision/calibration/. These tests
// re-run the (pure, deterministic) calibration on the committed labelled pairs and pin the table to it, so a change
// to either the table or the pairs cannot drift silently. No store, no network.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CALIBRATED_FAMILY_THRESHOLDS, DEFAULT_FAMILY_THRESHOLDS } from "../similarity";

const dir = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../../scripts/eval/recall-precision/calibration",
);
const read = (f: string) => JSON.parse(readFileSync(join(dir, f), "utf8"));
const modulePath = join(dir, "thresholds.mjs");

type Calibration = {
  result: {
    thresholds: Record<string, number | null>;
    counts: {
      max_adjudicated_distinct_cos: number;
      at: Record<string, { est_false_share: number; raw_false_merge: number; raw_missed_merge: number }>;
      floor: { chosen: { off_served: number; on_missed: number }; lexical_only_off_topic_queries: number };
    };
  };
};
async function run(): Promise<Calibration> {
  const mod = await import(/* @vite-ignore */ modulePath);
  return mod.calibrate(read("data.json"), read("adjudicated.json"));
}

// The calibration data holds real corpus text and is dropped from the public tree: skip cleanly without it.
// private calibration data; absent in the public tree
describe.skipIf(!existsSync(join(dir, "data.json")))("nomic-embed-text calibration (L8)", () => {
  it("the table in similarity.ts holds the chosen literal values", () => {
    expect(CALIBRATED_FAMILY_THRESHOLDS["nomic-embed-text"]).toEqual({
      in_batch_dedupe: 0.93,
      cross_session_dedup: 0.94,
      semantic_dedup: 0.86,
      supersede: 0.91,
      recurrence: 0.86,
      blocker_dismiss: 0.86,
      content_match: null,
      sem_floor: 0.66,
      mixed_sem_floor: 0.61,
      sql_cut: 0.51,
    });
  });

  it("re-running the calibration on the committed pairs reproduces those literals (drift guard)", async () => {
    const { result } = await run();
    expect(result.thresholds).toEqual({
      in_batch_dedupe: 0.93,
      cross_session_dedup: 0.94,
      semantic_dedup: 0.86,
      supersede: 0.91,
      recurrence: 0.86,
      blocker_dismiss: 0.86,
      content_match: null,
      sem_floor: 0.66,
      mixed_sem_floor: 0.61,
      sql_cut: 0.51,
    });
  });

  it("uses the tuning split only", () => {
    const data = read("data.json");
    expect(data.split).toBe("tuning");
    const bench = read("../bench.json");
    const tuning = new Set(
      bench.queries.filter((q: { split: string }) => q.split === "tuning").map((q: { id: string }) => q.id),
    );
    for (const q of data.queries as Array<{ id: string }>) expect(tuning.has(q.id)).toBe(true);
  });

  it("keeps the step ordering of the default family: recurrence <= semantic <= supersede <= in-batch < cross-session", () => {
    const t = CALIBRATED_FAMILY_THRESHOLDS["nomic-embed-text"];
    const n = (k: string) => t[k as keyof typeof t] as number;
    expect(n("recurrence")).toBeLessThanOrEqual(n("semantic_dedup"));
    expect(n("semantic_dedup")).toBeLessThanOrEqual(n("supersede"));
    expect(n("supersede")).toBeLessThanOrEqual(n("in_batch_dedupe"));
    expect(n("in_batch_dedupe")).toBeLessThan(n("cross_session_dedup"));
    expect(DEFAULT_FAMILY_THRESHOLDS.recurrence).toBeLessThanOrEqual(DEFAULT_FAMILY_THRESHOLDS.supersede);
  });

  it("silent drops sit above every adjudicated distinct pair; retirements keep the estimated false share <= 10%", async () => {
    const { result } = await run();
    const t = result.thresholds;
    expect(t.in_batch_dedupe as number).toBeGreaterThan(result.counts.max_adjudicated_distinct_cos);
    expect(result.counts.at.in_batch_dedupe.est_false_share).toBeLessThanOrEqual(0.1);
    expect(result.counts.at.cross_session_dedup.est_false_share).toBe(0);
    expect(result.counts.at.semantic_dedup.est_false_share).toBeLessThanOrEqual(0.1);
    expect(result.counts.at.supersede.est_false_share).toBeLessThanOrEqual(0.1);
  });

  it("the hosted 0.80 cut would be worse on this model (that is why it is not reused)", async () => {
    const { result } = await run();
    expect(result.counts.at["default-family value 0.80"].est_false_share).toBeGreaterThan(0.1);
  });

  it("the floor serves at most the lexical-only off-topic queries and loses few on-topic ones", async () => {
    const { result } = await run();
    const f = result.counts.floor;
    expect(f.chosen.off_served).toBe(f.lexical_only_off_topic_queries);
    expect(f.chosen.on_missed).toBeLessThanOrEqual(10);
  });
});
