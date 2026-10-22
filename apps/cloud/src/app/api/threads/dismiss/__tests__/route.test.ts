// POST /api/threads/dismiss — cookie auth, Zod body, idempotent write via
// writeThreadDismissal (mocked: the write itself is covered in
// lib/threads/__tests__/queries.test.ts).
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetUser = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mockGetUser } })),
}));

const mockWrite = vi.fn();
vi.mock("@/lib/threads/queries", () => ({
  writeThreadDismissal: (...args: unknown[]) => mockWrite(...args),
}));

import { POST } from "../route";

const REF = "codehub.example/acme/billing#15178";

function post(body: unknown): NextRequest {
  return new NextRequest("http://localhost:3000/api/threads/dismiss", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /api/threads/dismiss", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
  });

  it("returns 401 when there is no session", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });
    const res = await POST(post({ ref: REF }));
    expect(res.status).toBe(401);
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it("rejects a body without a ref, kind or reason, an unknown reason, or non-JSON", async () => {
    expect((await POST(post({}))).status).toBe(400);
    expect((await POST(post({ ref: REF, kind: "issue" }))).status).toBe(400);
    expect((await POST(post({ ref: REF, reason: "resolved_elsewhere" }))).status).toBe(400);
    expect((await POST(post({ ref: REF, kind: "issue", reason: "meh" }))).status).toBe(400);
    expect((await POST(post("{not json"))).status).toBe(400);
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it("F13: requires content-type application/json (415 otherwise)", async () => {
    const res = await POST(
      new NextRequest("http://localhost:3000/api/threads/dismiss", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: JSON.stringify({ ref: REF, kind: "issue", reason: "resolved_elsewhere" }),
      }),
    );
    expect(res.status).toBe(415);
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it("writes the dismissal for the caller keyed by (kind, ref) with the chosen reason", async () => {
    mockWrite.mockResolvedValue({ ok: true, already: false, dismissal_id: "d1" });
    const res = await POST(post({ ref: ` ${REF} `, kind: "merge_request", reason: "not_delivery_item" }));
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data).toEqual({
      ok: true,
      ref: REF,
      kind: "merge_request",
      reason: "not_delivery_item",
      already: false,
      dismissal_id: "d1",
    });
    expect(mockWrite).toHaveBeenCalledWith(
      expect.anything(),
      "u1",
      { ref: REF, kind: "merge_request" },
      "not_delivery_item",
    );
  });

  it("a dismissed thread does not return next day: a second call is idempotent", async () => {
    mockWrite.mockResolvedValue({ ok: true, already: true, dismissal_id: "d1" });
    const res = await POST(post({ ref: REF, kind: "issue", reason: "resolved_elsewhere" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, already: true });
  });

  it("returns 404 for a ref none of the caller's sessions acted on, 500 when the write throws", async () => {
    const body = { ref: "codehub.example/acme/billing#404", kind: "issue", reason: "resolved_elsewhere" };
    mockWrite.mockResolvedValue({ ok: false, reason: "unknown_ref" });
    expect((await POST(post(body))).status).toBe(404);
    mockWrite.mockRejectedValue(new Error("boom"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await POST(post(body))).status).toBe(500);
    err.mockRestore();
  });
});
