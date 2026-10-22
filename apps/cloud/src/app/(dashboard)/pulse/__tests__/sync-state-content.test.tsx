// Render checks for SyncStateContent — same renderToStaticMarkup pattern as
// pulse-content.test.tsx / agent-work-content.test.tsx: pure props in, HTML
// out, no fetch mocking (sync-state-panel.tsx owns the fetch and isn't
// exercised here).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { formatRelativeShort } from "@/lib/format/dates";
import type { SyncStateResponse } from "@/lib/sync-state-shape";
import { SyncStateContent, type SyncStateContentProps, summarizeSync } from "../sync-state-content";

const NOW = new Date("2026-08-26T12:00:00.000Z");

function baseProps(overrides: Partial<SyncStateContentProps> = {}): SyncStateContentProps {
  return { loading: false, error: null, data: null, now: NOW, ...overrides };
}

function baseData(overrides: Partial<SyncStateResponse> = {}): SyncStateResponse {
  return {
    chat: [
      { source: "claude", conversations: 0, lastItemAt: null, lastRunAt: null, state: "never" },
      { source: "chatgpt", conversations: 0, lastItemAt: null, lastRunAt: null, state: "never" },
      { source: "grok", conversations: 0, lastItemAt: null, lastRunAt: null, state: "never" },
    ],
    code: [],
    ...overrides,
  };
}

describe("formatRelativeShort", () => {
  it("formats seconds/minutes/hours/days and null as 'never'", () => {
    expect(formatRelativeShort(null, NOW)).toBe("never");
    expect(formatRelativeShort(new Date(NOW.getTime() - 5_000).toISOString(), NOW)).toBe("just now");
    expect(formatRelativeShort(new Date(NOW.getTime() - 90_000).toISOString(), NOW)).toBe("1m ago");
    expect(formatRelativeShort(new Date(NOW.getTime() - 3 * 60 * 60_000).toISOString(), NOW)).toBe("3h ago");
    expect(formatRelativeShort(new Date(NOW.getTime() - 3 * 24 * 60 * 60_000).toISOString(), NOW)).toBe("3d ago");
  });
});

describe("SyncStateContent", () => {
  it("always renders the module header (holds its slot) even while loading with no data", () => {
    const html = renderToStaticMarkup(<SyncStateContent {...baseProps({ loading: true })} />);
    expect(html).toContain("Checking sync status");
    expect(html).toContain("animate-pulse");
  });

  it("error: renders the unavailable message, no crash", () => {
    const html = renderToStaticMarkup(<SyncStateContent {...baseProps({ error: "network down" })} />);
    expect(html).toContain("unavailable");
  });

  it("never-synced chat source: guided empty state linking to /import", () => {
    const html = renderToStaticMarkup(<SyncStateContent {...baseProps({ data: baseData() })} />);
    expect(html).toContain("Never synced");
    expect(html).toContain('href="/import"');
  });

  it("no code sessions: guided empty state links to /setup, not a 404ing npm command (issue #127)", () => {
    const html = renderToStaticMarkup(<SyncStateContent {...baseProps({ data: baseData() })} />);
    expect(html).not.toContain("npx @membral/cli setup");
    expect(html).toContain('href="/setup"');
  });

  it("populated chat row renders counts and relative times", () => {
    const data = baseData({
      chat: [
        {
          source: "claude",
          conversations: 42,
          lastItemAt: new Date(NOW.getTime() - 60_000).toISOString(),
          lastRunAt: new Date(NOW.getTime() - 5_000).toISOString(),
          state: "idle",
        },
      ],
    });
    const html = renderToStaticMarkup(<SyncStateContent {...baseProps({ data })} />);
    expect(html).toContain("42");
    expect(html).toContain("Claude");
    expect(html).toContain("idle");
  });

  it("populated code harness row renders projects/sessions/state", () => {
    const data = baseData({
      code: [
        {
          harness: "claude-code",
          projects: 3,
          sessions: 12,
          lastSessionAt: new Date(NOW.getTime() - 3_600_000).toISOString(),
          state: "quiet",
          note: "sync is running, but no new items have arrived in a while",
        },
      ],
    });
    const html = renderToStaticMarkup(<SyncStateContent {...baseProps({ data })} />);
    expect(html).toContain("claude-code");
    expect(html).toContain("quiet");
    expect(html).toContain("no new items have arrived");
  });
});

describe("summarizeSync (UX pass 2: plain sentences, only when they apply)", () => {
  const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();
  const healthy = baseData({
    chat: [
      { source: "claude", conversations: 42, lastItemAt: daysAgo(1), lastRunAt: daysAgo(1), state: "idle" },
      { source: "grok", conversations: 0, lastItemAt: null, lastRunAt: null, state: "never" },
    ],
    code: [
      { harness: "claude-code", projects: 3, sessions: 20, lastSessionAt: null, state: "idle" },
      { harness: "opencode", projects: 1, sessions: 2, lastSessionAt: null, state: "quiet" },
    ],
  });

  it("nothing to report: one calm sentence, no 'Sync ·' prefix, an unused source (Grok) is not a problem", () => {
    const s = summarizeSync(healthy, null, false, NOW);
    expect(s.text).toBe("Everything is up to date");
    expect(s.needsAction).toBe(false);
    const html = renderToStaticMarkup(<SyncStateContent {...baseProps({ data: healthy })} />);
    expect(html).not.toContain("Sync ·");
    expect(html).not.toMatch(/<details[^>]*open/);
    expect(html.slice(html.indexOf("<summary"), html.indexOf("</summary>"))).not.toContain("text-warn");
  });

  it("a stale ChatGPT import says how old it is and links to the ChatGPT export instructions", () => {
    const data = baseData({
      ...healthy,
      chat: [{ source: "chatgpt", conversations: 300, lastItemAt: daysAgo(20), lastRunAt: daysAgo(14), state: "stale" }],
    });
    const s = summarizeSync(data, null, false, NOW);
    expect(s.parts[0]).toEqual({
      text: "ChatGPT history last imported 14 days ago",
      action: { href: "/import#chatgpt", label: "Import a newer ChatGPT export →" },
      warn: true,
    });
    expect(s.needsAction).toBe(true);
    const html = renderToStaticMarkup(<SyncStateContent {...baseProps({ data })} />);
    expect(html).toContain('href="/import#chatgpt"');
    expect(html).not.toContain("import an export");
  });

  it("nothing synced at all: says so with the fix — chats by import, code by the CLI", () => {
    const s = summarizeSync(baseData(), null, false, NOW);
    expect(s.parts.map((p) => [p.text, p.action?.href])).toEqual([
      ["No chat history yet", "/import"],
      ["No coding sessions yet", "/setup"],
    ]);
    expect(s.needsAction).toBe(true);
    const html = renderToStaticMarkup(<SyncStateContent {...baseProps({ data: baseData() })} />);
    const summaryHtml = html.slice(html.indexOf("<summary"), html.indexOf("</summary>"));
    expect(summaryHtml).toContain("text-warn");
    expect(summaryHtml).toContain('href="/import"');
  });

  it("a failed read says so, in warn", () => {
    const s = summarizeSync(null, "boom", false);
    expect(s.needsAction).toBe(true);
    expect(s.text).toBe("Sync status is unavailable right now — try again shortly");
  });

  it("the freshness dates ride on the summary tooltip", () => {
    const html = renderToStaticMarkup(
      <SyncStateContent {...baseProps({ data: healthy, freshnessTitle: "Chat current through Sep 25" })} />,
    );
    expect(html).toContain('title="Chat current through Sep 25"');
  });

  it("uses status tokens, no raw palette utilities", () => {
    const src = readFileSync(join(__dirname, "..", "sync-state-content.tsx"), "utf8");
    expect(src).not.toMatch(/(bg|text|border)-(gray|slate|sky|blue|indigo|emerald|amber|rose)-\d+/);
  });
});
