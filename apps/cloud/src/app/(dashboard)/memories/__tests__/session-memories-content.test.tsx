import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { BrowseSessionMemory } from "@/lib/memory/session-memories-browse";
import { SessionMemoriesBlock } from "../../code/[projectId]/memory-section";
import { KindChips, memoriesHref, SessionMemoriesContent } from "../session-memories-content";

function rec(id: string, over: Partial<BrowseSessionMemory> = {}): BrowseSessionMemory {
  return {
    id,
    kind: "decision",
    text: `Text ${id}`,
    quote: `Quote ${id}`,
    verified: true,
    turn_idx: 7,
    code_session_id: `sess-${id}`,
    code_project_id: "p1",
    project_name: "CodeHub",
    created_at: "2026-09-20T00:00:00Z",
    ref: null,
    from_sub_agent: false,
    ...over,
  };
}

const NOW = new Date("2026-09-25T00:00:00Z");

describe("memoriesHref", () => {
  it("drops empty params", () => {
    expect(memoriesHref({ project: "p1", kind: null, q: "", page: 2 })).toBe("/memories?project=p1&page=2");
    expect(memoriesHref({})).toBe("/memories");
  });
});

describe("SessionMemoriesContent", () => {
  const base = { projects: [{ id: "p1", name: "CodeHub" }], now: NOW };

  it("is sessions-only: no claims or identity tabs render", () => {
    const html = renderToStaticMarkup(
      <SessionMemoriesContent
        {...base}
        records={[rec("a")]}
        filters={{ project: null, kind: null, q: "", page: 1 }}
        hasMore={false}
      />,
    );
    expect(html).not.toMatch(/claims|identity/i);
  });

  it("renders kind, text, quote, verified mark, project, sub-agent label and the receipt link", () => {
    const html = renderToStaticMarkup(
      <SessionMemoriesContent
        {...base}
        records={[rec("a"), rec("b", { verified: false, from_sub_agent: true, kind: "blocker" })]}
        filters={{ project: null, kind: null, q: "", page: 1 }}
        hasMore={false}
      />,
    );
    expect(html).toContain("Text a");
    expect(html).toContain("Quote a");
    // rec("a") is verified: no "✓ Verified" chrome renders for the common case.
    expect(html).not.toContain("Verified");
    // rec("b") is unverified: that's the one case that renders a mark.
    expect(html).toContain("Not verified");
    expect(html).toContain("from a sub-agent");
    expect(html).toContain('data-testid="memory-kind">Blocker<');
    // The receipt link carries the quote so the session page marks it (goal 2026-10-25 box 3.5).
    expect(html).toContain('href="/code/session/sess-a?turn=7&amp;quote=Quote%20a#turn-7"');
    expect(html).toContain("session, turn 7");
    expect(html).toContain('href="/code/p1"');
    expect(html).not.toContain("Older");
  });

  it("#436: labels a blocker past the 7-day window 'old · Nd ago'; a fresh one keeps its date", () => {
    const html = renderToStaticMarkup(
      <SessionMemoriesContent
        {...base}
        records={[
          rec("old", { kind: "blocker", created_at: "2026-09-15T00:00:00Z" }),
          rec("new", { kind: "blocker", created_at: "2026-09-23T00:00:00Z" }),
        ]}
        filters={{ project: null, kind: null, q: "", page: 1 }}
        hasMore={false}
      />,
    );
    expect(html).toContain("old · 10d ago");
    expect(html.match(/old · /g)).toHaveLength(1);
  });

  it("paginates with filters preserved and shows empty-state copy", () => {
    const html = renderToStaticMarkup(
      <SessionMemoriesContent
        {...base}
        records={[rec("a")]}
        filters={{ project: { id: "p1", name: "CodeHub" }, kind: "decision", q: "", page: 2 }}
        hasMore
      />,
    );
    expect(html).toContain('href="/memories?project=p1&amp;kind=decision&amp;page=3"');
    expect(html).toContain('href="/memories?project=p1&amp;kind=decision"');

    const empty = renderToStaticMarkup(
      <SessionMemoriesContent {...base} records={[]} filters={{ project: null, kind: null, q: "", page: 1 }} hasMore={false} />,
    );
    expect(empty).toContain("Nothing remembered yet");
  });

  it("shows search results without pagination", () => {
    const html = renderToStaticMarkup(
      <SessionMemoriesContent
        {...base}
        records={[rec("a")]}
        filters={{ project: null, kind: null, q: "pnpm", page: 1 }}
        hasMore
        degraded="keyword-only results"
      />,
    );
    expect(html).toContain("most relevant first");
    expect(html).toContain("keyword-only results");
    expect(html).not.toContain("Older");
  });
});

// UX audit B4: SessionMemoriesBlock is no longer a card-per-kind browser —
// it's a one-line count summary (per kind, linking to /memories) plus the
// top recurring blockers and an "Open in Memory →" link. See
// code/[projectId]/memory-section.tsx's header comment.
describe("SessionMemoriesBlock (project page)", () => {
  it("renders a per-kind counts line, the outcome count, top blockers with a recurrence count, and 'Open in Memory'", () => {
    const html = renderToStaticMarkup(
      <SessionMemoriesBlock
        projectId="p1"
        grouped={{
          groups: [
            {
              kind: "blocker",
              label: "Open blockers",
              records: [
                rec("b1", { kind: "blocker", text: "rotate the API key", quote: "rotate the API key" }),
                rec("b2", { kind: "blocker", text: "rotate the API key", quote: "rotate the API key" }),
              ],
              total: 3,
            },
          ],
          outcomeCount: 2,
          total: 5,
        }}
      />,
    );
    expect(html).toContain("3 open blockers");
    expect(html).toContain('href="/memories?project=p1&amp;kind=blocker"');
    expect(html).toContain('href="/memories?project=p1&amp;kind=outcome"');
    expect(html).toContain("2 outcomes");
    // The two duplicate "rotate the API key" blocker rows collapse to one, "seen 2×".
    expect(html).toContain("rotate the API key");
    expect((html.match(/rotate the API key/g) ?? []).length).toBe(1);
    expect(html).toContain("seen 2×");
    expect(html).toContain('href="/memories?project=p1"');
    expect(html).toContain("Open in Memory");
  });

  it("renders the empty-state line and nothing else when the project has no memories", () => {
    const html = renderToStaticMarkup(
      <SessionMemoriesBlock projectId="p1" grouped={{ groups: [], outcomeCount: 0, total: 0 }} />,
    );
    expect(html).toContain("Nothing remembered from this project");
    expect(html).not.toContain("Open in Memory");
  });
});

describe("KindChips (UX W6)", () => {
  it("renders one chip per kind as a word with its count, plus All with the total, keeping project and search", () => {
    const html = renderToStaticMarkup(
      <KindChips
        filters={{ project: { id: "p1", name: "CodeHub" }, kind: "blocker", q: "cache", page: 1 }}
        counts={{ blocker: 16, decision: 237, learning: 124, preference: 20, outcome: 103 }}
      />,
    );
    expect(html).toContain("All<span");
    expect(html).toContain(">500<");
    expect(html).toMatch(/Blockers<span[^>]*>16</);
    expect(html).toMatch(/Decisions<span[^>]*>237</);
    expect(html).toContain('href="/memories?project=p1&amp;q=cache&amp;kind=decision"');
    expect(html).toMatch(/aria-current="true"[^>]*>Blockers/);
  });

  it("renders the words without numbers when counts failed", () => {
    const html = renderToStaticMarkup(
      <KindChips filters={{ project: null, kind: null, q: "", page: 1 }} counts={null} />,
    );
    expect(html).toContain(">Learnings</a>");
    expect(html).not.toMatch(/tabular-nums/);
  });
});
