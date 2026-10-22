import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { summarizeDogfood } from "@/lib/memory/dogfood-signals";
import { DogfoodPanel } from "../dogfood-panel";

const signals = (days: number) =>
  summarizeDogfood(
    {
      events: [
        {
          id: "e",
          tool: "memory_search",
          surface: "mcp",
          record_ids: ["r1"],
          influenced_edit: false,
          influenced_quote: true,
          influence_checked_at: "x",
          served_at: "2026-10-08T00:00:00Z",
          code_session_id: "s1",
        },
      ],
      verdicts: [{ code_session_id: "s1", verdict: "contradicted", created_at: "2026-10-08T00:00:00Z" }],
      feedback: [
        {
          id: "f1",
          sentiment: "stale",
          surface: "prompt_hook",
          quote: "that recall was stale, the PR merged yesterday",
          code_session_id: "s1",
          turn_idx: 7,
          created_at: "2026-10-08T00:00:00Z",
        },
      ],
      hooks: [],
    },
    days,
    "x",
  );

describe("DogfoodPanel", () => {
  it("renders 7- and 30-day counts and quotes linked to the turn", () => {
    const html = renderToStaticMarkup(<DogfoodPanel data={{ week: signals(7), month: signals(30) }} />);
    expect(html).toContain("Membral on Membral");
    expect(html).toContain('data-testid="dogfood-contradicted"');
    expect(html).toContain("7 days");
    expect(html).toContain("30 days");
    expect(html).toContain('href="/code/session/s1?turn=7#turn-7"');
    expect(html).toContain("the PR merged yesterday");
    expect(html).not.toContain('data-testid="dogfood-empty"');
  });

  it("shows the empty state for a fresh user or a failed read", () => {
    const empty = summarizeDogfood({ events: [], verdicts: [], feedback: [], hooks: [] }, 7, "x");
    expect(renderToStaticMarkup(<DogfoodPanel data={{ week: empty, month: empty }} />)).toContain("dogfood-empty");
    expect(renderToStaticMarkup(<DogfoodPanel data={null} />)).toContain("dogfood-empty");
  });
});
