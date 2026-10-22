// Goal 2026-09-26 W2 (P0c): the project summary never prints one sentence twice.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { dedupWhatBuilt, ProjectSummary } from "../project-summary";

describe("ProjectSummary", () => {
  it("the project summary never repeats a sentence", () => {
    const line = "148 sessions on acme/billing.";
    const html = renderToStaticMarkup(<ProjectSummary summary={line} whatBuilt={line} />);
    expect(html.split(line)).toHaveLength(2); // exactly one occurrence
    expect(html.match(/<p>/g)).toHaveLength(1);
  });

  it("renders what_built when it says something the summary does not", () => {
    const html = renderToStaticMarkup(<ProjectSummary summary="Built the billing service." whatBuilt="Shipped invoice retries." />);
    expect(html).toContain("Built the billing service.");
    expect(html).toContain("Shipped invoice retries.");
    expect(html.match(/<p>/g)).toHaveLength(2);
  });

  it("skips an empty what_built (the rollup fallback shape)", () => {
    const html = renderToStaticMarkup(<ProjectSummary summary="3 sessions on acme/billing." whatBuilt="" />);
    expect(html.match(/<p>/g)).toHaveLength(1);
  });

  it("F16: case, whitespace and trailing punctuation do not make what_built a new sentence", () => {
    const summary = "Builds the  billing ledger.";
    expect(dedupWhatBuilt(summary, "builds the billing ledger")).toBe("");
    expect(dedupWhatBuilt(summary, "  BUILDS THE BILLING LEDGER!  ")).toBe("");
    expect(dedupWhatBuilt(summary, "Adds idempotent debits.")).toBe("Adds idempotent debits.");
    const html = renderToStaticMarkup(<ProjectSummary summary={summary} whatBuilt="builds the billing ledger" />);
    expect(html.match(/<p>/g)).toHaveLength(1);
  });
});
