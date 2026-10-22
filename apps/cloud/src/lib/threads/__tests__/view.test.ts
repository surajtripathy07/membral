// Table-of-inputs lock for every pure function moved out of
// pulse/threads-content.tsx into lib/threads/view.ts (G3 3D-2). This is a
// regression lock for future moves, not a rewrite proof — the pure-move
// guard (deepEqual on the extracted source) is what proves zero behaviour
// change; these tables pin the CURRENT behaviour so a later refactor of this
// file trips a red test instead of silently drifting.
//
// Date-boundary expectations are derived independently (via new Date(y, m,
// d) local constructors), never by re-deriving through the function under
// test, so the lock has teeth. `now` values sit at local noon-ish so the
// calendar day is stable across the CI runner's UTC and this repo's typical
// dev timezones. Locale-formatted strings (dayLabel's non-Today/Yesterday
// branch, fmtDay's non-"today" branch) are asserted with a shape regex, per
// the existing convention (see code-sessions/view.test.ts's
// formatAbsoluteUtc note, and threads-content.test.tsx's dayLabel test).
import { describe, expect, it } from "vitest";
import type { Thread, ThreadSession } from "@/lib/threads/open-threads";
import {
  BLOCKER_ACTIONS,
  BLOCKERS_INITIAL,
  DAY_LOOKBACK_DAYS,
  type DayBounds,
  dayHref,
  dayKey,
  dayLabel,
  dayNav,
  fmtDay,
  formatEstCost,
  formatRowCost,
  groupByRepo,
  groupBySession,
  isPlaceholderTitle,
  isViewOnly,
  ladderWords,
  mergeByRef,
  moreLabel,
  normalizeQuote,
  observedItemText,
  orderBlockers,
  orderYesterday,
  parseDayParam,
  refIdentity,
  refRepo,
  SESSIONS_PER_PROJECT_INITIAL,
  sessionAt,
  sessionRowTitle,
  sessionTurnHref,
  UNTITLED_SESSION,
  VIEWED_REFS_INITIAL,
  YESTERDAY_INITIAL,
  yesterdayBounds,
  yesterdayRows,
  yesterdayThreads,
  yesterdayView,
} from "../view";

const NOW = Date.UTC(2026, 8, 28, 12); // 2026-09-28, local noon-ish everywhere between UTC-12 and UTC+14 except the far edge

/** Independent re-derivation of local-midnight day bounds, NOT the function under test. */
function localDay(ms: number, offsetDays = 0): DayBounds {
  const d = new Date(ms);
  return {
    start: new Date(d.getFullYear(), d.getMonth(), d.getDate() + offsetDays).getTime(),
    end: new Date(d.getFullYear(), d.getMonth(), d.getDate() + offsetDays + 1).getTime(),
  };
}
function localKey(ms: number, offsetDays = 0): string {
  const d = new Date(localDay(ms, offsetDays).start);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function mkSession(overrides: Partial<ThreadSession> = {}): ThreadSession {
  return {
    id: "s1",
    started_at: "2026-09-27T09:00:00Z",
    turn_idx: 1,
    proof_session_id: "s1",
    tier: "observed",
    role: "worked_on",
    review_verb: null,
    build_verb: "committed",
    share: 1,
    cost_est: 5,
    ...overrides,
  };
}

function mkThread(overrides: Partial<Thread> = {}): Thread {
  return {
    ref: "codehub.example/acme/billing#151",
    refKind: "issue",
    url: "https://codehub.example/acme/billing/-/issues/151",
    ladder: { review_verb: null, build_verb: "committed", triaged: false, discussed: false },
    sessions: [mkSession()],
    cost_est_total: 5,
    estimated: true,
    last_seen_at: "2026-09-27T09:00:00Z",
    open: true,
    closure: null,
    ...overrides,
  };
}

describe("constants", () => {
  it("keep their pinned values", () => {
    expect(YESTERDAY_INITIAL).toBe(5);
    expect(BLOCKERS_INITIAL).toBe(3);
    expect(DAY_LOOKBACK_DAYS).toBe(29); // THREAD_WINDOW_DAYS (30) - 1
    expect(UNTITLED_SESSION).toBe("Untitled session");
    expect(SESSIONS_PER_PROJECT_INITIAL).toBe(5);
    expect(VIEWED_REFS_INITIAL).toBe(5);
    expect(BLOCKER_ACTIONS).toEqual([
      { reason: "resolved", label: "Resolved" },
      { reason: "ignored", label: "Ignore" },
    ]);
  });
});

describe("ladderWords", () => {
  it.each<[Parameters<typeof ladderWords>[0], string[]]>([
    [{ ladder: { review_verb: "approved", build_verb: "merged", triaged: false, discussed: true } }, ["discussed"]],
    [{ ladder: { review_verb: "checked_out", build_verb: null, triaged: false, discussed: false } }, ["checked out"]],
    [{ ladder: { review_verb: null, build_verb: "opened_mr", triaged: false, discussed: false } }, ["opened MR"]],
    [
      { ladder: { review_verb: "reviewed", build_verb: "pushed", triaged: false, discussed: false } },
      ["reviewed", "pushed"],
    ],
    [{ ladder: { review_verb: null, build_verb: null, triaged: true, discussed: false } }, ["triaged"]],
    [{ ladder: { review_verb: null, build_verb: null, triaged: false, discussed: false } }, ["discussed"]],
  ])("%o -> %o", (thread, expected) => {
    expect(ladderWords(thread)).toEqual(expected);
  });
});

describe("formatEstCost", () => {
  it.each([
    [null, "—"],
    [undefined, "—"],
    [0, "—"],
    [-5, "—"],
    [Number.NaN, "—"],
    [2.1, "$2.10 est."],
    [2500, "$2,500 est."],
  ])("formatEstCost(%p) -> %p", (amount, expected) => {
    expect(formatEstCost(amount as number | null | undefined)).toBe(expected);
  });
});

describe("formatRowCost", () => {
  it.each([
    [null, "—"],
    [0, "—"],
    [-1, "—"],
    [5, "$5.00"],
    [1500.4, "$1,500"],
  ])("formatRowCost(%p) -> %p", (amount, expected) => {
    expect(formatRowCost(amount as number | null | undefined)).toBe(expected);
  });
});

describe("dayKey", () => {
  it.each([
    [NOW, "2026-09-28"],
    [0, "1970-01-01"],
    [Date.UTC(2026, 0, 5, 12), "2026-01-05"],
    [Date.UTC(2026, 11, 31, 12), "2026-12-31"],
  ])("dayKey(%p) -> %p", (ms, expected) => {
    expect(dayKey(ms)).toBe(expected);
  });
});

describe("yesterdayBounds", () => {
  it("returns [local yesterday midnight, local today midnight) for a mid-day now", () => {
    expect(yesterdayBounds(NOW)).toEqual(localDay(NOW, -1));
  });
  it("is stable at exactly local midnight", () => {
    const midnight = localDay(NOW, 0).start;
    expect(yesterdayBounds(midnight)).toEqual(localDay(midnight, -1));
  });
  it("is stable 1ms before local midnight (still the previous day)", () => {
    const justBefore = localDay(NOW, 0).start - 1;
    expect(yesterdayBounds(justBefore)).toEqual(localDay(justBefore, -1));
  });
  it("rolls over a month boundary", () => {
    const oct1 = Date.UTC(2026, 9, 1, 0, 30);
    expect(yesterdayBounds(oct1)).toEqual(localDay(oct1, -1));
  });
});

describe("parseDayParam", () => {
  const fallback = localDay(NOW, -1);
  it.each<[string | null | undefined, DayBounds]>([
    [null, fallback],
    ["bogus", fallback],
    ["2026-02-30", fallback], // non-existent calendar date
    [localKey(NOW, 1), fallback], // tomorrow: in the future
    [localKey(NOW, 0), localDay(NOW, 0)], // today
    [localKey(NOW, -1), localDay(NOW, -1)], // yesterday
    [localKey(NOW, -DAY_LOOKBACK_DAYS), localDay(NOW, -DAY_LOOKBACK_DAYS)], // oldest allowed day: still valid
    [localKey(NOW, -DAY_LOOKBACK_DAYS - 1), fallback], // one day older than the window: falls back
  ])("parseDayParam(%p, NOW) -> %o", (raw, expected) => {
    expect(parseDayParam(raw, NOW)).toEqual(expected);
  });
});

describe("dayLabel", () => {
  it("labels today's bounds", () => {
    expect(dayLabel(localDay(NOW, 0), NOW)).toBe("Today");
  });
  it("labels yesterday's bounds", () => {
    expect(dayLabel(localDay(NOW, -1), NOW)).toBe("Yesterday");
  });
  it("labels an older day with its weekday/date, not Today/Yesterday", () => {
    const label = dayLabel(localDay(NOW, -8), NOW);
    expect(label).not.toMatch(/^(Today|Yesterday)$/);
    const expectedDay = new Date(localDay(NOW, -8).start).getDate();
    expect(label).toMatch(new RegExp(`\\b${expectedDay}\\b`));
  });
  it("labels a different older day distinctly", () => {
    const label = dayLabel(localDay(NOW, -15), NOW);
    const expectedDay = new Date(localDay(NOW, -15).start).getDate();
    expect(label).toMatch(new RegExp(`\\b${expectedDay}\\b`));
  });
});

describe("dayNav", () => {
  it("today: prev is yesterday, next is null (can't navigate past today)", () => {
    expect(dayNav(localDay(NOW, 0), NOW)).toEqual({ prev: localKey(NOW, -1), next: null });
  });
  it("yesterday: prev/next are both populated", () => {
    expect(dayNav(localDay(NOW, -1), NOW)).toEqual({ prev: localKey(NOW, -2), next: localKey(NOW, 0) });
  });
  it("the oldest allowed day: prev is null (lookback edge)", () => {
    expect(dayNav(localDay(NOW, -DAY_LOOKBACK_DAYS), NOW)).toEqual({
      prev: null,
      next: localKey(NOW, -DAY_LOOKBACK_DAYS + 1),
    });
  });
  it("one day inside the oldest allowed day: prev is populated", () => {
    expect(dayNav(localDay(NOW, -DAY_LOOKBACK_DAYS + 1), NOW)).toEqual({
      prev: localKey(NOW, -DAY_LOOKBACK_DAYS),
      next: localKey(NOW, -DAY_LOOKBACK_DAYS + 2),
    });
  });
});

describe("sessionAt", () => {
  it.each<[Parameters<typeof sessionAt>[0], string | null]>([
    [{ at: "a", started_at: "b" }, "a"],
    [{ at: null, started_at: "b" }, "b"],
    [{ at: undefined, started_at: "b" }, "b"],
    [{ at: null, started_at: null }, null],
  ])("sessionAt(%o) -> %p", (s, expected) => {
    expect(sessionAt(s)).toBe(expected);
  });
});

describe("fmtDay", () => {
  it("returns an em dash for a null iso", () => {
    expect(fmtDay(null, NOW)).toBe("—");
  });
  it("returns an em dash for an unparseable iso", () => {
    expect(fmtDay("bogus", NOW)).toBe("—");
  });
  it("returns 'today' for the same local calendar day as now", () => {
    expect(fmtDay(new Date(NOW).toISOString(), NOW)).toBe("today");
  });
  it("returns a formatted date for any other day", () => {
    const other = "2026-09-20T10:00:00Z";
    const label = fmtDay(other, NOW);
    expect(label).not.toBe("today");
    expect(label).not.toBe("—");
    const expectedDay = new Date(other).getDate();
    expect(label).toMatch(new RegExp(`\\b${expectedDay}\\b`));
  });
});

describe("normalizeQuote", () => {
  it.each([
    ["  hello   world.  ", "hello world"],
    ["done!!", "done"],
    ["", ""],
    ['"quoted."', '"quoted'],
    ["already clean", "already clean"],
  ])("normalizeQuote(%p) -> %p", (text, expected) => {
    expect(normalizeQuote(text)).toBe(expected);
  });
});

describe("sessionTurnHref", () => {
  it.each<[string, number | null | undefined, string]>([
    ["s1", 5, "/code/session/s1?turn=5#turn-5"],
    ["s1", null, "/code/session/s1"],
    ["s1", undefined, "/code/session/s1"],
    ["s2", 0, "/code/session/s2?turn=0#turn-0"],
  ])("sessionTurnHref(%p, %p) -> %p", (id, turn, expected) => {
    expect(sessionTurnHref(id, turn)).toBe(expected);
  });
});

describe("refRepo", () => {
  it.each<[string, string | null]>([
    ["codehub.example/acme/billing#151", "acme/billing"],
    ["#12", null],
    ["codehub.example/acme/billing!151", "acme/billing"],
    ["codehub.example/acme#1", "acme"],
    ["codehub.example:8443/acme/billing#151", "acme/billing"],
  ])("refRepo(%p) -> %p", (ref, expected) => {
    expect(refRepo(ref)).toBe(expected);
  });
});

describe("isPlaceholderTitle", () => {
  it.each([
    ["Untitled session", true],
    ["A short session with no recorded prose. Touched 9 files: a.ts", true],
    ["a short session with no recorded prose (case-insensitive)", true],
    ["Fix the login bug", false],
    ["", false],
  ])("isPlaceholderTitle(%p) -> %p", (title, expected) => {
    expect(isPlaceholderTitle(title)).toBe(expected);
  });
});

describe("sessionRowTitle", () => {
  const titles = { parent: "Parent title", s3: "x".repeat(90), s4: "  fix   /Users/me/proj/file.ts   bug  " };
  it("prefers the proof session's title over the row's own id", () => {
    expect(sessionRowTitle({ id: "s1", proof_session_id: "parent" }, titles)).toBe("Parent title");
  });
  it("falls back to UNTITLED_SESSION when no title reached the page", () => {
    expect(sessionRowTitle({ id: "s2", proof_session_id: "s2" }, {})).toBe(UNTITLED_SESSION);
  });
  it("truncates a title over 80 chars with an ellipsis", () => {
    const got = sessionRowTitle({ id: "s3", proof_session_id: "s3" }, titles);
    expect(got).toBe(`${"x".repeat(80)}…`);
  });
  it("strips local paths and collapses whitespace", () => {
    expect(sessionRowTitle({ id: "s4", proof_session_id: "s4" }, titles)).toBe("fix file.ts bug");
  });
});

describe("isViewOnly", () => {
  it.each<[Parameters<typeof isViewOnly>[0], boolean]>([
    [{ ladder: { review_verb: "viewed", build_verb: null, triaged: false, discussed: false } }, true],
    [{ ladder: { review_verb: null, build_verb: "committed", triaged: false, discussed: false } }, false],
    [{ ladder: { review_verb: null, build_verb: null, triaged: false, discussed: true } }, false],
    [{ ladder: { review_verb: "viewed", build_verb: "committed", triaged: false, discussed: false } }, false],
  ])("isViewOnly(%o) -> %p", (t, expected) => {
    expect(isViewOnly(t)).toBe(expected);
  });
});

describe("observedItemText", () => {
  it.each<[Parameters<typeof observedItemText>[0], string | null]>([
    [{ forge_title: "Fix crash", first_commit_subject: "commit subj" }, "Fix crash"],
    [{ forge_title: undefined, first_commit_subject: "commit subj" }, "commit subj"],
    [{}, null],
    [{ forge_title: null as unknown as undefined, first_commit_subject: null as unknown as undefined }, null],
  ])("observedItemText(%o) -> %p", (t, expected) => {
    expect(observedItemText(t)).toBe(expected);
  });
});

describe("dayHref", () => {
  it.each<[string, "repo" | "session", string]>([
    ["2026-09-27", "repo", "/pulse?group=repo&day=2026-09-27"],
    ["2026-09-27", "session", "/pulse?day=2026-09-27"],
    ["2026-01-01", "repo", "/pulse?group=repo&day=2026-01-01"],
    ["2026-01-01", "session", "/pulse?day=2026-01-01"],
  ])("dayHref(%p, %p) -> %p", (key, grouping, expected) => {
    expect(dayHref(key, grouping)).toBe(expected);
  });
});

describe("moreLabel", () => {
  it.each<[string, number, string]>([
    [" acted on yesterday", 3, "+3 more acted on yesterday"],
    [" acted on yesterday", 0, "+0 more acted on yesterday"],
    [" sessions", 1, "+1 more sessions"],
    ["", 12, "+12 more"],
  ])("moreLabel(%p)(%p) -> %p", (suffix, n, expected) => {
    expect(moreLabel(suffix)(n)).toBe(expected);
  });
});

describe("refIdentity", () => {
  it.each<[Parameters<typeof refIdentity>[0], string]>([
    // D-064: the one key function — hosts kept, port and `www.` normalised away.
    [{ ref: "codehub.example/Acme/Billing#151", refKind: "issue" }, "issue\u0000codehub.example/acme/billing#151"],
    [{ ref: "codehub.example:8443/acme/billing#151", refKind: "issue" }, "issue\u0000codehub.example/acme/billing#151"],
    [{ ref: "acme/billing#151", refKind: "issue" }, "issue\u0000acme/billing#151"],
    [
      { ref: "codehub.example/acme/billing#151", refKind: "merge_request" },
      "merge_request\u0000codehub.example/acme/billing#151",
    ],
    [{ ref: "#9", refKind: "issue" }, "issue\u0000#9"],
  ])("refIdentity(%o) -> %p", (t, expected) => {
    expect(refIdentity(t)).toBe(expected);
  });
});

describe("orderBlockers", () => {
  it("orders by recurrence_count desc, ties by last_seen_at desc, null timestamps last", () => {
    const blockers = [
      {
        id: "a",
        recurrence_count: 2,
        last_seen_at: "2026-09-20T00:00:00Z",
        text: "t",
        quote: null,
        ref: null,
        session_id: null,
        turn_idx: null,
      },
      {
        id: "b",
        recurrence_count: 5,
        last_seen_at: "2026-09-10T00:00:00Z",
        text: "t",
        quote: null,
        ref: null,
        session_id: null,
        turn_idx: null,
      },
      {
        id: "c",
        recurrence_count: 5,
        last_seen_at: "2026-09-15T00:00:00Z",
        text: "t",
        quote: null,
        ref: null,
        session_id: null,
        turn_idx: null,
      },
      {
        id: "d",
        recurrence_count: 2,
        last_seen_at: null,
        text: "t",
        quote: null,
        ref: null,
        session_id: null,
        turn_idx: null,
      },
    ];
    expect(orderBlockers(blockers).map((b) => b.id)).toEqual(["c", "b", "a", "d"]);
  });
  it("returns [] for an empty list", () => {
    expect(orderBlockers([])).toEqual([]);
  });
});

describe("orderYesterday", () => {
  it("priced rows first (most spend first), unpriced rows after (latest first)", () => {
    const a = mkThread({ ref: "a#1", cost_est_total: 3, last_seen_at: "2026-09-27T10:00:00Z" });
    const b = mkThread({ ref: "b#2", cost_est_total: 0, last_seen_at: "2026-09-27T09:00:00Z" });
    const c = mkThread({ ref: "c#3", cost_est_total: null, last_seen_at: "2026-09-27T11:00:00Z" });
    const d = mkThread({ ref: "d#4", cost_est_total: 8, last_seen_at: "2026-09-27T08:00:00Z" });
    expect(orderYesterdayRefs([a, b, c, d])).toEqual(["d#4", "a#1", "c#3", "b#2"]);
  });
  it("breaks an equal-cost tie by last_seen_at desc", () => {
    const t1 = mkThread({ ref: "x#1", cost_est_total: 5, last_seen_at: "2026-09-27T08:00:00Z" });
    const t2 = mkThread({ ref: "x#2", cost_est_total: 5, last_seen_at: "2026-09-27T09:00:00Z" });
    expect(orderYesterdayRefs([t1, t2])).toEqual(["x#2", "x#1"]);
  });
  it("returns [] for an empty list", () => {
    expect(orderYesterdayRefs([])).toEqual([]);
  });
});
function orderYesterdayRefs(threads: Thread[]): string[] {
  return orderYesterday(threads).map((t) => t.ref);
}

describe("mergeByRef", () => {
  it("unions sessions, sums cost, merges the ladder to the higher rung of each", () => {
    const dup1 = mkThread({
      ref: "codehub.example/acme/billing#151",
      sessions: [mkSession({ id: "s1", cost_est: 3 })],
      cost_est_total: 3,
      last_seen_at: "2026-09-27T09:00:00Z",
      ladder: { review_verb: "viewed", build_verb: null, triaged: false, discussed: false },
    });
    const dup2 = mkThread({
      ref: "acme/billing#151",
      sessions: [mkSession({ id: "s2", cost_est: 4 }), mkSession({ id: "s1", cost_est: 999 })],
      cost_est_total: 4,
      last_seen_at: "2026-09-27T12:00:00Z",
      ladder: { review_verb: null, build_verb: "pushed", triaged: true, discussed: false },
    });
    const merged = mergeByRef([dup1, dup2]);
    expect(merged).toHaveLength(1);
    expect(merged[0].sessions.map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(merged[0].cost_est_total).toBe(7);
    expect(merged[0].last_seen_at).toBe("2026-09-27T12:00:00Z");
    expect(merged[0].ladder).toEqual({ review_verb: "viewed", build_verb: "pushed", triaged: true, discussed: false });
  });
  it("keeps the host-qualified ref even when it belongs to the first copy", () => {
    const first = mkThread({ ref: "codehub.example/acme/billing#7", sessions: [mkSession({ id: "s1" })] });
    const second = mkThread({ ref: "acme/billing#7", sessions: [mkSession({ id: "s2" })] });
    expect(mergeByRef([first, second])[0].ref).toBe("codehub.example/acme/billing#7");
  });
  it("adopts the second copy's host-qualified ref when the first has none", () => {
    const first = mkThread({ ref: "acme/billing#7", sessions: [mkSession({ id: "s1" })] });
    const second = mkThread({ ref: "codehub.example/acme/billing#7", sessions: [mkSession({ id: "s2" })] });
    expect(mergeByRef([first, second])[0].ref).toBe("codehub.example/acme/billing#7");
  });
  it("OR-combines dismissed and keeps the first non-null dismiss_reason", () => {
    const first = mkThread({ ref: "acme/billing#7", sessions: [mkSession({ id: "s1" })], dismissed: undefined });
    const second = mkThread({
      ref: "codehub.example/acme/billing#7",
      sessions: [mkSession({ id: "s2" })],
      dismissed: true,
      dismiss_reason: "resolved_elsewhere",
    });
    const merged = mergeByRef([first, second])[0];
    expect(merged.dismissed).toBe(true);
    expect(merged.dismiss_reason).toBe("resolved_elsewhere");
  });
  it("R3 ADV 4 (D-064): the same owner/repo#N on two forges stays two threads", () => {
    const gh = mkThread({ ref: "github.com/acme/api#5", sessions: [mkSession({ id: "s1" })] });
    const ch = mkThread({ ref: "codehub.example/acme/api#5", sessions: [mkSession({ id: "s2" })] });
    expect(mergeByRef([gh, ch]).map((t) => t.ref)).toEqual(["github.com/acme/api#5", "codehub.example/acme/api#5"]);
    // A host-less copy beside two forges joins neither.
    const bare = mkThread({ ref: "acme/api#5", sessions: [mkSession({ id: "s3" })] });
    expect(mergeByRef([gh, ch, bare])).toHaveLength(3);
  });
  it("passes a single, non-duplicate thread through unchanged", () => {
    const only = mkThread({ ref: "acme/billing#1" });
    expect(mergeByRef([only])).toEqual([only]);
  });
});

describe("groupByRepo", () => {
  it("groups by repo, first-appearance order, rows keep their sort", () => {
    const a1 = mkThread({ ref: "codehub.example/acme/billing#1" });
    const a2 = mkThread({ ref: "codehub.example/acme/billing#2" });
    const b1 = mkThread({ ref: "codehub.example/acme/other#9" });
    expect(groupByRepo([a1, a2, b1]).map((g) => ({ repo: g.repo, n: g.threads.length }))).toEqual([
      { repo: "acme/billing", n: 2 },
      { repo: "acme/other", n: 1 },
    ]);
  });
  it("groups repo-less refs (bare `#N`) under a single null-repo group", () => {
    expect(groupByRepo([mkThread({ ref: "#5" }), mkThread({ ref: "#6" })])).toEqual([
      { repo: null, threads: [mkThread({ ref: "#5" }), mkThread({ ref: "#6" })] },
    ]);
  });
  it("returns [] for an empty list", () => {
    expect(groupByRepo([])).toEqual([]);
  });
});

describe("yesterdayView", () => {
  it("windows to in-window events only, dates sessions by their latest in-window action", () => {
    const t = mkThread({
      events: [
        { session: "s1", at: "2026-09-27T10:00:00Z", review_verb: "reviewed", build_verb: null },
        { session: "s1", at: "2026-09-26T10:00:00Z", review_verb: "approved", build_verb: null },
      ],
      sessions: [mkSession({ id: "s1", started_at: "2026-09-26T09:00:00Z", cost_est: 2 })],
    });
    const v = yesterdayView(t, NOW);
    expect(v.sessions).toEqual([expect.objectContaining({ id: "s1", at: "2026-09-27T10:00:00Z", ended_at: null })]);
    expect(v.ladder).toEqual({ review_verb: "reviewed", build_verb: null, triaged: false, discussed: false });
    expect(v.cost_est_total).toBe(2);
    expect(v.last_seen_at).toBe("2026-09-27T10:00:00Z");
  });
  it("falls back to a session's own row when it has no events, discussed when no rung and every session is discussed-tier", () => {
    const t = mkThread({
      sessions: [
        mkSession({
          id: "s2",
          started_at: "2026-09-27T09:00:00Z",
          review_verb: null,
          build_verb: null,
          tier: "discussed",
        }),
      ],
    });
    const v = yesterdayView(t, NOW);
    expect(v.sessions.map((s) => s.id)).toEqual(["s2"]);
    expect(v.ladder).toEqual({ review_verb: null, build_verb: null, triaged: false, discussed: true });
  });
  it("is not discussed when a rung was reached even with no events", () => {
    const t = mkThread({ sessions: [mkSession({ id: "s2", started_at: "2026-09-27T09:00:00Z" })] });
    expect(yesterdayView(t, NOW).ladder.discussed).toBe(false);
  });
  it("drops sessions entirely outside the window", () => {
    const t = mkThread({ sessions: [mkSession({ id: "s3", started_at: "2026-09-25T09:00:00Z" })] });
    const v = yesterdayView(t, NOW);
    expect(v.sessions).toEqual([]);
    expect(v.cost_est_total).toBeNull();
  });
});

describe("yesterdayThreads", () => {
  it("keeps only threads with a session in the window, latest-first order preserved", () => {
    const inWindow = mkThread({ ref: "a#1", sessions: [mkSession({ id: "s1", started_at: "2026-09-27T09:00:00Z" })] });
    const outOfWindow = mkThread({ ref: "b#2", sessions: [] });
    expect(yesterdayThreads([inWindow, outOfWindow], NOW).map((t) => t.ref)).toEqual(["a#1"]);
  });
  it("returns [] when nothing falls in the window", () => {
    expect(yesterdayThreads([mkThread({ sessions: [] })], NOW)).toEqual([]);
  });
});

describe("yesterdayRows", () => {
  it("merges by ref, orders, and drops refs already shown above", () => {
    const dup1 = mkThread({
      ref: "codehub.example/acme/billing#151",
      sessions: [mkSession({ id: "s1", started_at: "2026-09-27T09:00:00Z", cost_est: 3 })],
    });
    const dup2 = mkThread({
      ref: "acme/billing#151",
      sessions: [mkSession({ id: "s2", started_at: "2026-09-27T09:00:00Z", cost_est: 4 })],
    });
    const above = mkThread({
      ref: "acme/billing#999",
      sessions: [mkSession({ id: "sX", started_at: "2026-09-27T09:00:00Z" })],
    });
    const shown = mkThread({ ref: "acme/billing#999" });
    expect(yesterdayRows([dup1, dup2, above], NOW, [shown]).map((t) => t.ref)).toEqual([
      "codehub.example/acme/billing#151",
    ]);
  });
  it("shows everything when nothing was shown above", () => {
    const t = mkThread({
      ref: "acme/billing#1",
      sessions: [mkSession({ id: "s1", started_at: "2026-09-27T09:00:00Z" })],
    });
    expect(yesterdayRows([t], NOW, []).map((th) => th.ref)).toEqual(["acme/billing#1"]);
  });
  it("returns [] when nothing falls in the window", () => {
    expect(yesterdayRows([mkThread({ sessions: [] })], NOW)).toEqual([]);
  });
});

describe("groupBySession", () => {
  it("groups each ref under its LATEST session only, sessions newest-first", () => {
    const t1 = mkThread({
      ref: "codehub.example/acme/billing#1",
      sessions: [mkSession({ id: "s1", at: "2026-09-27T09:00:00Z", started_at: "2026-09-27T08:00:00Z" })],
    });
    const t2 = mkThread({
      ref: "codehub.example/acme/billing#2",
      sessions: [
        mkSession({ id: "s1", at: "2026-09-27T09:00:00Z", started_at: "2026-09-27T08:00:00Z" }),
        mkSession({ id: "s2", at: "2026-09-27T10:00:00Z", started_at: "2026-09-27T09:30:00Z" }),
      ],
    });
    const groups = groupBySession([t1, t2], { s1: "Session one", s2: "Session two" }, NOW);
    expect(groups).toHaveLength(1);
    expect(groups[0].sessions.map((s) => ({ id: s.id, title: s.title, threads: s.threads.map((t) => t.ref) }))).toEqual(
      [
        { id: "s2", title: "Session two", threads: ["codehub.example/acme/billing#2"] },
        { id: "s1", title: "Session one", threads: ["codehub.example/acme/billing#1"] },
      ],
    );
  });
  it("skips a thread with no sessions", () => {
    expect(groupBySession([mkThread({ sessions: [] })], {}, NOW)).toEqual([]);
  });
  it("falls back to 'Session · <date>' when the title is a placeholder", () => {
    const today = mkThread({
      ref: "codehub.example/acme/b#2",
      sessions: [
        mkSession({
          id: "sNew",
          at: new Date(NOW - 1000).toISOString(),
          started_at: new Date(NOW - 2000).toISOString(),
        }),
      ],
    });
    const groups = groupBySession([today], {}, NOW);
    expect(groups[0].sessions[0].title).toBe("Session · today");
  });
  it("orders projects by their latest session's last_at, newest first", () => {
    const older = mkThread({
      ref: "codehub.example/acme/a#1",
      sessions: [mkSession({ id: "sOld", at: "2026-09-20T09:00:00Z", started_at: "2026-09-20T08:00:00Z" })],
    });
    const newer = mkThread({
      ref: "codehub.example/acme/b#2",
      sessions: [mkSession({ id: "sNew", at: "2026-09-28T09:00:00Z", started_at: "2026-09-28T08:00:00Z" })],
    });
    const groups = groupBySession([older, newer], {}, NOW);
    expect(groups.map((g) => g.repo)).toEqual(["acme/b", "acme/a"]);
  });
});
