// L5: the nomic-embed-text lexical minimum is the output of scripts/eval/recall-precision/calibration/abstain.mjs
// (tuning split only). Pins the table to it; skipped cleanly where the private calibration data is dropped.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LEXICAL_MIN_HITS } from "../similarity";

const dir = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../../scripts/eval/recall-precision/calibration",
);

// private calibration data; absent in the public tree
describe.skipIf(!existsSync(join(dir, "signals.json")))("nomic-embed-text abstention floor (L5)", () => {
  it("the table holds the literal and re-running the calibration reproduces it", async () => {
    expect(LEXICAL_MIN_HITS["nomic-embed-text"]).toBe(4);
    const mod = await import(/* @vite-ignore */ join(dir, "abstain.mjs"));
    const result = mod.calibrate(JSON.parse(readFileSync(join(dir, "signals.json"), "utf8")));
    expect(result.chosen).toBe(LEXICAL_MIN_HITS["nomic-embed-text"]);
    const chosen = result.curve[result.chosen];
    expect(chosen.abstain_false_serve).toBeLessThanOrEqual(0.05);
    expect(chosen.p5_proxy).toBeGreaterThanOrEqual(result.curve[0].p5_proxy);
    expect(chosen.answerable_emptied).toBe(0);
  });

  it("uses the tuning split only", () => {
    const sig = JSON.parse(readFileSync(join(dir, "signals.json"), "utf8"));
    const bench = JSON.parse(readFileSync(join(dir, "../bench.json"), "utf8"));
    const tuning = new Set(
      bench.queries.filter((q: { split: string }) => q.split === "tuning").map((q: { id: string }) => q.id),
    );
    expect(sig.queries.length).toBe(tuning.size);
    for (const q of sig.queries as Array<{ id: string }>) expect(tuning.has(q.id)).toBe(true);
  });
});
