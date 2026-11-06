import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CompareFig, Limits, Rich, WhenFits } from "./compare-parts";
import { APPROACHES, COMPARE_ROWS, FITS, LIMITS } from "./content";

describe("/compare content", () => {
  it("every row has one cell per approach", () => {
    expect(APPROACHES.length).toBe(4);
    for (const row of COMPARE_ROWS) expect(row.cells.length).toBe(APPROACHES.length);
  });

  it("Rich turns backtick pairs into code", () => {
    expect(renderToStaticMarkup(<>{Rich({ text: "run `membral up` now" })}</>)).toBe(
      "run <code>membral up</code> now",
    );
  });

  it("the figure is one table with a caption and a labelled cell per approach", () => {
    const html = renderToStaticMarkup(<CompareFig />);
    expect(html).toContain("<figcaption");
    expect(html).toContain("<table");
    expect((html.match(/data-label=/g) ?? []).length).toBe(COMPARE_ROWS.length * APPROACHES.length);
  });

  it("renders when-each-fits and limits", () => {
    const html = renderToStaticMarkup(
      <>
        <WhenFits />
        <Limits />
      </>,
    );
    expect(html).toContain(FITS.heading);
    expect(html).toContain(LIMITS.heading);
  });

  it("has no banned terms", () => {
    const text = JSON.stringify({ APPROACHES, COMPARE_ROWS, FITS, LIMITS });
    expect(text).not.toMatch(/graph|seamless|unlock|supercharge|ai-powered/i);
    expect(text).not.toMatch(/[—!]/);
  });
});
