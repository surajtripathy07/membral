// Unit tests for the MCP-only compact serialization (F-022/F-023/F-017,
// docs/FEEDBACK.md) and the batched session_refs lookup. Mirrors the
// recording-chain fake-db style in lib/memory/__tests__/queries.test.ts
// (this module's chain is select/eq/in/order; `.eq` is recorded so a test
// can prove the query is scoped to the authenticated user).
import { describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/types";
import type { ServedRecord } from "@/lib/memory/verify";
import { compactServedRecord, compactServedRecords, fetchSessionRefs } from "../served-record-view";

function baseRecord(overrides: Partial<ServedRecord> = {}): ServedRecord {
  return {
    id: "mem-1",
    kind: "decision",
    source: "hook",
    text: "chose postgres",
    quote: "chose postgres because it fit",
    ref: "https://github.com/acme/repo/pull/1",
    session_id: "sess-1",
    agent_id: null,
    turn_idx: 3,
    turn_role: "assistant",
    repo: "acme/repo",
    branch: "main",
    merged_at: null,
    when: "2026-09-20T00:00:00Z",
    durable: true,
    verified: true,
    confidence: 1,
    chat_precontext: null,
    ...overrides,
  };
}

describe("compactServedRecord", () => {
  it("#436: a blocker carries its age after `when`; other kinds carry none", () => {
    const now = Date.parse("2026-09-23T00:00:00Z");
    const blocker = compactServedRecord(baseRecord({ kind: "blocker" }), undefined, undefined, now);
    expect(blocker.age).toBe("3d ago");
    const keys = Object.keys(blocker);
    expect(keys.indexOf("age")).toBe(keys.indexOf("when") + 1);
    expect(compactServedRecord(baseRecord(), undefined, undefined, now).age).toBeUndefined();
  });

  it("omits null/empty-string/empty-array fields, and drops verified:true / confidence:1 (the defaults)", () => {
    const record = baseRecord({
      source: null as unknown as ServedRecord["source"],
      quote: "",
      ref: null,
      agent_id: null,
      branch: "",
      merged_at: null,
      chat_precontext: null,
      // paths-shaped empty array isn't a ServedRecord field; nothing else is array-typed here.
    });
    const out = compactServedRecord(record);
    expect(out).not.toHaveProperty("source");
    expect(out).not.toHaveProperty("quote");
    expect(out).not.toHaveProperty("ref");
    expect(out).not.toHaveProperty("agent_id");
    expect(out).not.toHaveProperty("branch");
    expect(out).not.toHaveProperty("merged_at");
    expect(out).not.toHaveProperty("chat_precontext");
    expect(out).not.toHaveProperty("verified");
    expect(out).not.toHaveProperty("confidence");
  });

  it("keeps verified:false and a non-default confidence", () => {
    const out = compactServedRecord(baseRecord({ verified: false, confidence: 0.7 }));
    expect(out.verified).toBe(false);
    expect(out.confidence).toBe(0.7);
  });

  it("orders `quote` before `text` in the serialized keys", () => {
    const out = compactServedRecord(baseRecord());
    const keys = Object.keys(out);
    expect(keys.indexOf("quote")).toBeGreaterThanOrEqual(0);
    expect(keys.indexOf("quote")).toBeLessThan(keys.indexOf("text"));
  });

  it("preserves id/kind/when/ref/session_id/turn_idx unchanged", () => {
    const record = baseRecord();
    const out = compactServedRecord(record);
    expect(out.id).toBe(record.id);
    expect(out.kind).toBe(record.kind);
    expect(out.when).toBe(record.when);
    expect(out.ref).toBe(record.ref);
    expect(out.session_id).toBe(record.session_id);
    expect(out.turn_idx).toBe(record.turn_idx);
  });
});

/** A recording chain (queries.test.ts's pattern): `.select`/`.eq`/`.in` log and
 * return the chain; `.order` records its call and, once both orders have
 * landed (`created_at` then `id`, per fetchSessionRefs), resolves. Counts
 * `.from` calls and records every `.eq`/`.order` call. `error` lets a test
 * simulate a query error (e.g. a missing column) instead of data. */
function recordingDb(
  data: unknown[],
  error: { message: string } | null = null,
): { db: Db; fromCalls: string[]; eqCalls: [string, unknown][]; orderCalls: [string, unknown][] } {
  const fromCalls: string[] = [];
  const eqCalls: [string, unknown][] = [];
  const orderCalls: [string, unknown][] = [];
  const chain: Record<string, unknown> = {};
  chain.select = (...args: unknown[]) => chain;
  chain.eq = (column: string, value: unknown) => {
    eqCalls.push([column, value]);
    return chain;
  };
  chain.in = (...args: unknown[]) => chain;
  chain.order = (column: string, opts: unknown) => {
    orderCalls.push([column, opts]);
    if (orderCalls.length < 2) return chain;
    return Promise.resolve(error ? { data: null, error } : { data, error: null });
  };
  const from = vi.fn((table: string) => {
    fromCalls.push(table);
    return chain;
  });
  return { db: { from } as unknown as Db, fromCalls, eqCalls, orderCalls };
}

/** A `.from()` that throws synchronously -- the "thrown, not just a query error" case. */
function throwingDb(message: string): Db {
  return {
    from: vi.fn(() => {
      throw new Error(message);
    }),
  } as unknown as Db;
}

const USER_ID = "user-1";

describe("fetchSessionRefs / compactServedRecords", () => {
  it("issues exactly ONE code_session_issues query, scoped to the caller's user_id, for records that share session ids", async () => {
    const { db, fromCalls, eqCalls } = recordingDb([]);
    const records = [
      baseRecord({ id: "a", session_id: "sess-1" }),
      baseRecord({ id: "b", session_id: "sess-1" }),
      baseRecord({ id: "c", session_id: "sess-2" }),
    ];
    await compactServedRecords(db, records, USER_ID);
    // W3 D10: plus ONE session_memories read for the records' ref labels (ref_title/ref_issue).
    expect(fromCalls).toEqual(["code_session_issues", "session_memories"]);
    expect(eqCalls).toContainEqual(["user_id", USER_ID]);
  });

  it("orders by created_at desc, then id desc, for a deterministic tie-break", async () => {
    const { db, orderCalls } = recordingDb([]);
    await fetchSessionRefs(db, ["sess-1"], USER_ID);
    expect(orderCalls).toEqual([
      ["created_at", { ascending: false }],
      ["id", { ascending: false }],
    ]);
  });

  it("excludes a model_segment row and includes a source:null row", async () => {
    const { db } = recordingDb([
      { session_id: "sess-1", ref: "ref-model", source: "model_segment", tier: null },
      { session_id: "sess-1", ref: "ref-observed", source: null, tier: null },
    ]);
    const refs = await fetchSessionRefs(db, ["sess-1"], USER_ID);
    expect(refs.get("sess-1")).toEqual(["ref-observed"]);
  });

  it("excludes inferred and discussed tiers, keeps a null-tier row", async () => {
    const { db } = recordingDb([
      { session_id: "sess-1", ref: "ref-inferred", source: null, tier: "inferred" },
      { session_id: "sess-1", ref: "ref-discussed", source: null, tier: "discussed" },
      { session_id: "sess-1", ref: "ref-inferred-ref", source: null, tier: "inferred_ref" },
      { session_id: "sess-1", ref: "ref-null-tier", source: null, tier: null },
      { session_id: "sess-1", ref: "ref-observed", source: null, tier: "observed" },
    ]);
    const refs = await fetchSessionRefs(db, ["sess-1"], USER_ID);
    expect(refs.get("sess-1")).toEqual(["ref-null-tier", "ref-observed"]);
  });

  it("caps at 5 refs per session, most-recent first (row order as returned)", async () => {
    const rows = Array.from({ length: 7 }, (_, i) => ({
      session_id: "sess-1",
      ref: `ref-${i}`,
      source: null,
      tier: null,
    }));
    const { db } = recordingDb(rows);
    const refs = await fetchSessionRefs(db, ["sess-1"], USER_ID);
    expect(refs.get("sess-1")).toEqual(["ref-0", "ref-1", "ref-2", "ref-3", "ref-4"]);
  });

  it("a record whose session has no refs gets no session_refs key", async () => {
    const { db } = recordingDb([]);
    const [out] = await compactServedRecords(db, [baseRecord({ id: "a", session_id: "sess-1" })], USER_ID);
    expect(out).not.toHaveProperty("session_refs");
  });

  it("attaches session_refs onto matching records only", async () => {
    const { db } = recordingDb([{ session_id: "sess-1", ref: "ref-x", source: null, tier: null }]);
    const [withRefs, withoutRefs] = await compactServedRecords(
      db,
      [baseRecord({ id: "a", session_id: "sess-1" }), baseRecord({ id: "b", session_id: "sess-2" })],
      USER_ID,
    );
    expect(withRefs.session_refs).toEqual(["ref-x"]);
    expect(withoutRefs).not.toHaveProperty("session_refs");
  });

  it("degrades to no session_refs (never throws) when the query errors, e.g. a missing column on old prod", async () => {
    const { db } = recordingDb([], { message: "column code_session_issues.source does not exist" });
    const refs = await fetchSessionRefs(db, ["sess-1"], USER_ID);
    expect(refs.size).toBe(0);
    const [out] = await compactServedRecords(db, [baseRecord({ id: "a", session_id: "sess-1" })], USER_ID);
    expect(out).not.toHaveProperty("session_refs");
  });

  it("degrades to no session_refs (never throws) when the query itself throws", async () => {
    const db = throwingDb("network error");
    const refs = await fetchSessionRefs(db, ["sess-1"], USER_ID);
    expect(refs.size).toBe(0);
  });
});

describe("ref_label / ref_issue (W3 D10, D-071)", () => {
  it("renders `#123 Title` from the record's ref and title (shared formatter with the preamble)", () => {
    const out = compactServedRecord(baseRecord({ repo: "acme/api", ref: "codehub.example/acme/api#123" }), undefined, {
      ref_title: "Login fails on Safari",
      ref_issue: null,
      ref_issue_basis: null,
    });
    expect(out.ref).toBe("codehub.example/acme/api#123");
    expect(out.ref_label).toBe("#123 Login fails on Safari");
    expect(out.ref_issue).toBeUndefined();
  });

  it("renders `#N` with no title, `!N` for a merge request, and a GitHub PR URL as #N", () => {
    const none = { ref_title: null, ref_issue: null, ref_issue_basis: null };
    expect(compactServedRecord(baseRecord({ repo: "acme/api", ref: "acme/api#7" }), undefined, none).ref_label).toBe(
      "#7",
    );
    expect(
      compactServedRecord(baseRecord({ repo: "acme/api", ref: "codehub.example/acme/api!14" }), undefined, none)
        .ref_label,
    ).toBe("!14");
    expect(compactServedRecord(baseRecord(), undefined, none).ref_label).toBe("#1");
    // A ref of another repo than the record's project keeps its repo.
    expect(compactServedRecord(baseRecord({ repo: "acme/api", ref: "acme/web#7" }), undefined, none).ref_label).toBe(
      "acme/web#7",
    );
  });

  it("truncates a long title at ~60 chars with an ellipsis", () => {
    const out = compactServedRecord(baseRecord({ repo: "acme/api", ref: "acme/api#9" }), undefined, {
      ref_title: "x".repeat(100),
      ref_issue: null,
      ref_issue_basis: null,
    });
    expect(out.ref_label).toBe(`#9 ${"x".repeat(59)}…`);
  });

  it("labels an MR's issue by basis: stated → 'for #12', inferred → 'probably for #12'", () => {
    const mr = baseRecord({ repo: "acme/api", ref: "codehub.example/acme/api!14" });
    const stated = compactServedRecord(mr, undefined, { ref_title: null, ref_issue: "#12", ref_issue_basis: "stated" });
    const inferred = compactServedRecord(mr, undefined, {
      ref_title: "Fix totals",
      ref_issue: "codehub.example/acme/api#12",
      ref_issue_basis: "inferred",
    });
    expect(stated.ref_issue).toBe("for #12");
    expect(inferred.ref_label).toBe("!14 Fix totals");
    expect(inferred.ref_issue).toBe("probably for #12");
    // An issue with no basis is never shown as a link.
    expect(
      compactServedRecord(mr, undefined, { ref_title: null, ref_issue: "#12", ref_issue_basis: null }).ref_issue,
    ).toBe(undefined);
  });

  it("adds no label to a record without a ref", () => {
    const out = compactServedRecord(baseRecord({ repo: "acme/api", ref: null }), undefined, {
      ref_title: "t",
      ref_issue: null,
      ref_issue_basis: null,
    });
    expect(out.ref_label).toBeUndefined();
  });
});

describe("source links (sha, paths, ref_url)", () => {
  it("emits sha, paths and ref_url only when present", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const out = compactServedRecord(
      baseRecord({
        ref: "#12",
        ref_url: "https://github.com/acme/codehub/issues/12",
        sha,
        paths: ["src/a.ts", "src/b.ts"],
      }),
    );
    expect(out.ref_url).toBe("https://github.com/acme/codehub/issues/12");
    expect(out.sha).toBe(sha);
    expect(out.paths).toEqual(["src/a.ts", "src/b.ts"]);
    expect(out.session_id).toBe("sess-1");
    const bare = compactServedRecord(baseRecord({ ref: "#12", ref_url: null, sha: null, paths: [] }));
    expect(bare).not.toHaveProperty("ref_url");
    expect(bare).not.toHaveProperty("sha");
    expect(bare).not.toHaveProperty("paths");
    expect(compactServedRecord(baseRecord())).not.toHaveProperty("sha");
  });
});
