import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ServedUsedSummary } from "@/lib/memory/served-used";
import { ServedUsedBlock } from "../served-used-block";

const summary: ServedUsedSummary = {
  days: 7,
  since: "2026-10-03T00:00:00.000Z",
  totals: { served: 42, used: 9, ignored: 25, pending: 8, unlinked: 4 },
  surfaces: [
    { surface: "mcp", served: 30, used: 7, ignored: 20, pending: 3, unlinked: 1 },
    { surface: "preamble", served: 12, used: 2, ignored: 5, pending: 5, unlinked: 3 },
  ],
};

describe("ServedUsedBlock", () => {
  it("renders one row per surface with the five counts and honest copy", () => {
    const html = renderToStaticMarkup(<ServedUsedBlock summary={summary} />);
    expect(html).toContain("Served and used (last 7 days)");
    expect(html).toContain('data-testid="served-used-mcp"');
    expect(html).toContain('data-testid="served-used-preamble"');
    expect(html).toContain("Search and recall (MCP)");
    expect(html).toMatch(/>30<.*>7<.*>20<.*>3<.*>1</);
    expect(html).toContain("quoted or edited after serving");
    expect(html).toContain("Unlinked");
    expect(html).toContain("not linked to an uploaded session");
    expect(html).not.toContain("helped</");
    expect(html).not.toMatch(/gray-\d/);
  });

  it("renders the empty state for no rows and for a failed load", () => {
    const empty = { ...summary, surfaces: [] };
    expect(renderToStaticMarkup(<ServedUsedBlock summary={empty} />)).toContain("served-used-empty");
    expect(renderToStaticMarkup(<ServedUsedBlock summary={null} />)).toContain("served-used-empty");
  });
});
