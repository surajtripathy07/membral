import { makeMemoryFakeSupabase as makeFakeSupabase, type Row } from "@membral/test-kit";
import { describe, expect, it } from "vitest";
import {
  CROSS_SESSION_DUP_COSINE_THRESHOLD,
  dropCrossSessionDuplicates,
  type InsertableRecord,
  isMemoryExtractionLockHeld,
  MEMORY_EXTRACTION_LOCK_STALE_MS,
  releaseMemoryExtractionLock,
  retireExtractorRowsForSession,
  retireRowsByIds,
  setMemoryExtractionLock,
  supersedeRecords,
  updateSessionMemoryProps,
} from "@/lib/memory/write";

describe("retireExtractorRowsForSession", () => {
  it("retires (never deletes) every live extractor row for the session, leaving other sessions/sources/users alone", async () => {
    const rows: Row[] = [
      { id: "a", user_id: "u1", code_session_id: "s1", source: "extractor", retired_at: null },
      { id: "b", user_id: "u1", code_session_id: "s1", source: "extractor", retired_at: null },
      // a different source on the same session — must survive untouched
      { id: "c", user_id: "u1", code_session_id: "s1", source: "hook", retired_at: null },
      // a different session — must survive untouched
      { id: "d", user_id: "u1", code_session_id: "s2", source: "extractor", retired_at: null },
      // a different user, same session id (shouldn't happen in practice, but the filter must still hold) — must survive untouched
      { id: "e", user_id: "u2", code_session_id: "s1", source: "extractor", retired_at: null },
      // already retired — must not be re-touched / re-counted
      { id: "f", user_id: "u1", code_session_id: "s1", source: "extractor", retired_at: "2026-01-01T00:00:00Z" },
    ];
    const supabase = makeFakeSupabase({ session_memories: rows });

    const { retiredIds, retiredAt } = await retireExtractorRowsForSession(supabase, "u1", "s1");

    expect(new Set(retiredIds)).toEqual(new Set(["a", "b"]));
    expect(retiredAt).toBeTruthy();

    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId.a.retired_at).toBe(retiredAt);
    expect(byId.b.retired_at).toBe(retiredAt);
    expect(byId.c.retired_at).toBeNull(); // different source, untouched
    expect(byId.d.retired_at).toBeNull(); // different session, untouched
    expect(byId.e.retired_at).toBeNull(); // different user, untouched
    expect(byId.f.retired_at).toBe("2026-01-01T00:00:00Z"); // already retired, untouched
  });

  it("returns an empty list when the session has no live extractor rows", async () => {
    const supabase = makeFakeSupabase({ session_memories: [] });
    const { retiredIds } = await retireExtractorRowsForSession(supabase, "u1", "s1");
    expect(retiredIds).toEqual([]);
  });
});

describe("retireRowsByIds (step2d finding 7)", () => {
  it("retires exactly the given ids, leaving other rows (even other live extractor rows on the same session) untouched", async () => {
    const rows: Row[] = [
      { id: "old-1", user_id: "u1", code_session_id: "s1", source: "extractor", retired_at: null },
      { id: "old-2", user_id: "u1", code_session_id: "s1", source: "extractor", retired_at: null },
      // a NEWLY-inserted row, same session/source — must survive untouched
      // even though retireExtractorRowsForSession (the blanket version)
      // would have swept it up too.
      { id: "new-1", user_id: "u1", code_session_id: "s1", source: "extractor", retired_at: null },
      // a different user with the same id coincidence — must survive untouched
      { id: "old-1-other-user", user_id: "u2", code_session_id: "s1", source: "extractor", retired_at: null },
    ];
    const supabase = makeFakeSupabase({ session_memories: rows });

    const { retiredIds, retiredAt } = await retireRowsByIds(supabase, "u1", ["old-1", "old-2"]);

    expect(new Set(retiredIds)).toEqual(new Set(["old-1", "old-2"]));
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId["old-1"].retired_at).toBe(retiredAt);
    expect(byId["old-2"].retired_at).toBe(retiredAt);
    expect(byId["new-1"].retired_at).toBeNull();
    expect(byId["old-1-other-user"].retired_at).toBeNull();
  });

  it("is a no-op (no rows touched, no error) for an empty id list", async () => {
    const supabase = makeFakeSupabase({ session_memories: [] });
    const { retiredIds } = await retireRowsByIds(supabase, "u1", []);
    expect(retiredIds).toEqual([]);
  });
});

describe("supersedeRecords (step2d findings 8, 13; step2e finding 4)", () => {
  it("scopes the supersede update by user_id (finding 13) — a row id collision under a different user is never mutated", async () => {
    const liveRow = {
      id: "live-1",
      user_id: "u1",
      code_project_id: "p1",
      kind: "decision",
      text: "Switched retry backoff to exponential",
      retired_at: null,
      embedding: "[1,0,0]",
      supersedes: null,
      created_at: "2026-01-01T00:00:00Z",
    };
    // Same id as the record we're about to supersede-link, but a DIFFERENT
    // user — must never be the one that gets `supersedes` set.
    const wrongUserRow = { id: "new-1", user_id: "u2", supersedes: null };
    const rightUserRow = { id: "new-1", user_id: "u1", supersedes: null };
    const supabase = makeFakeSupabase({ session_memories: [liveRow, wrongUserRow, rightUserRow] });

    const linked = await supersedeRecords(supabase, "u1", "p1", [
      { id: "new-1", kind: "decision", text: "A different phrasing entirely", embedding: [1, 0, 0] },
    ]);

    expect(linked).toBe(1);
    expect(wrongUserRow.supersedes).toBeNull(); // never touched — different user_id
    expect(rightUserRow.supersedes).toBe("live-1"); // the correctly-scoped row got linked
  });

  it("skips a record with a null embedding (finding 8: a failed embed batch) when no text duplicate exists either — no crash, nothing linked", async () => {
    const supabase = makeFakeSupabase({ session_memories: [] });
    const linked = await supersedeRecords(supabase, "u1", "p1", [
      { id: "new-1", kind: "decision", text: "Switched retry backoff to exponential", embedding: null },
    ]);
    expect(linked).toBe(0);
  });

  it("retires (not just links) an EXACT cross-session text duplicate — never three live twins (finding 4)", async () => {
    const olderDup = {
      id: "old-dup",
      user_id: "u1",
      code_project_id: "p1",
      kind: "blocker",
      text: "Missing SUPABASE_SERVICE_ROLE_KEY blocks the migration.",
      retired_at: null,
      embedding: null,
      supersedes: null,
      created_at: "2026-01-01T00:00:00Z",
    };
    const newRow = { id: "new-1", user_id: "u1", supersedes: null };
    const supabase = makeFakeSupabase({ session_memories: [olderDup, newRow] });

    const linked = await supersedeRecords(supabase, "u1", "p1", [
      // Same text modulo case/whitespace — a fresh extraction from a
      // DIFFERENT session hallucinating the same generic blocker text.
      {
        id: "new-1",
        kind: "blocker",
        text: "missing SUPABASE_SERVICE_ROLE_KEY  blocks the migration.",
        embedding: null,
      },
    ]);

    expect(linked).toBe(1);
    expect(newRow.supersedes).toBe("old-dup");
    expect(olderDup.retired_at).not.toBeNull(); // retired outright, not just linked
  });

  it("links (never retires) a cosine-similar paraphrase that is not an exact text duplicate", async () => {
    const olderRow = {
      id: "old-1",
      user_id: "u1",
      code_project_id: "p1",
      kind: "learning",
      text: "Running turbo build while the dev server is up corrupts the shared .next cache.",
      retired_at: null,
      embedding: "[1,0,0]",
      supersedes: null,
      created_at: "2026-01-01T00:00:00Z",
    };
    const newRow = { id: "new-1", user_id: "u1", supersedes: null };
    const supabase = makeFakeSupabase({ session_memories: [olderRow, newRow] });

    const linked = await supersedeRecords(supabase, "u1", "p1", [
      { id: "new-1", kind: "learning", text: "A different phrasing of the same gotcha", embedding: [0.999, 0.001, 0] },
    ]);

    expect(linked).toBe(1);
    expect(newRow.supersedes).toBe("old-1");
    expect(olderRow.retired_at).toBeNull(); // linked only — a paraphrase stays live
  });
});

describe("#174: dedupe and supersede read every live row of the scope, not the newest 500 or one page", () => {
  // 1,200 live rows of one (user, project, kind) scope — past selectAllRows' PAGE_SIZE of 1,000, so the read
  // must page. row-0000 is the oldest. The memory-flavour fake keeps only the LAST .order() call (id DESC here);
  // zero-padded ids keep id order equal to created_at order, so the fake sorts as Postgres would.
  const scope = (kind: string, oldest: Record<string, unknown>) =>
    Array.from({ length: 1200 }, (_, i) => ({
      id: `row-${String(i).padStart(4, "0")}`,
      user_id: "u1",
      code_project_id: "p1",
      code_session_id: "sess-old",
      kind,
      text: `unrelated fact number ${i}`,
      embedding: "[0,1]",
      retired_at: null,
      supersedes: null,
      created_at: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(),
      ...(i === 0 ? oldest : {}),
    }));

  it("dropCrossSessionDuplicates finds a duplicate whose only match is the oldest of 1,200 live rows", async () => {
    const supabase = makeFakeSupabase({
      session_memories: scope("learning", { text: "The staging bucket needs a region pin." }),
    });
    const { kept, deduped } = await dropCrossSessionDuplicates(supabase, "u1", "p1", "sess-new", [
      {
        kind: "learning",
        text: "the staging bucket needs a region pin.",
        verified: true,
        embedding: null,
        contentHash: "h",
      } as InsertableRecord,
    ]);
    expect(deduped).toBe(1);
    expect(kept).toHaveLength(0);
  });

  it("supersedeRecords links a new record whose only match is the oldest of 1,200 live rows", async () => {
    const rows: Row[] = scope("decision", { embedding: "[1,0]" });
    const newRow = { id: "new-1", user_id: "u1", supersedes: null };
    const supabase = makeFakeSupabase({ session_memories: [...rows, newRow] });
    const linked = await supersedeRecords(supabase, "u1", "p1", [
      { id: "new-1", kind: "decision", text: "A fresh phrasing", embedding: [1, 0] },
    ]);
    expect(linked).toBe(1);
    expect(newRow.supersedes).toBe("row-0000");
  });
});

describe("memory extraction lease lock (step2d finding 3)", () => {
  it("isMemoryExtractionLockHeld: false with no lock, true with a fresh lock, false once stale", () => {
    expect(isMemoryExtractionLockHeld({})).toBe(false);

    const now = Date.parse("2026-01-01T00:00:00Z");
    const fresh = { memory_extraction_lock: { at: new Date(now).toISOString(), run_id: "r1" } };
    expect(isMemoryExtractionLockHeld(fresh, now)).toBe(true);
    expect(isMemoryExtractionLockHeld(fresh, now + MEMORY_EXTRACTION_LOCK_STALE_MS)).toBe(true); // exactly at the boundary, inclusive
    expect(isMemoryExtractionLockHeld(fresh, now + MEMORY_EXTRACTION_LOCK_STALE_MS + 1)).toBe(false); // one ms past — stale
  });

  it("isMemoryExtractionLockHeld never throws on a malformed lock shape — fails open (not held)", () => {
    expect(isMemoryExtractionLockHeld({ memory_extraction_lock: "not an object" })).toBe(false);
    expect(isMemoryExtractionLockHeld({ memory_extraction_lock: { at: "not a date", run_id: "r1" } })).toBe(false);
    expect(isMemoryExtractionLockHeld({ memory_extraction_lock: {} })).toBe(false);
  });

  it("setMemoryExtractionLock writes the lock into props, scoped by user_id", async () => {
    const rows: Row[] = [{ id: "s1", user_id: "u1", props: { existing: "kept" } }];
    const supabase = makeFakeSupabase({ code_sessions: rows });
    const newProps = await setMemoryExtractionLock(supabase, "u1", "s1", { existing: "kept" }, "run-1");
    expect(newProps.existing).toBe("kept"); // untouched fields survive
    expect((newProps.memory_extraction_lock as { run_id: string }).run_id).toBe("run-1");
    expect(rows[0].props.memory_extraction_lock.run_id).toBe("run-1");
  });

  it("updateSessionMemoryProps always clears memory_extraction_lock, whatever it was", async () => {
    const rows: Row[] = [
      { id: "s1", user_id: "u1", props: { memory_extraction_lock: { at: "x", run_id: "stale-run" } } },
    ];
    const supabase = makeFakeSupabase({ code_sessions: rows });
    await updateSessionMemoryProps(
      supabase,
      "u1",
      "s1",
      rows[0].props,
      {
        windows_total: 0,
        windows_extracted: 0,
        tail_turns_extracted: 0,
        budget_hit: false,
        records: 0,
        prompt_version: "v1",
        run_id: "run-1",
        at: "2026-01-01T00:00:00Z",
        windows_dropped_user_prose: 0,
        dropped_pii: 0,
      },
      5,
    );
    expect(rows[0].props.memory_extraction_lock).toBeUndefined();
    expect(rows[0].props.memory_checkpoint_turn_idx).toBe(5);
  });
});

describe("dropCrossSessionDuplicates (recall echo, 2026-09-25)", () => {
  const live = (over: Record<string, unknown>) => ({
    user_id: "u1",
    code_project_id: "p1",
    code_session_id: "sess-old",
    kind: "learning",
    retired_at: null,
    created_at: "2026-01-01T00:00:00Z",
    ...over,
  });
  const candidate = (over: Partial<InsertableRecord>) =>
    ({ kind: "learning", text: "x", verified: true, embedding: null, contentHash: "h", ...over }) as InsertableRecord;
  // Unit vectors at a chosen cosine to [1, 0].
  const at = (cos: number) => [cos, Math.sqrt(1 - cos * cos)];

  it("drops a record restating a live record from another session (text or cosine >= threshold); keeps the rest", async () => {
    const supabase = makeFakeSupabase({
      session_memories: [
        live({ id: "old-text", text: "`pnpm build` fails with NODE_ENV undefined.", embedding: "[0,1]" }),
        live({ id: "old-vec", text: "Something phrased differently", embedding: "[1,0]" }),
      ],
    });
    const records = [
      candidate({ text: "`PNPM build`  fails with NODE_ENV undefined.", embedding: [0.2, 0.3], contentHash: "a" }),
      candidate({ text: "echo of the preamble", embedding: at(0.981), contentHash: "b" }),
      candidate({ text: "a different fact", embedding: at(0.931), contentHash: "c" }),
      candidate({ text: "retired-bound twin", embedding: at(0.99), verified: false, contentHash: "d" }),
    ];
    const { kept, deduped } = await dropCrossSessionDuplicates(supabase, "u1", "p1", "sess-new", records);
    expect(deduped).toBe(2);
    expect(kept.map((r) => r.contentHash)).toEqual(["c", "d"]);
    expect(CROSS_SESSION_DUP_COSINE_THRESHOLD).toBeGreaterThan(0.931);
  });

  it("ignores the same session's own rows, other kinds, other projects and retired rows", async () => {
    const supabase = makeFakeSupabase({
      session_memories: [
        live({ id: "same-session", code_session_id: "sess-new", text: "t", embedding: "[1,0]" }),
        live({ id: "other-kind", kind: "decision", text: "t", embedding: "[1,0]" }),
        live({ id: "other-project", code_project_id: "p2", text: "t", embedding: "[1,0]" }),
        live({ id: "retired", retired_at: "2026-01-02T00:00:00Z", text: "t", embedding: "[1,0]" }),
      ],
    });
    const { kept, deduped } = await dropCrossSessionDuplicates(supabase, "u1", "p1", "sess-new", [
      candidate({ text: "t", embedding: [1, 0] }),
    ]);
    expect(deduped).toBe(0);
    expect(kept).toHaveLength(1);
  });
});

describe("migration 109: memory props writes never revert a concurrent import", () => {
  it("an import writing usage between the run's read and its final write survives", async () => {
    const rows: Row[] = [{ id: "s1", user_id: "u1", props: { usage: { invocation: "t2" } } }];
    const supabase = makeFakeSupabase({ code_sessions: rows });
    const snapshot = { ...rows[0].props };
    const locked = await setMemoryExtractionLock(supabase, "u1", "s1", snapshot, "run-1");
    rows[0].props = { ...rows[0].props, usage: { invocation: "t3" } }; // the import lands mid-run
    await updateSessionMemoryProps(
      supabase,
      "u1",
      "s1",
      locked,
      {
        windows_total: 0,
        windows_extracted: 0,
        tail_turns_extracted: 0,
        budget_hit: false,
        records: 0,
        prompt_version: "v1",
        run_id: "run-1",
        at: "2026-01-01T00:00:00Z",
        windows_dropped_user_prose: 0,
        dropped_pii: 0,
      },
      4,
    );
    expect(rows[0].props.usage).toEqual({ invocation: "t3" });
    expect(rows[0].props.memory_checkpoint_turn_idx).toBe(4);
    expect(rows[0].props.memory_extraction_lock).toBeUndefined();
  });
});

describe("D-053 review: the lease lock is released compare-and-delete; write-back carries only changed keys", () => {
  const extraction = {
    windows_total: 0,
    windows_extracted: 0,
    tail_turns_extracted: 0,
    budget_hit: false,
    records: 0,
    prompt_version: "v1",
    run_id: "run-1",
    at: "2026-01-01T00:00:00Z",
    windows_dropped_user_prose: 0,
    dropped_pii: 0,
  };

  it("releaseMemoryExtractionLock removes the lock only while it is this run's", async () => {
    const rows: Row[] = [{ id: "s1", user_id: "u1", props: { memory_extraction_lock: { at: "x", run_id: "run-2" } } }];
    const supabase = makeFakeSupabase({ code_sessions: rows });
    expect(await releaseMemoryExtractionLock(supabase, "u1", "s1", "run-1")).toBe(false);
    expect(rows[0].props.memory_extraction_lock.run_id).toBe("run-2"); // another run's lease survives
    expect(await releaseMemoryExtractionLock(supabase, "u1", "s1", "run-2")).toBe(true);
    expect(rows[0].props.memory_extraction_lock).toBeUndefined();
  });

  it("with runId: the final write lands, and another run's lock taken over mid-run is kept", async () => {
    const rows: Row[] = [{ id: "s1", user_id: "u1", props: {} }];
    const supabase = makeFakeSupabase({ code_sessions: rows });
    const locked = await setMemoryExtractionLock(supabase, "u1", "s1", {}, "run-1");
    rows[0].props = { ...rows[0].props, memory_extraction_lock: { at: "later", run_id: "run-2" } };
    await updateSessionMemoryProps(supabase, "u1", "s1", locked, extraction, 4, { runId: "run-1" });
    expect(rows[0].props.memory_checkpoint_turn_idx).toBe(4);
    expect(rows[0].props.memory_extraction_lock.run_id).toBe("run-2");
  });

  it("with baseProps: an unchanged memory_* key never reverts a concurrent write; a changed one is written", async () => {
    const base = { memory_user_pass_failures: { "0-9": 1 }, memory_other: "old" };
    const rows: Row[] = [{ id: "s1", user_id: "u1", props: { ...base } }];
    const supabase = makeFakeSupabase({ code_sessions: rows });
    rows[0].props = { ...rows[0].props, memory_other: "newer" }; // another writer, mid-run
    const current = { ...base, memory_user_pass_failures: { "0-9": 2 } };
    await updateSessionMemoryProps(supabase, "u1", "s1", current, extraction, 4, { baseProps: base, runId: "run-1" });
    expect(rows[0].props.memory_other).toBe("newer");
    expect(rows[0].props.memory_user_pass_failures).toEqual({ "0-9": 2 });
  });

  it("the props patch is a no-op for a non-object p_set (migration 109 guard, mirrored by the fake)", async () => {
    const rows: Row[] = [{ id: "s1", user_id: "u1", props: { keep: 1 } }];
    const supabase = makeFakeSupabase({ code_sessions: rows });
    const { data } = await supabase.rpc("code_session_props_patch", {
      p_user_id: "u1",
      p_session_id: "s1",
      p_set: [1, 2],
      p_remove: [],
      p_expect: null,
    });
    expect(data).toBe(false);
    expect(rows[0].props).toEqual({ keep: 1 });
  });
});
