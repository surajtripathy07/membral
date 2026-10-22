// UX W5 (cost-consistency.md #5, ADR 0032 §1.3 finding 4): the session
// page's facts strip and the /code loaders never read the code-KG mirror's
// stored `props.est_cost_usd` snapshot — every session cost is computed live
// (aggregateAgentStats), the same path as the session header.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pickSessionRunProps } from "../queries";

/** Source with // and /* *\/ comments removed, so a comment that names the field does not count as a read. */
function codeOnly(file: string): string {
  const src = readFileSync(join(__dirname, "..", file), "utf8");
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

describe("no read of the stored est_cost_usd snapshot", () => {
  it.each(["view.ts", "queries.ts"])("%s never names est_cost_usd outside a comment", (file) => {
    expect(codeOnly(file)).not.toMatch(/est_cost_usd/);
  });

  it("pickSessionRunProps keeps models and usage and drops the stored cost", () => {
    const whole = { id: "n1", props: { models: ["m"], usage: { inputTokens: 1 }, est_cost_usd: { amount: 9 } } };
    expect(pickSessionRunProps(whole)).toEqual({ models: ["m"], usage: { inputTokens: 1 } });
    const projected = { id: "n1", models: ["m"], usage: null };
    expect(pickSessionRunProps(projected)).toEqual({ models: ["m"] });
  });
});
