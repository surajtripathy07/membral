// UX W6 review fix 4: the project page's top blockers print the blocker's
// text (markdown stripped, never the raw quote), under a "Top open blockers"
// label, with Today's "seen N×" recurrence.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { BrowseSessionMemory } from "@/lib/memory/session-memories-browse";
import { blockerText, dedupeBlockers, SessionMemoriesBlock } from "../memory-section";

function rec(id: string, text: string, quote: string | null): BrowseSessionMemory {
  return {
    id,
    kind: "blocker",
    text,
    quote,
    verified: true,
    turn_idx: 3,
    code_session_id: `s-${id}`,
    code_project_id: "p1",
    project_name: "billing",
    created_at: "2026-09-26T10:00:00Z",
    ref: null,
    from_sub_agent: false,
  };
}

describe("project top blockers", () => {
  it("strips markdown from the blocker text", () => {
    expect(blockerText("**MIGRATIONS UNAPPLIED TO PROD** — apply `103`")).toBe("MIGRATIONS UNAPPLIED TO PROD — apply 103");
  });

  it("collapses copies differing only in markdown/trailing punctuation into one, seen N×", () => {
    const out = dedupeBlockers([rec("a", "**Rotate the API key**.", null), rec("b", "Rotate the API key", null)]);
    expect(out).toHaveLength(1);
    expect(out[0].recurrence_count).toBe(2);
  });

  it("renders the text (not the quote), the label, seen N× and no visible **", () => {
    const html = renderToStaticMarkup(
      <SessionMemoriesBlock
        projectId="p1"
        grouped={{
          total: 2,
          outcomeCount: 0,
          groups: [
            {
              kind: "blocker",
              label: "Open blockers",
              total: 2,
              records: [
                rec("a", "**Rotate the API key**", "the key sits in a transcript, we have to rotate it"),
                rec("b", "Rotate the API key", "rotate it"),
              ],
            },
          ],
        } as never}
      />,
    );
    expect(html).toContain("Top open blockers");
    expect(html).toContain(">Rotate the API key<");
    expect(html).toContain("seen 2×");
    expect(html).not.toContain("**");
    expect(html).not.toContain("<q>");
    expect(html).toContain('title="the key sits in a transcript, we have to rotate it"');
  });
});
