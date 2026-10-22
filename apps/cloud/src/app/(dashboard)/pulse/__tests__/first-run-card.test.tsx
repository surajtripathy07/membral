// "Your history" card (W5 D4): pure render, no fetch.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { FirstRunHistory } from "@/lib/code-sessions/first-run";
import { FirstRunCard } from "../first-run-card";

const history: FirstRunHistory = {
  total: 47,
  perHarness: [
    { source: "claude-code", label: "Claude Code", count: 41 },
    { source: "opencode", label: "opencode", count: 6 },
  ],
  subAgents: 29,
  earliestStart: "2026-09-05T08:00:00.000Z",
  latestStart: "2026-10-02T08:00:00.000Z",
  memoryCount: 0,
};

describe("FirstRunCard", () => {
  it("several harnesses, zero memories", () => {
    expect(renderToStaticMarkup(<FirstRunCard history={history} />)).toMatchInlineSnapshot(`"<section class="mt-6" data-testid="first-run-card" aria-labelledby="pulse-first-run"><h2 id="pulse-first-run" class="section-label">Your history</h2><dl class="mt-3 rounded-card border border-line bg-surface"><div class="flex gap-3 border-line-soft border-b px-4 py-2 last:border-b-0"><dt class="w-24 shrink-0 text-body-sm text-muted">Sessions</dt><dd class="min-w-0 text-body-sm text-ink">47 (Claude Code 41, opencode 6)</dd></div><div class="flex gap-3 border-line-soft border-b px-4 py-2 last:border-b-0"><dt class="w-24 shrink-0 text-body-sm text-muted">Sub-agents</dt><dd class="min-w-0 text-body-sm text-ink">29 of 47 (62%)</dd></div><div class="flex gap-3 border-line-soft border-b px-4 py-2 last:border-b-0"><dt class="w-24 shrink-0 text-body-sm text-muted">Span</dt><dd class="min-w-0 text-body-sm text-ink">2026-09-05 to 2026-10-02 (28 days)</dd></div><div class="flex gap-3 border-line-soft border-b px-4 py-2 last:border-b-0"><dt class="w-24 shrink-0 text-body-sm text-muted">Memories</dt><dd class="min-w-0 text-body-sm text-ink">0 (memories appear as extraction runs)</dd></div></dl></section>"`);
  });

  it("shows the count once memories exist, and no raw gray utilities", () => {
    const html = renderToStaticMarkup(<FirstRunCard history={{ ...history, memoryCount: 12 }} />);
    expect(html).toContain("12 memories");
    expect(html).not.toContain("appear as extraction runs");
    expect(html).not.toMatch(/gray-\d/);
  });
});
