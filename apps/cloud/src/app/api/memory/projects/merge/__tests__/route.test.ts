import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// biome-ignore lint/suspicious/noExplicitAny: minimal chainable Supabase-shaped test double
type Chain = any;

/** A chainable, thenable mock — every method returns itself; awaiting it resolves to `result`. */
function makeChain(result: { data: unknown; error: unknown }): Chain {
  const chain: Chain = {
    select: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    order: vi.fn(() => chain),
    delete: vi.fn(() => chain),
    upsert: vi.fn(() => Promise.resolve(result)),
    // biome-ignore lint/suspicious/noThenProperty: mimics supabase-js's thenable query builder (real code awaits it directly)
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
  };
  return chain;
}

const mockGetUser = vi.fn();
const mockFrom = vi.fn();
const mockRpc = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mockGetUser },
    from: mockFrom,
    rpc: mockRpc,
  })),
}));

import { GET, POST } from "../route";

function postReq(body: unknown): NextRequest {
  return new NextRequest("http://localhost:3000/api/memory/projects/merge", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function authed() {
  mockGetUser.mockResolvedValueOnce({ data: { user: { id: "user-1" } }, error: null });
}

describe("POST /api/memory/projects/merge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("401 when unauthenticated", async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: null }, error: null });
    const res = await POST(postReq({ alias: "a", canonical: "b", action: "merge" }));
    expect(res.status).toBe(401);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it("400 on invalid JSON body", async () => {
    authed();
    const req = new NextRequest("http://localhost:3000/api/memory/projects/merge", {
      method: "POST",
      body: "not json",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("400 when action is not 'merge'|'unmerge'", async () => {
    authed();
    const res = await POST(postReq({ alias: "a", canonical: "b", action: "delete" }));
    expect(res.status).toBe(400);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it("400 when alias or canonical is empty", async () => {
    authed();
    const res = await POST(postReq({ alias: "", canonical: "b", action: "merge" }));
    expect(res.status).toBe(400);
  });

  it("400 when alias === canonical for a merge (trivial self-alias)", async () => {
    authed();
    const res = await POST(postReq({ alias: "same", canonical: "same", action: "merge" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/differ/);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it("merges: reads existing aliases for the cycle check, then upserts a manual row", async () => {
    authed();
    const existingChain = makeChain({ data: [], error: null });
    const upsertChain = makeChain({ data: null, error: null });
    mockFrom.mockReturnValueOnce(existingChain).mockReturnValueOnce(upsertChain);

    const res = await POST(postReq({ alias: "surajtripathy07/membral", canonical: "dev/membral", action: "merge" }));
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    expect(mockFrom).toHaveBeenNthCalledWith(1, "project_aliases");
    expect(mockFrom).toHaveBeenNthCalledWith(2, "project_aliases");
    expect(upsertChain.upsert).toHaveBeenCalledWith(
      { user_id: "user-1", canonical: "dev/membral", alias: "surajtripathy07/membral", source: "manual" },
      { onConflict: "user_id,alias" },
    );
  });

  // migration 063 finding #1: the route relies on the conflict path of
  // `upsert` (INSERT ... ON CONFLICT DO UPDATE) succeeding for a re-merge /
  // change-of-mind — this unit test only proves the route ISSUES that call
  // correctly; the live RLS UPDATE-policy fix itself was verified against
  // the real DB (see the W7 report's "Review findings addressed" section).
  it("re-merge: merging an alias that already has a row (change of mind) issues the same upsert call", async () => {
    authed();
    const existingChain = makeChain({
      data: [{ alias: "surajtripathy07/membral", canonical: "dev/membral" }],
      error: null,
    });
    const upsertChain = makeChain({ data: null, error: null });
    mockFrom.mockReturnValueOnce(existingChain).mockReturnValueOnce(upsertChain);

    const res = await POST(
      postReq({ alias: "surajtripathy07/membral", canonical: "some-other-target", action: "merge" }),
    );
    expect(res.status).toBe(200);
    expect(upsertChain.upsert).toHaveBeenCalledWith(
      { user_id: "user-1", canonical: "some-other-target", alias: "surajtripathy07/membral", source: "manual" },
      { onConflict: "user_id,alias" },
    );
  });

  it("refuses a cycle: canonical already resolves back to alias through an existing chain", async () => {
    authed();
    // Existing: "b" -> "a". A merge request of alias="a", canonical="b"
    // would create a -> b -> a, a cycle.
    const existingChain = makeChain({ data: [{ alias: "b", canonical: "a" }], error: null });
    mockFrom.mockReturnValueOnce(existingChain);

    const res = await POST(postReq({ alias: "a", canonical: "b", action: "merge" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/cycle/);
    // Only the existing-aliases read happened — no upsert attempted.
    expect(mockFrom).toHaveBeenCalledTimes(1);
  });

  it("500 with a clean message when the existing-aliases read fails", async () => {
    authed();
    mockFrom.mockReturnValueOnce(makeChain({ data: null, error: { message: "boom" } }));
    const res = await POST(postReq({ alias: "a", canonical: "b", action: "merge" }));
    expect(res.status).toBe(500);
  });

  it("500 with a clean message when the upsert fails", async () => {
    authed();
    mockFrom
      .mockReturnValueOnce(makeChain({ data: [], error: null }))
      .mockReturnValueOnce(makeChain({ data: null, error: { message: "boom" } }));
    const res = await POST(postReq({ alias: "a", canonical: "b", action: "merge" }));
    expect(res.status).toBe(500);
  });

  // migration 063, findings #3/#7: unmerge now upserts a self-referencing
  // TOMBSTONE row (source='unmerged') instead of deleting — a delete would
  // let the next project_alias_seed run silently resurrect the exact merge
  // being undone.
  it("unmerges: upserts a self-referencing 'unmerged' tombstone, ignoring the client's canonical", async () => {
    authed();
    const upsertChain = makeChain({ data: null, error: null });
    mockFrom.mockReturnValueOnce(upsertChain);

    const res = await POST(postReq({ alias: "surajtripathy07/membral", canonical: "dev/membral", action: "unmerge" }));
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    expect(mockFrom).toHaveBeenCalledWith("project_aliases");
    // canonical from the request ("dev/membral") is IGNORED — the tombstone
    // always points at itself, regardless of what the client sent.
    expect(upsertChain.upsert).toHaveBeenCalledWith(
      { user_id: "user-1", canonical: "surajtripathy07/membral", alias: "surajtripathy07/membral", source: "unmerged" },
      { onConflict: "user_id,alias" },
    );
  });

  it("unmerge succeeds even for an alias with no existing row (a pre-emptive 'never merge this' tombstone)", async () => {
    authed();
    mockFrom.mockReturnValueOnce(makeChain({ data: null, error: null }));
    const res = await POST(postReq({ alias: "nope", canonical: "dev/membral", action: "unmerge" }));
    expect(res.status).toBe(200);
  });

  it("500 with a clean message when the unmerge upsert fails", async () => {
    authed();
    mockFrom.mockReturnValueOnce(makeChain({ data: null, error: { message: "boom" } }));
    const res = await POST(postReq({ alias: "a", canonical: "b", action: "unmerge" }));
    expect(res.status).toBe(500);
  });
});

describe("GET /api/memory/projects/merge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRpc.mockResolvedValue({ data: null, error: null });
  });

  it("401 when unauthenticated", async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: null }, error: null });
    const res = await GET(new NextRequest("http://localhost/api/memory/projects/merge"));
    expect(res.status).toBe(401);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  // migration 063, finding #2: GET is one of the two real call sites that
  // make the demo state reproducible from the repo (the other is POST
  // /api/code-sessions after an import) — no more hand-run, spoofed-JWT
  // seeding.
  it("seeds project_aliases for this user before listing", async () => {
    authed();
    const chain = makeChain({ data: [], error: null });
    mockFrom.mockReturnValueOnce(chain);

    await GET(new NextRequest("http://localhost/api/memory/projects/merge"));
    expect(mockRpc).toHaveBeenCalledWith("project_alias_seed", { p_user: "user-1" });
  });

  it("still lists merges even when the seed RPC rejects (best-effort, never breaks the listing)", async () => {
    authed();
    mockRpc.mockRejectedValueOnce(new Error("seed boom"));
    const rows = [
      { alias: "surajtripathy07/membral", canonical: "dev/membral", source: "manual", created_at: "2026-08-27" },
    ];
    mockFrom.mockReturnValueOnce(makeChain({ data: rows, error: null }));

    const res = await GET(new NextRequest("http://localhost/api/memory/projects/merge"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ merges: rows });
  });

  // migration 064, NEW-3: GET now returns every merge for this user, any
  // source — a seeded (slug/remote-lineage) merge needs an unmerge chip too,
  // and the label it swallowed needs to be selectable in the merge-source
  // dropdown. Previously filtered to source='manual' only.
  it("lists every merge for this user, any source (no more source='manual' filter)", async () => {
    authed();
    const rows = [
      {
        alias: "surajtripathy07/membral",
        canonical: "dev/membral",
        source: "remote-lineage",
        created_at: "2026-08-26",
      },
      { alias: "Acme AIX", canonical: "Acme Hub", source: "manual", created_at: "2026-08-27" },
    ];
    const chain = makeChain({ data: rows, error: null });
    mockFrom.mockReturnValueOnce(chain);

    const res = await GET(new NextRequest("http://localhost/api/memory/projects/merge"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ merges: rows });
    expect(chain.eq).toHaveBeenCalledWith("user_id", "user-1");
    expect(chain.eq).not.toHaveBeenCalledWith("source", expect.anything());
  });

  it("500 with a clean message when the query fails", async () => {
    authed();
    mockFrom.mockReturnValueOnce(makeChain({ data: null, error: { message: "boom" } }));
    const res = await GET(new NextRequest("http://localhost/api/memory/projects/merge"));
    expect(res.status).toBe(500);
  });
});
