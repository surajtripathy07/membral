// Render checks for PulseContent (Today). renderToStaticMarkup pattern
// established in portrait-content.test.tsx — vitest.config.ts already sets
// esbuild.jsx: "automatic".
//
// UX audit B2: "Your record", the freshness strip and the AgentWorkPanel
// charts are gone from Today; a user with no code sessions sees one setup
// checklist instead of empty section headers.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { FreshnessMap } from "@/lib/freshness";
import type { PulseRecentCodeSession } from "../code-activity-strip";
import {
  buildSessionTitles,
  freshnessTitle,
  type PulseRecent,
  PulseContent,
  type PulseContentProps,
} from "../pulse-content";
import type { PulseThreads } from "../threads-panel";
import { getAppUrl } from "@/lib/env";
import { installCommand } from "@/lib/install-command";

function makeRecent(overrides: Partial<PulseRecent> = {}): PulseRecent {
  return {
    id: "conv-1",
    title: "Planning the launch",
    source: "chatgpt",
    date: "2026-07-20T10:00:00.000Z",
    area_id: "area-1",
    area_label: "Work",
    orphan: false,
    ...overrides,
  };
}

function makeCodeSession(overrides: Partial<PulseRecentCodeSession> = {}): PulseRecentCodeSession {
  return {
    id: "session-1",
    code_project_id: "project-1",
    title: null,
    summary: "Fixed the flaky import test on CodeHub.",
    started_at: "2026-07-20T10:00:00.000Z",
    duration_seconds: 942,
    turn_count: 37,
    user_turn_count: 14,
    project_display_name: "codehub-web",
    project_repo_identity: "codehub/web",
    ...overrides,
  };
}

function baseProps(overrides: Partial<PulseContentProps> = {}): PulseContentProps {
  return {
    loading: false,
    error: null,
    recent: [],
    recentCode: [],
    freshness: null,
    ...overrides,
  };
}

const THREADS: PulseThreads = {
  recentThreads: [],
  openThreads: [],
  recurringBlockers: [],
  statsLine: "Busiest repo on 2026-09-24: codehub/web",
  threadsError: false,
  hasSessions: true,
};

describe("PulseContent", () => {
  it("loading: renders the shimmer placeholder, not the real content", () => {
    const html = renderToStaticMarkup(<PulseContent {...baseProps({ loading: true })} />);
    expect(html).toContain("animate-pulse");
    expect(html).not.toContain("Open threads");
  });

  it("error: renders the error message in the error token", () => {
    const html = renderToStaticMarkup(<PulseContent {...baseProps({ error: "boom" })} />);
    expect(html).toContain("Couldn’t load your pulse");
    expect(html).toContain("boom");
    expect(html).toContain("text-error");
  });

  describe("with code sessions", () => {
    const props = baseProps({
      recent: [makeRecent()],
      recentCode: [makeCodeSession()],
      threads: THREADS,
    });

    it("Open threads comes before Yesterday, with the header links to Sessions and Chats", () => {
      const html = renderToStaticMarkup(<PulseContent {...props} />);
      expect(html).toContain(">Today<");
      expect(html).toContain('href="/code"');
      expect(html).toContain("All sessions →");
      expect(html).toContain('href="/conversations"');
      expect(html).toContain("All chats →");
      expect(html.indexOf("Open threads")).toBeGreaterThan(-1);
      expect(html.indexOf("Open threads")).toBeLessThan(html.indexOf("Yesterday"));
    });

    it("renders the one-line cost line (loading shimmer here) right after Open threads", () => {
      const html = renderToStaticMarkup(<PulseContent {...props} />);
      const cost = html.indexOf('data-testid="cost-line"');
      expect(cost).toBeGreaterThan(html.indexOf("Open threads"));
      expect(cost).toBeLessThan(html.indexOf("Yesterday"));
    });

    it("deletes Your record, the freshness strip, the busiest-repo line and the agent-work charts", () => {
      const html = renderToStaticMarkup(
        <PulseContent {...props} freshness={{ claude: { last_item_at: "2026-09-25T10:00:00Z", last_synced_at: null } } as unknown as FreshnessMap} />,
      );
      expect(html).not.toContain("Your record");
      expect(html).not.toContain(">Today</div>");
      expect(html).not.toContain("Busiest repo");
      expect(html).not.toContain("Agent work");
      expect(html).not.toContain("Planning the launch");
    });

    it("shows the sync summary line, not a stack of source rows", () => {
      const html = renderToStaticMarkup(<PulseContent {...props} />);
      expect(html).toContain('data-testid="sync-summary"');
    });

    it("shows the Your history card above the threads when firstRun is set, hides it otherwise (W5 D4)", () => {
      const firstRun = {
        total: 3,
        perHarness: [{ source: "claude-code", label: "Claude Code", count: 3 }],
        subAgents: 1,
        earliestStart: "2026-09-20T00:00:00.000Z",
        latestStart: "2026-10-01T00:00:00.000Z",
        memoryCount: 0,
      };
      expect(renderToStaticMarkup(<PulseContent {...props} firstRun={firstRun} />)).toContain("first-run-card");
      expect(renderToStaticMarkup(<PulseContent {...props} firstRun={null} />)).not.toContain("first-run-card");
    });

    it("never shows the setup checklist", () => {
      const html = renderToStaticMarkup(<PulseContent {...props} />);
      expect(html).not.toContain('data-testid="setup-checklist"');
    });
  });

  describe("fresh user (no code sessions)", () => {
    it("one setup checklist and one line, no empty section headers", () => {
      const html = renderToStaticMarkup(<PulseContent {...baseProps()} />);
      expect(html).toContain('data-testid="setup-checklist"');
      expect(html).toContain(installCommand(getAppUrl()).replaceAll("&", "&amp;"));
      expect(html).not.toMatch(/npm i -g membral\b/);
      expect(html).toContain("/plugin install membral@membral");
      expect(html).toContain("Other harnesses: install the CLI.");
      expect(html).toContain('href="/import"');
      expect(html).toContain('href="/settings#mcp-configuration"');
      expect(html).toContain("Open threads and cost appear after your first session.");
      for (const heading of ["Yesterday", "Blockers", "You said", "Your record", "Agent work"]) {
        expect(html).not.toContain(heading);
      }
      expect(html).not.toContain('id="pulse-open-threads"');
      expect(html.match(/<h2/g)?.length).toBe(1);
      expect(html).not.toContain('data-testid="sync-summary"');
    });

    it("marks the import step done when chats exist, and keeps the sync line for them", () => {
      const html = renderToStaticMarkup(<PulseContent {...baseProps({ recent: [makeRecent()] })} />);
      expect(html).toContain('data-testid="setup-checklist"');
      expect(html).toContain("(done)");
      expect(html).toContain('data-testid="sync-summary"');
    });
  });

  describe("helpers", () => {
    it("buildSessionTitles uses the session page's title source", () => {
      expect(buildSessionTitles([makeCodeSession()])).toEqual({ "session-1": "Fixed the flaky import test on CodeHub." });
      expect(buildSessionTitles([makeCodeSession({ title: "Ship the importer" })])["session-1"]).toBe("Ship the importer");
    });

    it("freshnessTitle folds the deleted strip into one tooltip string", () => {
      expect(freshnessTitle(null)).toBe("");
      const title = freshnessTitle(
        { chatgpt: { last_item_at: "2026-09-25T10:00:00Z", last_synced_at: "2026-09-25T10:00:00Z" } } as unknown as FreshnessMap,
        new Date("2026-09-25T12:00:00Z"),
      );
      expect(title).toContain("Chat current through today");
    });
  });
});
