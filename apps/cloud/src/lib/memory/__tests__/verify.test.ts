import { makeMemoryFakeSupabase as makeFakeSupabase } from "@membral/test-kit";
import { describe, expect, it, vi } from "vitest";
import { groundAgainstTurns } from "../grounding";
import {
  buildServeContext,
  decidedByCitedTurn,
  type MemoryRow,
  normalizeWhitespace,
  serveContextFromRows,
  toServedRecord,
  type VerifiableRecord,
  type VerifyStats,
  verifyRecords,
} from "../verify";

describe("normalizeWhitespace", () => {
  it("collapses runs of whitespace and trims", () => {
    expect(normalizeWhitespace("  fixed   the   flaky\ntest  ")).toBe("fixed the flaky test");
  });
});

describe("verifyRecords (rule 3 receipt re-check)", () => {
  it("paginates past the 1000-row page cap instead of silently truncating (step2c, #151 — a session's turn near the tail of a >1000-row batch must still be found)", async () => {
    const turns = Array.from({ length: 1500 }, (_, i) => ({
      session_id: "s1",
      idx: i,
      text: i === 1200 ? "the fix lands in a follow-up commit after review" : `filler turn ${i}`,
      props: {},
    }));
    const supabase = makeFakeSupabase({ code_session_turns: turns });
    const records: VerifiableRecord[] = [
      {
        id: "r1",
        code_session_id: "s1",
        turn_idx: 1200,
        kind: "decision",
        text: "The fix lands in a follow-up commit after review.",
        quote: "the fix lands in a follow-up commit after review",
        ref: null,
      },
    ];
    const result = await verifyRecords(supabase, records);
    expect(result.get("r1")).toMatchObject({ verified: true, turn_idx: 1200 });
  });

  it("passes on a quote taken from a tool_use turn's written text (Write/Edit content kept by the parser)", async () => {
    const supabase = makeFakeSupabase({
      code_session_turns: [
        {
          session_id: "s1",
          idx: 4,
          role: "assistant",
          kind: "tool_use",
          tool_name: "Write",
          file_path: "/home/dev/codehub-api/docs/goals/queue.md",
          text: "# Queue ruling\n\nRuling: the queue worker keeps a 30 s visibility timeout; do not raise it.\n",
          props: {},
        },
      ],
    });
    const records: VerifiableRecord[] = [
      {
        id: "r1",
        code_session_id: "s1",
        turn_idx: 4,
        kind: "decision",
        text: "The queue worker keeps a 30 s visibility timeout; do not raise it.",
        quote: "the queue worker keeps a 30 s visibility timeout; do not raise it",
        ref: null,
      },
    ];
    const result = await verifyRecords(supabase, records);
    expect(result.get("r1")).toMatchObject({ verified: true, turn_idx: 4 });
  });

  it("passes when the quote is an exact substring of the turn at the stored turn_idx", async () => {
    const supabase = makeFakeSupabase({
      code_session_turns: [
        { session_id: "s1", idx: 3, text: "we decided to key the cache on repo + branch", props: {} },
      ],
    });
    const records: VerifiableRecord[] = [
      {
        id: "r1",
        code_session_id: "s1",
        turn_idx: 3,
        kind: "decision",
        text: "The cache is keyed on repo + branch.",
        quote: "decided to key the cache on repo + branch",
        ref: null,
      },
    ];
    const result = await verifyRecords(supabase, records);
    expect(result.get("r1")).toMatchObject({ verified: true, turn_idx: 3 });
  });

  it("normalizes whitespace before comparing (rule 3)", async () => {
    const supabase = makeFakeSupabase({
      code_session_turns: [
        { session_id: "s1", idx: 0, text: "fixed   the\nflaky checkout test by pinning the clock", props: {} },
      ],
    });
    const records: VerifiableRecord[] = [
      {
        id: "r1",
        code_session_id: "s1",
        turn_idx: 0,
        kind: "learning",
        text: "The flaky checkout test is fixed by pinning the clock.",
        quote: "fixed the flaky checkout test by pinning the clock",
        ref: null,
      },
    ];
    const result = await verifyRecords(supabase, records);
    expect(result.get("r1")?.verified).toBe(true);
  });

  it("repairs turn_idx via fallback search when the quote moved (a re-import shifted indices)", async () => {
    const supabase = makeFakeSupabase({
      code_session_turns: [
        { session_id: "s1", idx: 5, text: "unrelated turn text", props: {} },
        { session_id: "s1", idx: 9, text: "the flaky checkout test is fixed now by pinning the clock", props: {} },
      ],
    });
    const records: VerifiableRecord[] = [
      {
        id: "r1",
        code_session_id: "s1",
        turn_idx: 5,
        kind: "learning",
        text: "The flaky checkout test is fixed by pinning the clock.",
        quote: "the flaky checkout test is fixed now by pinning the clock",
        ref: null,
      },
    ];
    const result = await verifyRecords(supabase, records);
    expect(result.get("r1")).toMatchObject({ verified: true, turn_idx: 9 });
  });

  it("verifies via normalizeQuote when the stored quote has a trailing ellipsis the turn text doesn't (step2c residual 2, #151)", async () => {
    const supabase = makeFakeSupabase({
      code_session_turns: [
        {
          session_id: "s1",
          idx: 0,
          text: "the flaky checkout test is fixed now, and CI is green again",
          props: {},
        },
      ],
    });
    const records: VerifiableRecord[] = [
      {
        id: "r1",
        code_session_id: "s1",
        turn_idx: 0,
        kind: "learning",
        text: "The flaky checkout test is fixed and CI is green.",
        quote: "the flaky checkout test is fixed now, and CI is green...",
        ref: null,
      },
    ];
    const result = await verifyRecords(supabase, records);
    expect(result.get("r1")?.verified).toBe(true);
  });

  it("never verifies a preference whose quote only matches an assistant turn (step2c — agreeing with merge.ts's write-side role invariant, #151)", async () => {
    const supabase = makeFakeSupabase({
      code_session_turns: [
        {
          session_id: "s1",
          idx: 4,
          role: "assistant",
          text: "you asked for a less liquid-heavy distribution that still keeps resilience",
          props: {},
        },
      ],
    });
    const records: VerifiableRecord[] = [
      {
        id: "r1",
        code_session_id: "s1",
        turn_idx: 4,
        kind: "preference",
        text: "Keep a less liquid-heavy distribution that still keeps resilience.",
        quote: "a less liquid-heavy distribution that still keeps resilience",
        ref: null,
      },
    ];
    const result = await verifyRecords(supabase, records);
    expect(result.get("r1")).toMatchObject({ verified: false, turn_idx: 4 });
  });

  it("verifies a preference whose quote matches a user turn", async () => {
    const supabase = makeFakeSupabase({
      code_session_turns: [{ session_id: "s1", idx: 4, role: "user", text: "I want tabs, not spaces", props: {} }],
    });
    const records: VerifiableRecord[] = [
      {
        id: "r1",
        code_session_id: "s1",
        turn_idx: 4,
        kind: "preference",
        text: "Use tabs, not spaces.",
        quote: "I want tabs, not spaces",
        ref: null,
      },
    ];
    const result = await verifyRecords(supabase, records);
    expect(result.get("r1")?.verified).toBe(true);
  });

  it("fails (but is still returned, never dropped) when the quote appears nowhere in the session", async () => {
    const supabase = makeFakeSupabase({
      code_session_turns: [{ session_id: "s1", idx: 0, text: "totally unrelated content", props: {} }],
    });
    const records: VerifiableRecord[] = [
      {
        id: "r1",
        code_session_id: "s1",
        turn_idx: 0,
        kind: "decision",
        text: "A sentence nobody actually wrote is never grounded.",
        quote: "a sentence nobody actually wrote",
        ref: null,
      },
    ];
    const result = await verifyRecords(supabase, records);
    expect(result.get("r1")).toMatchObject({ verified: false, turn_idx: 0 });
  });

  it("for an outcome, requires the ref to appear in props.inputDigest (in addition to the quote)", async () => {
    const supabase = makeFakeSupabase({
      code_session_turns: [
        { session_id: "s1", idx: 2, text: "pushed the fix", props: { inputDigest: "gh pr create --title fix" } },
      ],
    });
    const records: VerifiableRecord[] = [
      {
        id: "r1",
        code_session_id: "s1",
        turn_idx: 2,
        kind: "outcome",
        text: "Opened the fix PR.",
        quote: "pushed the fix",
        ref: "gh pr create",
      },
    ];
    const result = await verifyRecords(supabase, records);
    expect(result.get("r1")?.verified).toBe(true);
  });

  it("fails an outcome whose ref is not in the turn's inputDigest or text, even with a matching quote", async () => {
    const supabase = makeFakeSupabase({
      code_session_turns: [
        { session_id: "s1", idx: 2, text: "pushed the fix", props: { inputDigest: "git commit -m fix" } },
      ],
    });
    const records: VerifiableRecord[] = [
      {
        id: "r1",
        code_session_id: "s1",
        turn_idx: 2,
        kind: "outcome",
        text: "Opened the fix PR.",
        quote: "pushed the fix",
        ref: "#999",
      },
    ];
    const result = await verifyRecords(supabase, records);
    expect(result.get("r1")?.verified).toBe(false);
  });

  it("batches into ONE query regardless of how many records share a session (never N+1)", async () => {
    let calls = 0;
    const supabase = makeFakeSupabase({
      code_session_turns: [
        { session_id: "s1", idx: 0, text: "alpha", props: {} },
        { session_id: "s1", idx: 1, text: "beta", props: {} },
      ],
    });
    const original = supabase.from.bind(supabase);
    supabase.from = (table: string) => {
      if (table === "code_session_turns") calls++;
      return original(table);
    };
    const records: VerifiableRecord[] = [
      { id: "r1", code_session_id: "s1", turn_idx: 0, kind: "learning", text: "alpha", quote: "alpha", ref: null },
      { id: "r2", code_session_id: "s1", turn_idx: 1, kind: "learning", text: "beta", quote: "beta", ref: null },
    ];
    await verifyRecords(supabase, records);
    expect(calls).toBe(1);
  });

  it("returns an empty map for an empty input without querying", async () => {
    let calls = 0;
    const supabase = makeFakeSupabase({});
    const original = supabase.from.bind(supabase);
    supabase.from = (table: string) => {
      calls++;
      return original(table);
    };
    const result = await verifyRecords(supabase, []);
    expect(result.size).toBe(0);
    expect(calls).toBe(0);
  });

  // step2d finding 12 (issue #151, driver follow-up 2026-09-13): the stored
  // quote may have had phone/email PII redacted at write time (merge.ts's
  // redactRecordPii) while the turn's own text never is — the serve-side
  // re-check must redact the turn text the same way before comparing, or a
  // genuinely-verbatim (pre-redaction) quote never verifies.
  it("verifies a quote whose phone number was redacted at write time against the turn's raw (unredacted) text", async () => {
    const supabase = makeFakeSupabase({
      code_session_turns: [
        { session_id: "s1", idx: 0, text: "call me at 555-123-4567 today about the release checklist", props: {} },
      ],
    });
    const records: VerifiableRecord[] = [
      {
        id: "r1",
        code_session_id: "s1",
        turn_idx: 0,
        kind: "decision",
        text: "The release checklist call happens today.",
        quote: "call me at [redacted] today about the release checklist",
        ref: null,
      },
    ];
    const result = await verifyRecords(supabase, records);
    expect(result.get("r1")).toMatchObject({ verified: true, turn_idx: 0 });
  });
});

// W1 (memory_search latency): verifyRecords reads only the CITED turns and
// falls back to the whole session only when the outcome could depend on
// another turn. The served verified set must be exactly what the pre-W1
// whole-session read produced: groundAgainstTurns(record, everyTurn).
describe("verifyRecords targeted turn reads (W1)", () => {
  const SHA = "3f9a2c1d8e";
  const turns = [
    { session_id: "s1", idx: 0, role: "user", text: "please always use pnpm for installs in this repo", props: {} },
    { session_id: "s1", idx: 1, role: "assistant", text: "ok", props: {} },
    {
      session_id: "s1",
      idx: 2,
      role: "assistant",
      text: "we decided to key the cache on repo plus branch so stale entries never leak",
      props: {},
    },
    { session_id: "s1", idx: 3, role: "assistant", text: "ran the tests", props: { inputDigest: `git push ${SHA}` } },
    {
      session_id: "s1",
      idx: 4,
      role: "assistant",
      text: "shipped the fix for the flaky checkout test, merged as main",
      props: { inputDigest: "gh pr merge" },
    },
    { session_id: "s1", idx: 5, role: "assistant", text: "filler", props: {} },
    {
      session_id: "s2",
      idx: 0,
      role: "assistant",
      text: "learned that the vitest default timeout is five seconds under the parallel gate run",
      props: {},
    },
    { session_id: "s2", idx: 1, role: "user", text: "thanks", props: {} },
  ];
  const rec = (r: Partial<VerifiableRecord> & { id: string }): VerifiableRecord => ({
    code_session_id: "s1",
    turn_idx: 0,
    kind: "decision",
    text: "",
    quote: null,
    ref: null,
    ...r,
  });
  const records: VerifiableRecord[] = [
    // decided at the cited turn
    rec({ id: "a-hit", kind: "preference", turn_idx: 0, text: "Use pnpm.", quote: "always use pnpm for installs" }),
    rec({
      id: "a-hit-decision",
      turn_idx: 2,
      text: "Cache keyed on repo plus branch.",
      quote: "we decided to key the cache on repo plus branch so stale entries never leak",
    }),
    rec({ id: "no-quote", kind: "learning", turn_idx: 1, text: "x", quote: null }),
    rec({ id: "short-quote", kind: "learning", turn_idx: 1, text: "x", quote: "ok." }),
    rec({ id: "outcome-sha-here", kind: "outcome", turn_idx: 3, text: "pushed", quote: null, ref: SHA }),
    rec({ id: "outcome-nonspecific", kind: "outcome", turn_idx: 1, text: "merged", quote: null, ref: "main" }),
    rec({ id: "generic-miss", kind: "learning", turn_idx: 1, text: "fine", quote: "looks good to me" }),
    // need the whole session
    rec({
      id: "b-moved",
      turn_idx: 5,
      text: "Cache keyed on repo plus branch.",
      quote: "we decided to key the cache on repo plus branch so stale entries never leak",
    }),
    rec({ id: "outcome-sha-elsewhere", kind: "outcome", turn_idx: 5, text: "pushed", quote: null, ref: SHA }),
    rec({
      id: "outcome-quote-ref-elsewhere",
      kind: "outcome",
      turn_idx: 4,
      text: "Shipped the flaky checkout test fix.",
      quote: "shipped the fix for the flaky checkout test",
      ref: SHA,
    }),
    rec({ id: "dangling", turn_idx: 99, text: "Cache keyed.", quote: "key the cache on repo plus branch so stale" }),
    rec({
      id: "pref-on-assistant",
      kind: "preference",
      turn_idx: 2,
      text: "cache",
      quote: "we decided to key the cache on repo plus branch",
    }),
    rec({
      id: "nowhere",
      text: "Something about databases and migrations nobody said.",
      quote: "we migrated every database table to the new schema last night",
    }),
    // second session, decided
    rec({
      id: "s2-hit",
      code_session_id: "s2",
      kind: "learning",
      turn_idx: 0,
      text: "vitest default timeout is five seconds",
      quote: "the vitest default timeout is five seconds",
    }),
  ];

  function expected(r: VerifiableRecord) {
    const g = groundAgainstTurns(
      { kind: r.kind, text: r.text, quote: r.quote, ref: r.ref, turn_idx: r.turn_idx, userTurnsOnly: false },
      turns.filter((t) => t.session_id === r.code_session_id),
    );
    return { verified: g.verified, turn_idx: g.turn_idx, reason: g.reason, turn_role: g.turn_role ?? undefined };
  }

  it("serves exactly the whole-session outcome for every record (verified flag, repaired turn, reason, role)", async () => {
    const result = await verifyRecords(makeFakeSupabase({ code_session_turns: turns }), records);
    for (const r of records) {
      const got = result.get(r.id);
      const want = expected(r);
      expect({ id: r.id, ...got, quote: undefined }).toEqual({ id: r.id, ...want, quote: undefined });
    }
    // sanity: the fixture exercises both outcomes
    const verified = records.filter((r) => result.get(r.id)?.verified).map((r) => r.id);
    expect(verified).toEqual(expect.arrayContaining(["a-hit", "b-moved", "outcome-sha-elsewhere", "s2-hit"]));
    expect(verified).not.toContain("nowhere");
  });

  it("decides cited-turn hits without reading the rest of the session, and reads whole sessions only for the undecided", async () => {
    const decidedOnly = records.filter((r) =>
      [
        "a-hit",
        "a-hit-decision",
        "no-quote",
        "short-quote",
        "outcome-sha-here",
        "outcome-nonspecific",
        "generic-miss",
        "s2-hit",
      ].includes(r.id),
    );
    const supabase = makeFakeSupabase({ code_session_turns: turns });
    const fromSpy = vi.spyOn(supabase, "from");
    const stats: VerifyStats = { targeted: 0, full_session: 0, turns_read: 0 };
    await verifyRecords(supabase, decidedOnly, 0, stats);
    expect(stats).toEqual({ targeted: decidedOnly.length, full_session: 0, turns_read: 5 }); // s1 turns 0-3 + s2 turn 0
    expect(fromSpy).toHaveBeenCalledTimes(2); // one targeted query per session, no full read

    const all: VerifyStats = { targeted: 0, full_session: 0, turns_read: 0 };
    await verifyRecords(makeFakeSupabase({ code_session_turns: turns }), records, 0, all);
    // b-moved, outcome-sha-elsewhere, outcome-quote-ref-elsewhere, dangling, pref-on-assistant.
    // "nowhere" shares no content word with its text, so its quote may not move (M2): decided at the cited turn.
    expect(all.full_session).toBe(5);
    expect(all.targeted).toBe(records.length - 5);
  });

  it("decidedByCitedTurn: false without a cited turn; true for a non-movable quote that misses", () => {
    const t = { idx: 1, role: "assistant", text: "ok", props: {} };
    expect(decidedByCitedTurn(rec({ id: "x", turn_idx: 1, quote: "looks good to me", text: "fine" }), undefined)).toBe(
      false,
    );
    expect(decidedByCitedTurn(rec({ id: "x", turn_idx: 1, quote: "looks good to me", text: "fine" }), t)).toBe(true);
  });

  it("chunks a session's cited turn ids at 100 per query", async () => {
    const many = Array.from({ length: 250 }, (_, i) => ({
      session_id: "s9",
      idx: i,
      role: "assistant",
      text: `turn ${i} we decided to keep receipts verbatim`,
      props: {},
    }));
    const supabase = makeFakeSupabase({ code_session_turns: many });
    const fromSpy = vi.spyOn(supabase, "from");
    const recs = many.map((t) =>
      rec({
        id: `r${t.idx}`,
        code_session_id: "s9",
        turn_idx: t.idx,
        text: "keep receipts verbatim",
        quote: `turn ${t.idx} we decided to keep receipts verbatim`,
      }),
    );
    const result = await verifyRecords(supabase, recs);
    expect(fromSpy).toHaveBeenCalledTimes(3);
    expect([...result.values()].every((v) => v.verified)).toBe(true);
  });
});

describe("toServedRecord `when` (session time, not extraction time)", () => {
  const row = {
    id: "m1",
    code_session_id: "s1",
    code_project_id: "p1",
    created_at: "2026-10-08T07:10:24Z", // backfill re-extracted today
    chat_conversation_id: null,
    branch: null,
    kind: "decision",
    source: "extracted",
    text: "t",
    quote: null,
    ref: null,
    agent_id: null,
    turn_idx: 0,
    turn_role: "user",
    durable: false,
    verified: false,
    confidence: 1,
  } as unknown as MemoryRow;
  const verify = { verified: true, turn_idx: 0 };

  it("uses the session's ended_at, then started_at, then created_at", () => {
    const base = { repoNames: new Map(), mergedAt: new Map(), chatPrecontext: new Map() };
    const withEnd = serveContextFromRows(
      [],
      [],
      [],
      [{ id: "s1", started_at: "2026-10-06T08:00:00Z", ended_at: "2026-10-06T09:30:00Z" }],
    );
    expect(toServedRecord(row, verify, withEnd).when).toBe("2026-10-06T09:30:00Z");
    const startOnly = serveContextFromRows(
      [],
      [],
      [],
      [{ id: "s1", started_at: "2026-10-06T08:00:00Z", ended_at: null }],
    );
    expect(toServedRecord(row, verify, startOnly).when).toBe("2026-10-06T08:00:00Z");
    const none = { ...base, sessionTimes: new Map<string, string>() };
    expect(toServedRecord(row, verify, none).when).toBe("2026-10-08T07:10:24Z");
  });

  it("buildServeContext reads all sessions in one batched query", async () => {
    const supabase = makeFakeSupabase({
      code_sessions: [
        { id: "s1", user_id: "u1", started_at: "2026-10-06T08:00:00Z", ended_at: "2026-10-06T09:30:00Z" },
      ],
    });
    const ctx = await buildServeContext(supabase, "u1", [row, { ...row, id: "m2" }]);
    expect(toServedRecord(row, verify, ctx).when).toBe("2026-10-06T09:30:00Z");
  });

  it("buildServeContext reads only the caller's projects: another user's project gives no ref_url", async () => {
    const projects = [{ id: "p1", user_id: "u2", display_name: null, repo_identity: "github.com/acme/codehub" }];
    const linked = { ...row, ref: "#12", ref_kind: "issue" } as unknown as MemoryRow;
    const other = await buildServeContext(makeFakeSupabase({ code_projects: projects }), "u1", [linked]);
    expect(toServedRecord(linked, verify, other).ref_url).toBeNull();
    const own = await buildServeContext(
      makeFakeSupabase({ code_projects: [{ ...projects[0], user_id: "u1" }] }),
      "u1",
      [linked],
    );
    expect(toServedRecord(linked, verify, own).ref_url).toBe("https://github.com/acme/codehub/issues/12");
  });

  it("a failed or throwing code_sessions read does not fail the call: when falls back to created_at", async () => {
    const fromReal = makeFakeSupabase({ code_projects: [], memory_branch_state: [], conversations: [] });
    const failing = {
      ...fromReal,
      from: (t: string) =>
        t === "code_sessions"
          ? { select: () => ({ eq: () => ({ in: async () => ({ data: null, error: { message: "boom" } }) }) }) }
          : fromReal.from(t),
    } as unknown as typeof fromReal;
    const ctx = await buildServeContext(failing, "u1", [row]);
    expect(toServedRecord(row, verify, ctx).when).toBe("2026-10-08T07:10:24Z");
  });

  it("chunks the session id list (no .in() over 100 ids)", async () => {
    const sizes: number[] = [];
    const fromReal = makeFakeSupabase({});
    const spy = {
      ...fromReal,
      from: (t: string) =>
        t === "code_sessions"
          ? {
              select: () => ({
                eq: () => ({
                  in: async (_c: string, ids: string[]) => {
                    sizes.push(ids.length);
                    return { data: [], error: null };
                  },
                }),
              }),
            }
          : fromReal.from(t),
    } as unknown as typeof fromReal;
    const many = Array.from({ length: 250 }, (_, i) => ({ ...row, id: `m${i}`, code_session_id: `s${i}` }));
    await buildServeContext(spy, "u1", many);
    expect(sizes.sort((a, b) => b - a)).toEqual([100, 100, 50]);
  });
});

describe("toServedRecord source links (sha, paths, ref_url)", () => {
  const row = {
    id: "m1",
    code_session_id: "5c61aaaa-0000-4000-8000-000000000001",
    code_project_id: "p1",
    created_at: "2026-10-08T07:10:24Z",
    chat_conversation_id: null,
    branch: null,
    kind: "decision",
    source: "hook",
    text: "t",
    quote: null,
    ref: null,
    ref_kind: null,
    head_sha: null,
    paths: [],
    agent_id: null,
    turn_idx: 0,
    turn_role: "user",
    durable: false,
    verified: false,
    confidence: 1,
  } as unknown as MemoryRow;
  const verify = { verified: true, turn_idx: 0 };
  const ctx = serveContextFromRows(
    [
      { id: "p1", display_name: "codehub", repo_identity: "github.com/acme/codehub" },
      { id: "p2", display_name: null, repo_identity: "codehub.example/acme/billing" },
      { id: "p3", display_name: null, repo_identity: "/Users/dev/scratch" },
    ],
    [],
    [],
  );

  it("keeps the full session id and serves the full head_sha; no sha when the row has none", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const out = toServedRecord({ ...row, head_sha: sha }, verify, ctx);
    expect(out.session_id).toBe("5c61aaaa-0000-4000-8000-000000000001");
    expect(out.sha).toBe(sha);
    expect(toServedRecord(row, verify, ctx).sha).toBeNull();
  });

  it("serves at most five paths, dropping blanks", () => {
    const paths = ["a.ts", "", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts"];
    expect(toServedRecord({ ...row, paths }, verify, ctx).paths).toEqual(["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"]);
    expect(toServedRecord(row, verify, ctx).paths).toEqual([]);
  });

  it("qualifies a bare ref by the project's identity into its forge URL", () => {
    const at = (r: Partial<MemoryRow>) => toServedRecord({ ...row, ...r } as MemoryRow, verify, ctx).ref_url;
    expect(at({ ref: "#12", ref_kind: "issue" })).toBe("https://github.com/acme/codehub/issues/12");
    expect(at({ ref: "#34", ref_kind: "pr" })).toBe("https://github.com/acme/codehub/pull/34");
    expect(at({ code_project_id: "p2", ref: "!34", ref_kind: "mr" })).toBe(
      "https://codehub.example/acme/billing/-/merge_requests/34",
    );
    // Already qualified: its own host wins.
    expect(at({ ref: "codehub.example/acme/billing#7", ref_kind: "issue" })).toBe(
      "https://codehub.example/acme/billing/-/issues/7",
    );
  });

  it("never guesses a host: no URL for a local project, an unknown project, or a non-item ref", () => {
    const at = (r: Partial<MemoryRow>) => toServedRecord({ ...row, ...r } as MemoryRow, verify, ctx).ref_url;
    expect(at({ code_project_id: "p3", ref: "#12", ref_kind: "issue" })).toBeNull();
    expect(at({ code_project_id: "unknown", ref: "#12", ref_kind: "issue" })).toBeNull();
    expect(at({ ref: "acme/codehub#12", ref_kind: null })).toBeNull();
    expect(at({ ref: "abc1234", ref_kind: "commit" })).toBeNull();
    expect(at({ ref: null, ref_kind: "issue" })).toBeNull();
  });
});
