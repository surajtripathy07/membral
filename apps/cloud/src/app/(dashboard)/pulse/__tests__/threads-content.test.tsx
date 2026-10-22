// Today's thread blocks (goal 2026-09-26 W8 / P7) — render-by-behaviour
// checks over renderToStaticMarkup, the pattern every neighbouring
// *-content test here uses. The fixtures are the goal's own day on
// codehub.example / acme/billing.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { RecurringBlocker, Thread } from "@/lib/threads/open-threads";
import { menuKeyAction, RowMenu } from "../row-menu";
import { blockerMenuItems, ThreadsContent, threadMenuItems } from "../threads-content";
import {
  formatEstCost,
  formatRowCost,
  groupByRepo,
  groupBySession,
  isPlaceholderTitle,
  ladderWords,
  mergeByRef,
  normalizeQuote,
  orderBlockers,
  sessionRowTitle,
  threadRefLabel,
  refRepo,
  dayLabel,
  dayNav,
  parseDayParam,
  yesterdayBounds,
  yesterdayRows,
  yesterdayThreads,
  yesterdayView,
} from "@/lib/threads/view";

// The fixtures act on 2026-09-26; "Yesterday" is the previous local calendar
// day, so NOW sits on the 27th (a morning in UTC+ zones, still the 27th in UTC-).
const NOW = Date.parse("2026-09-27T09:00:00Z");

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    ref: "codehub.example/acme/billing#15178",
    refKind: "issue",
    url: "https://codehub.example/acme/billing/-/issues/15178",
    ladder: { review_verb: null, build_verb: "committed", triaged: false, discussed: false },
    sessions: [
      {
        id: "s-build-1",
        started_at: "2026-09-26T09:10:00Z",
        turn_idx: 42,
        proof_session_id: "s-build-1",
        tier: "observed",
        role: "worked_on",
        review_verb: null,
        build_verb: "committed",
        share: 1,
        cost_est: 14.2,
      },
    ],
    cost_est_total: 14.2,
    estimated: true,
    last_seen_at: "2026-09-26T09:10:00Z",
    open: true,
    closure: null,
    ...overrides,
  };
}

const discussion = makeThread({
  ref: "codehub.example/acme/billing#254702",
  url: "https://codehub.example/acme/billing/-/issues/254702",
  ladder: { review_verb: null, build_verb: null, triaged: false, discussed: true },
  sessions: [
    {
      id: "s-talk-1",
      started_at: "2026-09-26T11:00:00Z",
      turn_idx: 3,
      proof_session_id: "s-talk-1",
      tier: "discussed",
      role: "discussed",
      review_verb: null,
      build_verb: null,
      share: 0.6,
      cost_est: 4.2,
    },
  ],
  cost_est_total: 4.2,
  last_seen_at: "2026-09-26T11:00:00Z",
  open: false,
});

const review = makeThread({
  ref: "codehub.example/acme/billing!17049",
  refKind: "merge_request",
  url: "https://codehub.example/acme/billing/-/merge_requests/17049",
  ladder: { review_verb: "reviewed", build_verb: null, triaged: false, discussed: false },
  sessions: [
    {
      id: "s-review-1",
      started_at: "2026-09-26T08:50:00Z",
      turn_idx: 5,
      proof_session_id: "s-review-1",
      tier: "observed",
      role: "worked_on",
      review_verb: "reviewed",
      build_verb: null,
      share: 1,
      cost_est: 2.1,
    },
  ],
  cost_est_total: 2.1,
  last_seen_at: "2026-09-26T08:50:00Z",
  open: false,
  note: "no comment seen",
});

function render(props: Partial<Parameters<typeof ThreadsContent>[0]> = {}) {
  return renderToStaticMarkup(
    <ThreadsContent
      recentThreads={[]}
      openThreads={[]}
      recurringBlockers={[]}
      statsLine={null}
      now={NOW}
      grouping="repo"
      {...props}
    />,
  );
}

describe("ThreadsContent (Today page, W8 / P7)", () => {
  it("a discussion row shows its cost and no open badge", () => {
    const html = render({ recentThreads: [discussion] });
    expect(html).toContain("acme/billing#254702");
    expect(html).toContain("discussed");
    expect(html).toContain("$4.20 est.");
    expect(html).not.toContain("open-marker");
    expect(html).not.toContain("no close seen");
    expect(html).not.toContain("unresolved");
    // The row traces to the turn (B1): a link into the session viewer's anchor.
    expect(html).toContain('href="/code/session/s-talk-1?turn=3#turn-3"');
    // The session is named by its title, never "1 session".
    expect(html).not.toContain("1 session");
    expect(render({ recentThreads: [discussion], sessionTitles: { "s-talk-1": "Triage the billing debits bug" } })).toContain(
      "Triage the billing debits bug",
    );
  });

  it("an open thread: dot (tooltip open · no close seen), #N | title with verbs under it | cost, date", () => {
    const withQuote = makeThread({ priority: "the debits fix has to land before the release branch cuts" });
    const html = render({ openThreads: [withQuote], sessionTitles: { "s-build-1": "Fix the debits rounding" } });
    expect(html).toContain("open-marker");
    expect(html).toContain('title="open · no close seen"');
    expect(html).not.toMatch(/>open · no close seen</);
    expect(html).not.toContain("unresolved");
    // The priority quote is in the title's tooltip, not a line of its own.
    expect(html).not.toContain("priority-quote");
    expect(html).toContain("the debits fix has to land before the release branch cuts");
    expect(html).toContain(">$14.20<");
    // D-065: the fixture's codehub.example host is not proven glab-family (no forge_family), so
    // the chip has no link and carries its repo: `owner/repo#N` (shared rule with Issues).
    expect(html).toContain(">acme/billing#15178<");
    expect(html).toContain('data-testid="repo-header">acme/billing<');
    // A glab-family host (forge_family from data) earns the bare `#N`, with a link.
    const glab = render({ openThreads: [makeThread({ forge_family: "gitlab" })] });
    expect(glab).toContain(">#15178<");
    expect(glab).toContain('href="https://codehub.example/acme/billing/-/issues/15178"');
    // Title truncates by CSS; the verbs sit under it as a small muted line, visible at every width.
    expect(html).toMatch(/class="[^"]*truncate[^"]*"[^>]*data-testid="thread-title"[^>]*>Fix the debits rounding</);
    expect(html).toMatch(/class="block min-w-0 truncate text-muted text-micro" data-testid="thread-verbs">committed</);
    expect(html.indexOf('data-testid="thread-title"')).toBeLessThan(html.indexOf('data-testid="thread-verbs"'));
    expect(html).not.toContain("min-[480px]");

    const without = render({ openThreads: [makeThread()] });
    expect(without).toContain("open-marker");
    expect(without).not.toMatch(/priorit|you said/i);
  });

  it("a placeholder session title shows no title; the verbs line stands alone at normal size, still linked", () => {
    expect(isPlaceholderTitle("A short session with no recorded prose.")).toBe(true);
    expect(isPlaceholderTitle("Untitled session")).toBe(true);
    // summarize.ts prefixes the sentence to its heuristic summary.
    expect(isPlaceholderTitle("A short session with no recorded prose. Touched 9 files: a.ts, b.ts")).toBe(true);
    expect(isPlaceholderTitle("Fix the debits rounding")).toBe(false);
    const html = render({
      openThreads: [makeThread()],
      sessionTitles: { "s-build-1": "A short session with no recorded prose." },
    });
    expect(html).not.toContain("no recorded prose");
    expect(html).not.toContain('data-testid="thread-title"');
    expect(html).toMatch(/class="block min-w-0 truncate text-muted text-body-sm" data-testid="thread-verbs">committed</);
    expect(html).toContain('href="/code/session/s-build-1?turn=42#turn-42"');
  });

  it("open threads group under a once-printed repo header with its count, keeping the row order", () => {
    // glab-family hosts (forge_family from data): the repo is printed once, rows read `#N` (D-065).
    const a1 = makeThread({ forge_family: "gitlab" });
    const b1 = makeThread({ ref: "codehub.example/acme/web#62", forge_family: "gitlab" });
    const a2 = makeThread({ ref: "codehub.example/acme/billing#148", forge_family: "gitlab" });
    expect(groupByRepo([a1, b1, a2]).map((g) => [g.repo, g.threads.map((t) => t.ref)])).toEqual([
      ["acme/billing", [a1.ref, a2.ref]],
      ["acme/web", [b1.ref]],
    ]);
    const html = render({ openThreads: [a1, b1, a2] });
    expect(html.match(/data-testid="repo-header"/g)).toHaveLength(2);
    expect(html.match(/>acme\/billing</g)).toHaveLength(1);
    expect(html).not.toContain(">acme/billing#15178<");
    expect(refRepo("codehub.example/acme/billing!17")).toBe("acme/billing");
    expect(refRepo("#12")).toBeNull();
  });

  it("×N badge when more than one session; every title in its tooltip", () => {
    const two = makeThread({
      sessions: [
        { ...makeThread().sessions[0], id: "s-a", proof_session_id: "s-a", started_at: "2026-09-20T09:00:00Z" },
        { ...makeThread().sessions[0], id: "s-b", proof_session_id: "s-b", started_at: "2026-09-26T09:00:00Z" },
      ],
    });
    const html = render({ openThreads: [two], sessionTitles: { "s-a": "Older session", "s-b": "Newer session" } });
    expect(html).toContain("×2");
    expect(html).toMatch(/data-testid="thread-title"[^>]*>Newer session</);
    expect(html).toContain('aria-label="2 sessions: Newer session; Older session"');
    expect(render({ openThreads: [makeThread()] })).not.toContain('data-testid="session-count"');
  });

  it("a review row at reviewed shows the plain note, never an open badge", () => {
    const html = render({ recentThreads: [review] });
    expect(html).toContain("acme/billing!17049");
    expect(html).toContain("reviewed");
    expect(html).toContain("no comment seen");
    expect(html).toContain("$2.10 est.");
    expect(html).not.toContain("open-marker");
    expect(html).not.toContain("no close seen");
    expect(html).not.toContain("unresolved");
    // Refs link only through forgeUrl: an unknown forge host renders plain text, never a guessed URL.
    expect(html).not.toContain('href="https://codehub.example');
  });

  it("Yesterday keeps only the last ~36 h; older threads stay out of it", () => {
    const old = makeThread({
      ref: "codehub.example/acme/billing#1",
      last_seen_at: "2026-09-20T09:00:00Z",
      sessions: [{ ...makeThread().sessions[0], started_at: "2026-09-20T09:00:00Z" }],
    });
    expect(yesterdayThreads([discussion, old], NOW).map((t) => t.ref)).toEqual([discussion.ref]);
    const html = render({ recentThreads: [discussion, old] });
    expect(html).toContain("acme/billing#254702");
    expect(html).not.toContain("acme/billing#1<");
  });

  it("a dismissed thread stays on Yesterday with its cost and never in Open threads", () => {
    const dismissed = makeThread({ dismissed: true, open: false });
    const html = render({ recentThreads: [dismissed], openThreads: [] });
    expect(html).toContain("$14.20 est.");
    expect(html).toContain("dismissed");
    expect(html).not.toContain("open-marker");
    expect(html).toContain("Nothing you committed to is still waiting on a close.");
  });

  it("dismiss actions sit behind an always-visible ⋯ button, only when a handler is given", () => {
    const html = render({ openThreads: [makeThread()], onDismiss: () => {} });
    expect(html).toContain('aria-label="Actions for acme/billing#15178"');
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain(">⋯<");
    // Closed by default: no button bar on the row.
    expect(html).not.toContain(">Resolved elsewhere<");
    expect(render({ openThreads: [makeThread()] })).not.toContain("Actions for");

    const calls: unknown[] = [];
    const items = threadMenuItems(makeThread(), (t) => calls.push(t));
    expect(items.map((i) => i.label)).toEqual(["Resolved elsewhere", "Not a delivery item"]);
    items[1].onSelect();
    expect(calls).toEqual([{ ref: "codehub.example/acme/billing#15178", kind: "issue", reason: "not_delivery_item" }]);
  });

  it("RowMenu: open renders a menu of menuitems with aria-expanded=true; Esc closes, arrows move", () => {
    const html = renderToStaticMarkup(
      <RowMenu label="Actions for #1" defaultOpen items={threadMenuItems(makeThread(), () => {})} />,
    );
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('role="menu"');
    expect(html.match(/role="menuitem"/g)).toHaveLength(2);
    expect(html).toContain(">Resolved elsewhere<");
    expect(html).toContain(">Not a delivery item<");
    expect(menuKeyAction("Escape")).toBe("close");
    expect(menuKeyAction("ArrowDown")).toBe("next");
    expect(menuKeyAction("ArrowUp")).toBe("prev");
    expect(menuKeyAction("a")).toBe("none");
  });

  it("blocker rows get a ⋯ menu (Resolved / Ignore); a dismissed one reads 'Dismissed · Undo'", () => {
    const blocker: RecurringBlocker = {
      id: "b1",
      text: "smoke job times out",
      quote: null,
      ref: null,
      recurrence_count: 2,
      session_id: null,
      turn_idx: null,
      last_seen_at: "2026-09-26T10:00:00Z",
    };
    const html = render({ recurringBlockers: [blocker], onDismissBlocker: () => {}, onUndoBlocker: () => {} });
    expect(html).toContain('aria-label="Actions for this blocker"');
    expect(html).not.toContain("Dismissed");
    // A persistent live region is always in the Blockers block (S3).
    expect(html).toContain('aria-live="polite"');

    const calls: unknown[] = [];
    const items = blockerMenuItems("b1", (id, reason) => calls.push([id, reason]));
    expect(items.map((i) => i.label)).toEqual(["Resolved", "Ignore"]);
    items[0].onSelect();
    items[1].onSelect();
    expect(calls).toEqual([
      ["b1", "resolved"],
      ["b1", "ignored"],
    ]);

    const dismissed = render({
      recurringBlockers: [blocker],
      blockerStates: new Map([["b1", { ids: ["b1", "b0"], busy: false }]]),
      onDismissBlocker: () => {},
      onUndoBlocker: () => {},
    });
    expect(dismissed).toContain('data-dismissed="true"');
    expect(dismissed).toMatch(/Dismissed ·/);
    expect(dismissed).toMatch(/aria-disabled="false"[^>]*data-testid="blocker-undo"[^>]*>Undo</);
    expect(dismissed).not.toContain("Actions for this blocker");
    // Until the server answers, Undo is aria-disabled (it can still hold focus).
    const pending = render({ recurringBlockers: [blocker], blockerStates: new Map([["b1", { ids: [], busy: true }]]) });
    expect(pending).toMatch(/aria-disabled="true"[^>]*data-testid="blocker-undo"/);
    expect(pending).not.toMatch(/disabled=""/);
  });

  it("S4: a failed dismiss/undo shows inline error text on the row", () => {
    const blocker: RecurringBlocker = {
      id: "b1",
      text: "smoke job times out",
      quote: null,
      ref: null,
      recurrence_count: 1,
      session_id: null,
      turn_idx: null,
      last_seen_at: null,
    };
    const html = render({
      recurringBlockers: [blocker],
      onDismissBlocker: () => {},
      blockerErrors: new Map([["b1", "Couldn't dismiss — try again."]]),
    });
    expect(html).toMatch(/data-testid="blocker-error">Couldn(&#x27;|')t dismiss — try again\.</);
  });

  it("S1: the quiet 'N dismissed' list with Restore sits under Blockers, hidden when there are none", () => {
    const item = {
      ids: ["b9"],
      text: "flaky test blocks merge",
      quote: null,
      reason: "ignored" as const,
      dismissed_at: "2026-09-20T00:00:00Z",
    };
    const html = render({ dismissedBlockers: [item], onRestoreBlocker: () => {} });
    expect(html).toContain("Blockers");
    expect(html).toContain(">1 dismissed<");
    expect(html).toContain("flaky test blocks merge");
    expect(html).toContain(">ignored<");
    expect(html).toContain(">Restore<");
    expect(render({ dismissedBlockers: [], onRestoreBlocker: () => {} })).not.toContain("dismissed");
    expect(render({ dismissedBlockers: [], onRestoreBlocker: () => {} })).not.toContain("Blockers");
  });

  it("blockers: most recurrent first, then latest; 'seen N×' only when N > 1; agent words are never a quote", () => {
    const b = (id: string, recurrence_count: number, last_seen_at: string, quote: string | null = null): RecurringBlocker => ({
      id,
      text: `blocker ${id}`,
      quote,
      ref: null,
      recurrence_count,
      session_id: "s-smoke",
      turn_idx: 7,
      last_seen_at,
    });
    const list = [b("one", 1, "2026-09-26T10:00:00Z"), b("four", 4, "2026-09-20T10:00:00Z"), b("two", 2, "2026-09-22T10:00:00Z")];
    // Counts 1 (newest), 4, 2 → 4, 2, 1.
    expect(orderBlockers(list).map((x) => x.recurrence_count)).toEqual([4, 2, 1]);
    const html = render({ recurringBlockers: list });
    expect(html.indexOf("blocker four")).toBeLessThan(html.indexOf("blocker two"));
    expect(html.indexOf("blocker two")).toBeLessThan(html.indexOf("blocker one"));
    expect(html).toContain("seen 4×");
    expect(html).toContain("seen 2×");
    expect(html).not.toContain("seen 1×");
    expect(html).toContain('href="/code/session/s-smoke?turn=7#turn-7"');
    expect(render()).not.toContain("Blockers");
  });

  it("F5: Yesterday shows only the window's sessions and sums their cost, not the 30-day total", () => {
    const busy = makeThread({
      sessions: [
        { ...makeThread().sessions[0], id: "old-1", proof_session_id: "old-1", started_at: "2026-09-10T09:00:00Z", cost_est: 30 },
        { ...makeThread().sessions[0], id: "new-1", proof_session_id: "new-1", started_at: "2026-09-26T09:00:00Z", cost_est: 2.5 },
      ],
      cost_est_total: 32.5,
    });
    const view = yesterdayView(busy, NOW);
    expect(view.sessions.map((s) => s.id)).toEqual(["new-1"]);
    expect(view.cost_est_total).toBe(2.5);
    const html = render({ recentThreads: [busy] });
    expect(html).toContain("$2.50 est.");
    expect(html).not.toContain("$32.50 est.");
    expect(html).not.toContain("/code/session/old-1");
  });

  it("F9: a failed threads read shows an error line, never the all-clear copy", () => {
    const html = render({ threadsError: true });
    expect(html).toContain("Couldn&#x27;t load open threads");
    expect(html).not.toContain("Nothing you committed to is still waiting on a close.");
    expect(html).not.toContain("No issue or MR was acted on");
  });

  it("F1 + D-065: a glab-family MR reads !N; an unknown host is plain text with owner/repo!N; rows carry the kind", () => {
    const mr = makeThread({
      ref: "codehub.example/acme/billing#17",
      refKind: "merge_request",
      url: "https://codehub.example/acme/billing/-/merge_requests/17",
    });
    const is = makeThread({ ref: "codehub.example/acme/billing#17", url: "https://codehub.example/acme/billing/-/issues/17" });
    const html = render({ openThreads: [mr, is], onDismiss: () => {} });
    // Unknown family (no forge_family): no link; every label — chip and row menu — carries the repo,
    // and the MR keeps `!` so it never reads as the issue of the same number.
    expect(html).toContain(">acme/billing!17<");
    expect(html).toContain("Actions for acme/billing!17");
    expect(html).toContain("Actions for acme/billing#17");
    expect(html).not.toContain('href="https://codehub.example');
    expect(html).toContain('data-kind="merge_request"');
    expect(html).toContain('data-kind="issue"');
    const glab = render({ openThreads: [{ ...mr, forge_family: "gitlab" }], onDismiss: () => {} });
    expect(glab).toContain(">!17<");
    expect(glab).toContain("Actions for !17");
    expect(glab).toContain('href="https://codehub.example/acme/billing/-/merge_requests/17"');
  });

  it("D-065: Yesterday rows and their aria text use the shared ref label, as the open rows do", () => {
    const gh = makeThread({ ref: "github.com/acme/api#5" });
    const other = makeThread({ ref: "forge.unknown.example/acme/web#9", refKind: "merge_request" });
    const html = render({ recentThreads: [gh, other] });
    expect(html).toContain(">#5<");
    expect(html).toContain('aria-label="issue #5 on the forge"');
    expect(html).toContain(">acme/web!9<");
    expect(html).not.toContain("acme/api#5<");
  });

  it("the nightly stats line (e.g. 'Busiest repo') is no longer rendered (audit B2)", () => {
    const html = render({ statsLine: "Busiest repo on 2026-09-24: acme/billing" });
    expect(html).not.toContain("stats-line");
    expect(html).not.toContain("Busiest repo");
  });

  it("empty states are one calm sentence each and the headings always render", () => {
    const html = render();
    expect(html).toContain("Yesterday");
    expect(html).toContain("Open threads");
    expect(html).toContain("Nothing acted on this day.");
    expect(html).toContain("Nothing you committed to is still waiting on a close.");
  });

  it("every Yesterday dollar figure is labelled est. (B11); open-thread rows show the bare figure (the footer says est.)", () => {
    expect(formatEstCost(2.1)).toBe("$2.10 est.");
    expect(formatEstCost(null)).toBe("—");
    // No attributed cost is a bare dash, never `est. $0.00`; under a cent is `<$0.01`.
    expect(formatEstCost(0)).toBe("—");
    expect(formatEstCost(0.004)).toBe("<$0.01 est.");
    expect(formatEstCost(0.01)).toBe("$0.01 est.");
    const html = render({ recentThreads: [discussion, review] });
    for (const m of html.matchAll(/\$\d[\d.,]*/g)) {
      expect(html.slice(m.index + m[0].length, m.index + m[0].length + 5)).toContain("est.");
    }
    const open = render({ openThreads: [makeThread()] });
    expect(open).toMatch(/data-testid="thread-cost">\$14\.20</);
    expect(open).not.toContain("est.");
    expect(formatRowCost(0)).toBe("—");
  });

  it("ladder words and short refs read as the mockup does", () => {
    expect(ladderWords({ ladder: { review_verb: "reviewed", build_verb: "committed", triaged: false, discussed: false } })).toEqual([
      "reviewed",
      "committed",
    ]);
    expect(ladderWords({ ladder: { review_verb: null, build_verb: null, triaged: true, discussed: false } })).toEqual(["triaged"]);
    expect(ladderWords({ ladder: { review_verb: null, build_verb: "opened_mr", triaged: false, discussed: false } })).toEqual([
      "opened MR",
    ]);
    expect(threadRefLabel({ ref: "codehub.example/acme/billing#15178" })).toBe("acme/billing#15178");
    expect(threadRefLabel({ ref: "codehub.example/acme/billing#17049", refKind: "merge_request", forge_family: "gitlab" })).toBe(
      "!17049",
    );
  });

  it("uses tokens only — no raw palette utilities in the component source", () => {
    const src = readFileSync(join(__dirname, "..", "threads-content.tsx"), "utf8");
    expect(src).not.toMatch(/(bg|text|border|ring|divide)-(gray|slate|zinc|neutral|emerald|amber|rose|indigo)-\d+/);
    expect(src).not.toMatch(/text-\[\d/);
    const html = render({ recentThreads: [discussion], openThreads: [makeThread()] });
    expect(html).not.toMatch(/(bg|text|border)-(gray|slate|zinc|neutral)-\d+/);
  });

  // S16: a fresh user must not read an empty Open threads block as an all-clear.
  it("with no sessions at all, Open threads welcomes and says what will appear instead of the all-clear", () => {
    const html = render({ openThreads: [], recentThreads: [], hasSessions: false });
    expect(html).toContain("No coding sessions yet.");
    expect(html).toContain('data-testid="open-threads-no-sessions"');
    expect(html).not.toContain("Nothing you committed to is still waiting on a close.");
  });

  it("with sessions and nothing open, the all-clear copy stays", () => {
    const html = render({ openThreads: [], hasSessions: true });
    expect(html).toContain("Nothing you committed to is still waiting on a close.");
    expect(html).not.toContain("No coding sessions yet.");
  });
  describe("UX audit B2 reshape", () => {
    const session = (id: string, started_at: string, cost_est: number | null, turn_idx = 1) => ({
      ...makeThread().sessions[0],
      id,
      proof_session_id: id,
      started_at,
      cost_est,
      turn_idx,
    });

    it("Open threads renders before Yesterday", () => {
      const html = render({ openThreads: [makeThread()], recentThreads: [discussion] });
      expect(html.indexOf("Open threads")).toBeLessThan(html.indexOf("Yesterday"));
    });

    it("Yesterday shows one row per (kind, repo#N), verbs merged, sessions unioned", () => {
      const viewed = makeThread({
        ref: "acme/billing#12",
        url: null,
        ladder: { review_verb: "viewed", build_verb: null, triaged: false, discussed: false },
        sessions: [{ ...session("s-a", "2026-09-26T09:00:00Z", 1), review_verb: "viewed", build_verb: null }],
        last_seen_at: "2026-09-26T09:00:00Z",
      });
      const triaged = makeThread({
        ref: "codehub.example/acme/billing#12",
        ladder: { review_verb: null, build_verb: "pushed", triaged: true, discussed: false },
        sessions: [
          { ...session("s-a", "2026-09-26T09:00:00Z", 1), build_verb: "pushed" },
          { ...session("s-b", "2026-09-26T12:00:00Z", 2), build_verb: "pushed" },
        ],
        last_seen_at: "2026-09-26T12:00:00Z",
      });
      const merged = mergeByRef([viewed, triaged]);
      expect(merged).toHaveLength(1);
      expect(merged[0].ref).toBe("codehub.example/acme/billing#12");
      expect(ladderWords(merged[0])).toEqual(["viewed", "pushed", "triaged"]);
      expect(merged[0].sessions.map((x) => x.id)).toEqual(["s-a", "s-b"]);
      expect(merged[0].cost_est_total).toBe(3);
      const html = render({ recentThreads: [viewed, triaged] });
      expect(html.match(/data-testid="thread-row"/g)).toHaveLength(1);
      expect(html).toContain("viewed · pushed · triaged");
      // An MR and an issue with the same number stay two rows.
      expect(mergeByRef([viewed, { ...viewed, refKind: "merge_request" }])).toHaveLength(2);
    });

    it("Yesterday: priced rows first by est. cost, then '—' rows; 5 rows then '+N more acted on yesterday'", () => {
      const rows = Array.from({ length: 8 }, (_, i) =>
        makeThread({
          ref: `acme/billing#${100 + i}`,
          url: null,
          sessions: [session(`s-${i}`, "2026-09-26T09:00:00Z", i % 2 === 0 ? null : i)],
          last_seen_at: `2026-09-26T0${i}:00:00Z`,
        }),
      );
      const ordered = yesterdayRows(rows, NOW);
      expect(ordered.slice(0, 4).map((t) => t.cost_est_total)).toEqual([7, 5, 3, 1]);
      expect(ordered.slice(4).every((t) => t.cost_est_total === null)).toBe(true);
      const html = render({ recentThreads: rows });
      expect(html.match(/data-testid="thread-row"/g)).toHaveLength(5);
      expect(html).toContain("+3 more acted on yesterday");
    });

    it("a GitHub ref links through forgeUrl; a host-less ref is plain text", () => {
      const gh = makeThread({ ref: "github.com/acme/billing#9", url: "https://example.invalid/wrong" });
      const html = render({ openThreads: [gh] });
      expect(html).toContain('href="https://github.com/acme/billing/issues/9"');
      expect(html).not.toContain("example.invalid");
      const bare = render({ openThreads: [makeThread({ ref: "acme/billing#9", url: "https://example.invalid/x" })] });
      expect(bare).not.toContain("example.invalid");
    });

    it("rows name the newest session by title, never an absolute path, with '+N more' for the rest", () => {
      const t = makeThread({
        sessions: [session("s-1", "2026-09-26T08:00:00Z", 1, 4), session("s-2", "2026-09-26T09:00:00Z", 1, 9)],
      });
      const titles = { "s-1": "Older session", "s-2": "Touched /Users/someone/dev/acme/billing/ledger.ts" };
      // Yesterday rows keep the "+N more" disclosure; Open threads rows use ×N (tested above).
      const html = render({ recentThreads: [t], sessionTitles: titles });
      expect(html).toContain("Touched ledger.ts");
      expect(html).not.toContain("/Users/");
      expect(html.indexOf("Touched ledger.ts")).toBeLessThan(html.indexOf("+1 more"));
      expect(html).toContain('href="/code/session/s-2?turn=9#turn-9"');
      expect(html).toContain('href="/code/session/s-1?turn=4#turn-4"');
      expect(html).toContain("Older session");
      // UX W5: the dated "Session · <day>" stand-in is gone — real titles arrive from /api/pulse.
      expect(sessionRowTitle({ id: "x", proof_session_id: "x" }, {})).toBe("Untitled session");
    });

    it("UX W5: a row with 3 sessions shows the newest title, then '+2 more' listing the other two", () => {
      const t = makeThread({
        sessions: [
          session("s-1", "2026-09-26T07:00:00Z", 1, 2),
          session("s-2", "2026-09-26T08:00:00Z", 1, 3),
          session("s-3", "2026-09-26T09:00:00Z", 1, 5),
        ],
      });
      const titles = { "s-1": "Draft the ledger import", "s-2": "Fix the rounding bug", "s-3": "Ship the billing export" };
      const html = render({ recentThreads: [t], sessionTitles: titles });
      expect(html).toContain("Ship the billing export");
      expect(html).toContain("+2 more");
      expect(html.indexOf("Ship the billing export")).toBeLessThan(html.indexOf("+2 more"));
      const more = html.slice(html.indexOf('data-testid="session-titles-more"'));
      expect(more).toContain("Fix the rounding bug");
      expect(more).toContain("Draft the ledger import");
      expect(html).toContain('href="/code/session/s-3?turn=5#turn-5"');
      expect(html).not.toContain("Session · ");
    });

    it("UX W5: a sub-agent row takes the title of the session that proves it", () => {
      const s = { ...session("parent-1", "2026-09-26T09:00:00Z", 1, 7), proof_session_id: "child-1" };
      const titles = { "parent-1": "Parent work", "child-1": "Parent work · Explore" };
      expect(sessionRowTitle(s, titles)).toBe("Parent work · Explore");
      const html = render({ openThreads: [makeThread({ sessions: [s] })], sessionTitles: titles });
      expect(html).toContain('href="/code/session/child-1?turn=7#turn-7"');
    });

    it("normalizeQuote collapses whitespace and trailing punctuation (the project memory list still uses it)", () => {
      expect(normalizeQuote("  ship  it today!! ")).toBe("ship it today");
    });

    it("Blockers show 3 with a visible '+N more'; there is no You said block", () => {
      const blockers = Array.from({ length: 5 }, (_, i) => ({
        id: `b${i}`,
        text: `blocker ${i}`,
        quote: null,
        ref: null,
        recurrence_count: 1,
        session_id: null,
        turn_idx: null,
        last_seen_at: null,
      }));
      const html = render({ recurringBlockers: blockers });
      expect(html.match(/data-testid="blocker-row"/g)).toHaveLength(3);
      expect(html).toContain("+2 more blockers");
      expect(html).not.toContain("You said");
      expect(html).not.toContain("you-said-row");
    });

    it("renders the cost line slot right after Open threads", () => {
      const html = render({ costLine: <p data-testid="cost-line">$1,577 spent</p> });
      const cost = html.indexOf('data-testid="cost-line"');
      expect(cost).toBeGreaterThan(html.indexOf("Open threads"));
      expect(cost).toBeLessThan(html.indexOf("Yesterday"));
    });
  });
});

describe("UX W6 review fix 5: Today", () => {
  it("Yesterday drops a ref already listed under Open threads, even spelled with/without host", () => {
    const openOne = makeThread();
    const bareCopy = makeThread({ ref: "acme/billing#15178" });
    const other = makeThread({ ref: "codehub.example/acme/billing#9" });
    expect(yesterdayRows([bareCopy, other], NOW, [openOne]).map((t) => t.ref)).toEqual([other.ref]);
    // An MR with the same number is a different ref and stays.
    const mr = makeThread({ refKind: "merge_request" });
    expect(yesterdayRows([mr], NOW, [openOne])).toHaveLength(1);
  });

  it("renders each ref once on the page", () => {
    const html = render({ openThreads: [makeThread()], recentThreads: [makeThread()] });
    expect((html.match(/data-testid="thread-row"/g) ?? []).length).toBe(1);
  });

  it("the Yesterday session title cell takes its own line on phone", () => {
    const html = render({ recentThreads: [makeThread()] });
    expect(html).toMatch(/data-testid="session-titles"/);
    expect(html).toContain("basis-full sm:basis-0 sm:flex-1");
  });
});

describe("session grouping (the default): repo → latest session → refs", () => {
  const sess = (id: string, ended_at: string, cost: number | null = null) => ({
    ...makeThread().sessions[0],
    id,
    proof_session_id: id,
    started_at: ended_at,
    at: ended_at,
    ended_at,
    session_cost_usd: cost,
  });
  const inThree = makeThread({
    ref: "codehub.example/acme/billing#110",
    sessions: [sess("s1", "2026-09-20T10:00:00Z", 1), sess("s2", "2026-09-22T10:00:00Z", 2), sess("s3", "2026-09-25T10:00:00Z", 3.5)],
  });
  const onlyOld = makeThread({ ref: "codehub.example/acme/billing#138", sessions: [sess("s1", "2026-09-20T10:00:00Z", 1)] });
  const otherRepo = makeThread({ ref: "codehub.example/acme/web#62", sessions: [sess("s9", "2026-09-26T10:00:00Z")] });
  const titles = { s1: "Old work", s3: "A short session with no recorded prose. Touched 9 files: a.ts" };

  it("a ref in 3 sessions appears once, under the latest, with '+2 earlier sessions'", () => {
    const groups = groupBySession([inThree, onlyOld, otherRepo], titles, NOW);
    expect(groups.map((g) => g.repo)).toEqual(["acme/web", "acme/billing"]);
    const billing = groups[1].sessions;
    expect(billing.map((g) => [g.id, g.threads.map((t) => t.ref)])).toEqual([
      ["s3", [inThree.ref]],
      ["s1", [onlyOld.ref]],
    ]);
    expect(billing[0]).toMatchObject({ cost: 3.5, title: expect.stringMatching(/^Session · \S/) });
    expect(billing[1]).toMatchObject({ title: "Old work", cost: 1 });

    const html = render({ openThreads: [inThree, onlyOld, otherRepo], sessionTitles: titles, grouping: "session" });
    expect(html.match(/data-ref="codehub.example\/acme\/billing#110"/g)).toHaveLength(1);
    expect(html).toContain(">+2 earlier sessions<");
    expect(html).not.toContain("no recorded prose");
    expect(html).toMatch(/data-testid="session-header"[^>]*>Session · [^<]+</);
    expect(html).toContain('href="/code/session/s3"');
    // Labelled as the SESSION's cost; an unpriced session shows none at all.
    expect(html).toContain('data-testid="session-cost">session $3.50<');
    expect(html.match(/data-testid="session-cost"/g)).toHaveLength(2);
    expect(html.match(/data-testid="repo-header">acme\/billing</g)).toHaveLength(1);
    // ?group=repo keeps the repo grouping; with no grouping prop the default is session.
    expect(render({ openThreads: [inThree] })).not.toContain("threads-by-session");
    expect(
      renderToStaticMarkup(<ThreadsContent recentThreads={[]} openThreads={[inThree]} recurringBlockers={[]} now={NOW} />),
    ).toContain("threads-by-session");
  });

  it("caps each project at 5 sessions, then '+N more sessions'", () => {
    const many = Array.from({ length: 7 }, (_, i) =>
      makeThread({ ref: `codehub.example/acme/billing#${200 + i}`, sessions: [sess(`m${i}`, `2026-09-1${i}T10:00:00Z`)] }),
    );
    const html = render({ openThreads: many, grouping: "session" });
    expect(html.match(/data-testid="session-group"/g)).toHaveLength(5);
    expect(html).toContain("+2 more sessions");
  });
});

describe("session rows say what was observed (UX pass 2)", () => {
  it("verbs are chips; the forge title, else the first commit subject, else nothing; 'N commits' when > 0", () => {
    const mr = makeThread({
      ref: "github.com/acme/billing#1",
      refKind: "merge_request",
      ladder: { review_verb: null, build_verb: "opened_mr", triaged: false, discussed: false },
      forge_title: "Fix rounding in ledger export",
      first_commit_subject: "wip",
      commit_count: 3,
    });
    const html = render({ openThreads: [mr], grouping: "session" });
    expect(html).toMatch(/data-testid="item-text">Fix rounding in ledger export</);
    expect(html).toMatch(/data-testid="verb-chip">opened MR</);
    expect(html).toMatch(/data-testid="commit-chip">3 commits</);
    const byCommit = render({ openThreads: [{ ...mr, forge_title: undefined }], grouping: "session" });
    expect(byCommit).toMatch(/data-testid="item-text">wip</);
    const bare = render({ openThreads: [{ ...mr, forge_title: undefined, first_commit_subject: undefined, commit_count: undefined }], grouping: "session" });
    expect(bare).not.toContain('data-testid="item-text"');
    expect(bare).not.toContain("commit-chip");
  });
});

describe("Yesterday: session grouping, view-only collapse, calendar-day window", () => {
  const at = (id: string, iso: string) => ({
    ...makeThread().sessions[0],
    id,
    proof_session_id: id,
    started_at: iso,
    at: iso,
    ended_at: iso,
    review_verb: "viewed" as const,
    build_verb: null,
  });
  const viewed = (n: number) =>
    makeThread({
      ref: `github.com/acme/billing#${n}`,
      ladder: { review_verb: "viewed", build_verb: null, triaged: false, discussed: false },
      sessions: [at("sy", "2026-09-26T08:00:00Z")],
      last_seen_at: "2026-09-26T08:00:00Z",
      open: false,
    });

  it("a session's view-only refs collapse into one 'viewed' line with links (+N more); others keep their rows", () => {
    const committed = makeThread({ ref: "github.com/acme/billing#50", sessions: [{ ...at("sy", "2026-09-26T08:00:00Z"), review_verb: null, build_verb: "committed" }], open: false });
    const html = renderToStaticMarkup(
      <ThreadsContent
        recentThreads={[committed, ...[1, 2, 3, 4, 5, 6, 7].map(viewed)]}
        openThreads={[]}
        recurringBlockers={[]}
        now={NOW}
      />,
    );
    const y = html.slice(html.indexOf('id="pulse-yesterday"'));
    expect(y).toContain('data-testid="yesterday-by-session"');
    expect(y.match(/data-testid="viewed-line"/g)).toHaveLength(1);
    expect(y.match(/data-testid="thread-row"/g)).toHaveLength(1);
    expect(y).toContain('href="https://github.com/acme/billing/issues/1"');
    expect(y).toContain(" +2 more");
    // Yesterday rows are not open threads: no dot, no ⋯.
    expect(y).not.toContain("open-marker");
    expect(y).not.toContain("row-menu");
  });

  it("the window is the previous local calendar day by action time — today's actions are never in Yesterday", () => {
    const { start, end } = yesterdayBounds(NOW);
    expect(new Date(end).getHours()).toBe(0);
    expect(end - start).toBeGreaterThanOrEqual(23 * 3600_000);
    const justBefore = new Date(end - 60_000).toISOString();
    const justAfter = new Date(end + 60_000).toISOString();
    const mk = (n: number, iso: string) =>
      makeThread({ ref: `acme/billing#${n}`, sessions: [at(`s${n}`, iso)], last_seen_at: iso, open: false });
    expect(yesterdayThreads([mk(1, justBefore), mk(2, justAfter), mk(3, new Date(start - 60_000).toISOString())], NOW).map((t) => t.ref)).toEqual([
      "acme/billing#1",
    ]);
  });
});

describe("day navigation on the day section (?day=YYYY-MM-DD)", () => {
  const key = (ms: number) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const yb = yesterdayBounds(NOW);
  const today = { start: yb.end, end: yb.end + (yb.end - yb.start) };

  it("parses the param; invalid, impossible, future or too-old days fall back to yesterday", () => {
    for (const bad of [null, undefined, "", "yesterday", "2026-9-25", "2026-02-30", "2026-13-01", "2027-01-01", "2026-01-01"]) {
      expect(parseDayParam(bad, NOW)).toEqual(yb);
    }
    const thu = parseDayParam("2026-09-24", NOW);
    expect(new Date(thu.start).getDate()).toBe(24);
    expect(new Date(thu.start).getHours()).toBe(0);
    expect(new Date(thu.end).getDate()).toBe(25);
    expect(parseDayParam(key(today.start), NOW).start).toBe(today.start);
  });

  it("labels Today / Yesterday / a weekday date; › stops at Today", () => {
    expect(dayLabel(yb, NOW)).toBe("Yesterday");
    expect(dayLabel(parseDayParam(key(today.start), NOW), NOW)).toBe("Today");
    const older = parseDayParam("2026-09-24", NOW);
    expect(dayLabel(older, NOW)).not.toMatch(/Today|Yesterday/);
    expect(dayLabel(older, NOW)).toMatch(/24/);
    expect(dayNav(yb, NOW)).toEqual({ prev: key(yb.start - 1), next: key(today.start) });
    expect(dayNav(parseDayParam(key(today.start), NOW), NOW).next).toBeNull();
  });

  it("renders ‹ › as real links with aria-labels, keeps ?group=repo, and windows rows to the chosen day", () => {
    const onThe24th = makeThread({
      ref: "codehub.example/acme/billing#24",
      sessions: [{ ...makeThread().sessions[0], id: "s24", proof_session_id: "s24", started_at: "2026-09-24T09:00:00Z", at: "2026-09-24T09:00:00Z" }],
      last_seen_at: "2026-09-24T09:00:00Z",
      open: false,
    });
    const html = render({ recentThreads: [onThe24th], day: "2026-09-24" });
    const y = html.slice(html.indexOf('id="pulse-yesterday"'));
    expect(y).toContain('aria-label="Previous day"');
    expect(y).toContain('href="/pulse?group=repo&amp;day=2026-09-23"');
    expect(y).toContain('href="/pulse?group=repo&amp;day=2026-09-25"');
    expect(y).toContain("acme/billing#24");
    // The default day (yesterday, the 26th) does not show it, and › is disabled on Today.
    expect(render({ recentThreads: [onThe24th] })).toContain("Nothing acted on this day.");
    const todayHtml = renderToStaticMarkup(
      <ThreadsContent recentThreads={[]} openThreads={[]} recurringBlockers={[]} now={NOW} day={key(today.start)} />,
    );
    expect(todayHtml).toContain('data-testid="day-next-disabled"');
    expect(todayHtml).toContain('href="/pulse?day=' + key(yb.start) + '"');
  });

  it("boundary: an action at 23:59 on the chosen day is in; 00:01 the next day is not", () => {
    const d = parseDayParam("2026-09-24", NOW);
    const mk = (n: number, iso: string) =>
      makeThread({ ref: `acme/billing#${n}`, sessions: [{ ...makeThread().sessions[0], id: `b${n}`, proof_session_id: `b${n}`, started_at: iso, at: iso }], last_seen_at: iso, open: false });
    const rows = yesterdayRows(
      [mk(1, new Date(d.end - 60_000).toISOString()), mk(2, new Date(d.end + 60_000).toISOString())],
      NOW,
      [],
      d,
    );
    expect(rows.map((t) => t.ref)).toEqual(["acme/billing#1"]);
  });
});

describe("review r2: day view dating (S2) and open refs on past days (S3)", () => {
  it("S2: a session ending after midnight is dated by its action that day; the ref goes under the session of its latest action", () => {
    const yb = yesterdayBounds(NOW);
    const actAt = new Date(yb.end - 3600_000).toISOString(); // 23:00 yesterday
    const endAt = new Date(yb.end + 2 * 3600_000).toISOString(); // 02:00 today
    const t = makeThread({
      ref: "codehub.example/acme/billing#300",
      sessions: [{ ...makeThread().sessions[0], id: "night", proof_session_id: "night", started_at: actAt, at: actAt, ended_at: endAt }],
      events: [{ session: "night", at: actAt, review_verb: null, build_verb: "committed" }],
      last_seen_at: actAt,
      open: false,
    });
    const [row] = yesterdayRows([t], NOW);
    const [g] = groupBySession([row], {}, NOW);
    expect(g.sessions[0].last_at).toBe(actAt);

    // Open threads: an early-touching session that ENDED last does not win over the session with the ref's latest action.
    const early = { ...makeThread().sessions[0], id: "early", proof_session_id: "early", at: "2026-09-20T09:00:00Z", ended_at: "2026-09-26T23:00:00Z" };
    const lateAct = { ...makeThread().sessions[0], id: "late", proof_session_id: "late", at: "2026-09-25T09:00:00Z", ended_at: "2026-09-25T10:00:00Z" };
    const [p] = groupBySession([makeThread({ sessions: [early, lateAct] })], {}, NOW);
    expect(p.sessions[0].id).toBe("late");
  });

  it("S3: a past day lists a ref acted on that day even while it is an open thread; yesterday still shows each ref once", () => {
    const d = parseDayParam("2026-09-24", NOW);
    const at = new Date(d.start + 10 * 3600_000).toISOString();
    const t = makeThread({ sessions: [{ ...makeThread().sessions[0], at, started_at: at }], last_seen_at: at });
    const html = render({ openThreads: [t], recentThreads: [t], day: "2026-09-24" });
    const day = html.slice(html.indexOf('id="pulse-yesterday"'));
    expect(day).toContain("acme/billing#15178");
    expect(day).not.toContain("Nothing acted on this day.");
    const y = render({ openThreads: [makeThread()], recentThreads: [makeThread()] });
    expect(y.slice(y.indexOf('id="pulse-yesterday"'))).not.toContain('data-ref="codehub.example/acme/billing#15178"');
  });
});
