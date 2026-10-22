// UX W5: the project page's session rows carry a per-session cost, via fmtUsd.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CodeSessionListRow } from "@/lib/code-sessions/queries";
import { SessionsTimeline } from "../sessions-timeline";

function row(id: string, costUsd: number | null): CodeSessionListRow {
  return {
    id,
    title: `Session ${id}`,
    summary: null,
    git_branch: "main",
    started_at: "2026-09-20T10:00:00Z",
    duration_seconds: 60,
    turn_count: 3,
    user_turn_count: 1,
    files_touched: [],
    costUsd,
  };
}

describe("SessionsTimeline cost column", () => {
  it("shows each session's cost through fmtUsd; unpriced is a dash, never $0.00", () => {
    const html = renderToStaticMarkup(
      <SessionsTimeline sessions={[row("a", 12.4), row("b", 1577.12), row("c", null)]} sessionsTotal={3} now="2026-09-27T00:00:00Z" />,
    );
    expect(html).toContain("$12.40");
    expect(html).toContain("$1,577");
    expect(html.match(/data-testid="session-cost"/g)).toHaveLength(3);
    expect(html).not.toContain("$0.00");
  });
});
