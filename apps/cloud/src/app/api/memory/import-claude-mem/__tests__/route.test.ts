import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetUser = vi.fn();
vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({ auth: { getUser: mockGetUser } })),
}));
const mockValidateApiKey = vi.fn();
vi.mock("@/lib/api-keys", () => ({
  validateApiKey: (...args: unknown[]) => mockValidateApiKey(...args),
}));
const mockEnforceRateLimit = vi.fn();
vi.mock("@/lib/rate-limit", async () => {
  const actual = await vi.importActual<typeof import("@/lib/rate-limit")>("@/lib/rate-limit");
  return { ...actual, enforceRateLimit: (...args: unknown[]) => mockEnforceRateLimit(...args) };
});

// A small in-memory fake of the three tables the route touches. It APPLIES eq / in / not-null filters, order and
// range (with a 1000-row response cap like PostgREST), so user scoping, the source pin and paging are exercised for
// real. `memories` plays the unique (user, session, hash) constraint.
type R = Record<string, unknown>;
interface Call {
  table: string;
  eq: Record<string, unknown>;
}
const calls: Call[] = [];
let sessionRows: R[] = [];
let turnRows: R[] = [];
const stored = new Map<string, R>();
let upsertError: { message: string } | null = null;
const DB_MAX_ROWS = 1000;

function builder(table: string) {
  const call: Call = { table, eq: {} };
  calls.push(call);
  const eqs: [string, unknown][] = [];
  const ins: [string, unknown[]][] = [];
  let notNull: string | null = null;
  const nulls: string[] = [];
  let orderBy: string | null = null;
  let orderAsc = true;
  let range: [number, number] | null = null;
  let patch: R | null = null;
  let upsertRows: R[] | null = null;
  const source = (): R[] =>
    table === "code_sessions" ? sessionRows : table === "code_session_turns" ? turnRows : [...stored.values()];
  const run = () => {
    if (upsertRows) {
      if (upsertError) return { data: null, error: upsertError };
      const fresh: R[] = [];
      for (const r of upsertRows) {
        const key = `${r.user_id}:${r.code_session_id}:${r.content_hash}`;
        if (!stored.has(key)) {
          stored.set(key, { id: key, ...r });
          fresh.push({ code_session_id: r.code_session_id, content_hash: r.content_hash });
        }
      }
      return { data: fresh, error: null };
    }
    let rows = source().filter(
      (r) =>
        eqs.every(([k, v]) => r[k] === v) &&
        ins.every(([k, vs]) => vs.includes(r[k])) &&
        nulls.every((k) => r[k] == null) &&
        (notNull === null || r[notNull] != null),
    );
    if (patch) {
      for (const r of rows) Object.assign(r, patch);
      return { data: rows.map((r) => ({ id: r.id })), error: null };
    }
    if (orderBy) {
      const k = orderBy;
      const dir = orderAsc ? 1 : -1;
      rows = [...rows].sort(
        (x, y) => dir * ((x[k] as number) - (y[k] as number) || String(x[k]).localeCompare(String(y[k]))),
      );
    }
    const [from, to] = range ?? [0, DB_MAX_ROWS - 1];
    return { data: rows.slice(from, Math.min(to + 1, from + DB_MAX_ROWS)), error: null };
  };
  const b: Record<string, unknown> = {};
  b.select = () => b;
  b.eq = (k: string, v: unknown) => {
    call.eq[k] = v;
    eqs.push([k, v]);
    return b;
  };
  b.in = (k: string, v: unknown[]) => {
    ins.push([k, v]);
    return b;
  };
  b.is = (k: string) => {
    call.eq[`${k}__is_null`] = true;
    nulls.push(k);
    return b;
  };
  b.not = (k: string) => {
    notNull = k;
    return b;
  };
  b.order = (k: string, opts?: { ascending?: boolean }) => {
    orderBy = k;
    orderAsc = opts?.ascending !== false;
    return b;
  };
  b.range = (from: number, to: number) => {
    range = [from, to];
    return b;
  };
  b.update = (p: R) => {
    patch = p;
    return b;
  };
  b.upsert = (rows: R[]) => {
    call.eq.__upsert = rows;
    upsertRows = rows;
    return b;
  };
  // biome-ignore lint/suspicious/noThenProperty: the real query builder is awaitable
  b.then = (resolve: (v: unknown) => void) => resolve(run());
  return b;
}
vi.mock("@/lib/code-sessions/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/code-sessions/auth")>("@/lib/code-sessions/auth");
  return { ...actual, getCodeSessionsServiceClient: () => ({ from: (t: string) => builder(t) }) };
});

process.env.NEXT_PUBLIC_SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";

import { POST } from "../route";

const NARRATIVE = "The retry queue drops jobs when the worker restarts before the ack is written.";
const okKey = { valid: true, userId: "user-1", scopeNodeId: null, scopeCodeProjectId: null };
const obs = (over: Record<string, unknown> = {}) => ({
  contentSessionId: "cs-1",
  type: "bugfix",
  title: "Retry queue loses jobs",
  narrative: NARRATIVE,
  body: null,
  promptNumber: 1,
  createdAt: null,
  ...over,
});
const turn = (idx: number, role: string, text: string, over: R = {}): R => ({
  user_id: "user-1",
  session_id: "sess-1",
  kind: "prose",
  idx,
  role,
  text,
  props: null,
  ...over,
});
function post(body: unknown, token?: string): NextRequest {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  return new NextRequest("http://localhost:3000/api/memory/import-claude-mem", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /api/memory/import-claude-mem", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    calls.length = 0;
    stored.clear();
    upsertError = null;
    mockEnforceRateLimit.mockResolvedValue({ allowed: true });
    mockValidateApiKey.mockResolvedValue(okKey);
    sessionRows = [
      {
        id: "sess-1",
        user_id: "user-1",
        source: "claude-code",
        code_project_id: "proj-1",
        source_session_id: "cs-1",
        short_title: "Queue",
        title: null,
        parent_source_session_id: null,
      },
    ];
    turnRows = [turn(0, "user", "fix the queue"), turn(3, "assistant", `Found it. ${NARRATIVE}`)];
  });

  it("401s without a bearer and touches nothing", async () => {
    const res = await POST(post({ observations: [obs()] }));
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("403s a scoped key", async () => {
    mockValidateApiKey.mockResolvedValueOnce({ ...okKey, scopeNodeId: "n1" });
    const res = await POST(post({ observations: [obs()] }, "lls_scoped"));
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it("400s invalid JSON and schema violations", async () => {
    expect((await POST(post("{nope", "lls_ok"))).status).toBe(400);
    expect((await POST(post({ observations: [] }, "lls_ok"))).status).toBe(400);
    expect((await POST(post({ observations: [{ type: "x" }] }, "lls_ok"))).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("inserts a quoted record for an exact match, scoped to the key's user", async () => {
    const res = await POST(post({ observations: [obs()] }, "lls_ok"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ received: 1, inserted: 1, duplicates: 0, unmatched: 0, requoted: 1 });
    for (const c of calls.filter((c) => c.table !== "session_memories")) expect(c.eq.user_id).toBe("user-1");
    const row = [...stored.values()][0];
    expect(row).toMatchObject({
      user_id: "user-1",
      code_session_id: "sess-1",
      source: "claude-mem",
      quote: NARRATIVE,
      turn_idx: 3,
      verified: true,
    });
  });

  it("leaves quote null when the text is not in the transcript", async () => {
    const res = await POST(
      post({ observations: [obs({ narrative: "A summary phrased differently from anything said." })] }, "lls_ok"),
    );
    expect(await res.json()).toMatchObject({ inserted: 1, requoted: 0 });
    expect([...stored.values()][0]).toMatchObject({ quote: null, verified: false, turn_idx: 0 });
  });

  it("is idempotent: a re-run inserts nothing new", async () => {
    const body = {
      observations: [obs(), obs({ type: "decision", title: "Ack first", narrative: "Write the ack before dequeue." })],
    };
    expect(await (await POST(post(body, "lls_ok"))).json()).toMatchObject({ inserted: 2, duplicates: 0 });
    expect(await (await POST(post(body, "lls_ok"))).json()).toMatchObject({ inserted: 0, duplicates: 2 });
    expect(stored.size).toBe(2);
  });

  it("skips observations without a matching Membral session and counts them", async () => {
    const res = await POST(post({ observations: [obs(), obs({ contentSessionId: "cs-unknown" })] }, "lls_ok"));
    expect(await res.json()).toMatchObject({ received: 2, inserted: 1, unmatched: 1 });
    expect(stored.size).toBe(1);
  });

  it("writes nothing when no session matches", async () => {
    sessionRows = [];
    const res = await POST(post({ observations: [obs()] }, "lls_ok"));
    expect(await res.json()).toMatchObject({ inserted: 0, unmatched: 1 });
    expect(calls.some((c) => c.table === "session_memories")).toBe(false);
  });

  it("does not match another user's session with the same contentSessionId", async () => {
    sessionRows = [{ ...(sessionRows[0] as R), id: "sess-x", user_id: "user-2" }];
    const res = await POST(post({ observations: [obs()] }, "lls_ok"));
    expect(await res.json()).toMatchObject({ inserted: 0, unmatched: 1 });
    expect(stored.size).toBe(0);
  });

  it("only matches claude-code sessions and picks deterministically when ids collide", async () => {
    sessionRows = [
      { ...(sessionRows[0] as R), id: "sess-z", source: "claude-code" },
      { ...(sessionRows[0] as R), id: "sess-b", source: "opencode" },
      { ...(sessionRows[0] as R), id: "sess-a", source: "claude-code" },
    ];
    turnRows = [];
    await POST(post({ observations: [obs()] }, "lls_ok"));
    expect([...stored.values()].map((r) => r.code_session_id)).toEqual(["sess-a"]);
    const sess = calls.find((c) => c.table === "code_sessions");
    expect(sess?.eq).toMatchObject({ user_id: "user-1", source: "claude-code" });
  });

  it("finds an anchor past the first 1000 turns (paged reads)", async () => {
    turnRows = [
      ...Array.from({ length: 1500 }, (_, i) => turn(i, i % 2 ? "assistant" : "user", `filler turn number ${i}`)),
      turn(1500, "assistant", `Found it. ${NARRATIVE}`),
    ];
    const res = await POST(post({ observations: [obs()] }, "lls_ok"));
    expect(await res.json()).toMatchObject({ inserted: 1, requoted: 1 });
    expect([...stored.values()][0]).toMatchObject({ quote: NARRATIVE, turn_idx: 1500, verified: true });
  });

  it("does not anchor in a non-owner user turn or a tool_result", async () => {
    turnRows = [
      turn(0, "user", "fix the queue"),
      turn(1, "user", `Summary of the session: ${NARRATIVE}`, { props: { nonOwner: true } }),
      turn(2, "user", NARRATIVE, { kind: "tool_result" }),
    ];
    const res = await POST(post({ observations: [obs()] }, "lls_ok"));
    expect(await res.json()).toMatchObject({ inserted: 1, requoted: 0 });
    expect([...stored.values()][0]).toMatchObject({ quote: null, verified: false });
  });

  it("truncates oversized fields instead of rejecting the batch, and redacts secrets", async () => {
    const fakeKey = `sk-${"Zq9Xw8Er".repeat(5)}`;
    const res = await POST(
      post(
        {
          observations: [
            obs({ title: "t".repeat(900), narrative: `${fakeKey} ${"n".repeat(9000)}` }),
            obs({ narrative: "A second distinct observation about the queue ack ordering." }),
          ],
        },
        "lls_ok",
      ),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ inserted: 2 });
    for (const r of stored.values()) {
      expect(String(r.text)).not.toContain(fakeKey);
      expect(String(r.text).length).toBeLessThanOrEqual(4000);
    }
  });

  it("counts requoted over rows actually inserted, not duplicates", async () => {
    await POST(post({ observations: [obs()] }, "lls_ok"));
    const res = await POST(post({ observations: [obs()] }, "lls_ok"));
    expect(await res.json()).toMatchObject({ inserted: 0, duplicates: 1, requoted: 0, upgraded: 0 });
  });

  it("reports skipped_grounding for unquoted rows when older turns were not scanned", async () => {
    turnRows = Array.from({ length: 5100 }, (_, i) => turn(i, i % 2 ? "assistant" : "user", `filler turn number ${i}`));
    const res = await POST(post({ observations: [obs()] }, "lls_ok"));
    expect(await res.json()).toMatchObject({ inserted: 1, skipped_grounding: 1 });
  });

  it("keeps the NEWEST 5,000 turns: an anchor in the newest turns is found, one in the oldest is not", async () => {
    turnRows = [
      turn(0, "assistant", `Found it. ${NARRATIVE}`),
      ...Array.from({ length: 5200 }, (_, i) => turn(i + 1, i % 2 ? "assistant" : "user", `filler turn number ${i}`)),
      turn(5201, "assistant", "Another note: the sync worker retries with exponential backoff after a timeout."),
    ];
    const res = await POST(post({ observations: [obs()] }, "lls_ok"));
    expect(await res.json()).toMatchObject({ skipped_grounding: 1 });
    expect([...stored.values()][0]).toMatchObject({ quote: null, verified: false });
    turnRows = [
      ...Array.from({ length: 5200 }, (_, i) => turn(i, i % 2 ? "assistant" : "user", `filler turn number ${i}`)),
      turn(5200, "assistant", `Found it. ${NARRATIVE}`),
    ];
    stored.clear();
    const res2 = await POST(post({ observations: [obs()] }, "lls_ok"));
    expect(await res2.json()).toMatchObject({ inserted: 1, requoted: 1 });
    expect([...stored.values()][0]).toMatchObject({ quote: NARRATIVE, verified: true, turn_idx: 5200 });
  });

  it("counts in-request collapsed duplicates in duplicates", async () => {
    const res = await POST(post({ observations: [obs(), obs()] }, "lls_ok"));
    expect(await res.json()).toMatchObject({ received: 2, inserted: 1, duplicates: 1 });
  });

  it("upgrades a stored unquoted row when a quote is found on re-run (user-scoped, idempotent)", async () => {
    turnRows = [turn(0, "user", "fix the queue")];
    await POST(post({ observations: [obs()] }, "lls_ok"));
    expect([...stored.values()][0]).toMatchObject({ quote: null, verified: false });
    turnRows = [turn(0, "user", "fix the queue"), turn(3, "assistant", `Found it. ${NARRATIVE}`)];
    const res = await POST(post({ observations: [obs()] }, "lls_ok"));
    expect(await res.json()).toMatchObject({ inserted: 0, duplicates: 0, upgraded: 1 });
    expect([...stored.values()][0]).toMatchObject({ quote: NARRATIVE, verified: true, turn_idx: 3 });
    const again = await POST(post({ observations: [obs()] }, "lls_ok"));
    expect(await again.json()).toMatchObject({ upgraded: 0 });
    const upd = calls.filter((c) => c.table === "session_memories" && c.eq.source === "claude-mem");
    for (const c of upd) expect(c.eq.user_id).toBe("user-1");
  });

  it("the quote upgrade skips retired rows", async () => {
    turnRows = [turn(0, "user", "fix the queue")];
    await POST(post({ observations: [obs()] }, "lls_ok"));
    [...stored.values()][0].retired_at = "2026-01-01T00:00:00Z";
    turnRows = [turn(0, "user", "fix the queue"), turn(3, "assistant", `Found it. ${NARRATIVE}`)];
    const res = await POST(post({ observations: [obs()] }, "lls_ok"));
    expect(await res.json()).toMatchObject({ upgraded: 0 });
    expect([...stored.values()][0]).toMatchObject({ quote: null, verified: false });
    expect(calls.some((c) => c.eq.retired_at__is_null === true)).toBe(true);
  });

  it("always writes created_at in a mixed batch (valid ISO, missing, non-ISO)", async () => {
    const res = await POST(
      post(
        {
          observations: [
            obs({ narrative: "first observation text, long enough", createdAt: "2026-03-04T05:06:07Z" }),
            obs({ narrative: "second observation text, long enough", createdAt: null }),
            obs({ narrative: "third observation text, long enough", createdAt: "not a date" }),
          ],
        },
        "lls_ok",
      ),
    );
    expect(res.status).toBe(200);
    const rows = [...stored.values()];
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(typeof r.created_at).toBe("string");
      expect(Number.isNaN(Date.parse(r.created_at as string))).toBe(false);
    }
    expect(rows.some((r) => r.created_at === "2026-03-04T05:06:07.000Z")).toBe(true);
  });

  it("rawHash drives the dedupe key and must be 64 hex", async () => {
    const h = "a".repeat(64);
    await POST(post({ observations: [obs({ rawHash: h })] }, "lls_ok"));
    const again = await POST(
      post({ observations: [obs({ rawHash: h, narrative: `${NARRATIVE} (rule changed)` })] }, "lls_ok"),
    );
    expect(await again.json()).toMatchObject({ inserted: 0, duplicates: 1 });
    expect((await POST(post({ observations: [obs({ rawHash: "zz" })] }, "lls_ok"))).status).toBe(400);
  });

  it("400s a request spanning more than 25 sessions", async () => {
    const many = Array.from({ length: 26 }, (_, i) => obs({ contentSessionId: `cs-${i}` }));
    expect((await POST(post({ observations: many }, "lls_ok"))).status).toBe(400);
  });

  it("500s without leaking the database message when the insert fails", async () => {
    upsertError = { message: "secret internal detail" };
    const res = await POST(post({ observations: [obs()] }, "lls_ok"));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("secret");
  });
});
