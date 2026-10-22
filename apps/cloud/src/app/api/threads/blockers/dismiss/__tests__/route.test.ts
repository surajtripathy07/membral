// /api/threads/blockers/dismiss — cookie auth, Zod bodies, POST dismisses,
// DELETE undoes (the writes are mocked: lib/memory/__tests__ covers them
// against the fake client, including the preamble exclusion).
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetUser = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mockGetUser } })),
}));

const mockDismiss = vi.fn();
const mockUndo = vi.fn();
const mockList = vi.fn();
vi.mock("@/lib/memory/blocker-dismiss", () => ({
  BLOCKER_DISMISS_REASONS: ["resolved", "ignored"],
  dismissBlocker: (...args: unknown[]) => mockDismiss(...args),
  undoBlockerDismissal: (...args: unknown[]) => mockUndo(...args),
  listDismissedBlockers: (...args: unknown[]) => mockList(...args),
}));

import { DELETE, GET, POST } from "../route";

const ID = "3f1c2a4e-8b7d-4c6a-9e2f-1a2b3c4d5e6f";
const ID2 = "7a9b8c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const URL = "http://localhost:3000/api/threads/blockers/dismiss";

function req(method: "POST" | "DELETE", body: unknown, type = "application/json"): NextRequest {
  return new NextRequest(URL, {
    method,
    headers: { "content-type": type },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /api/threads/blockers/dismiss", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
  });

  it("401 without a session", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });
    expect((await POST(req("POST", { id: ID, reason: "resolved" }))).status).toBe(401);
    expect((await DELETE(req("DELETE", { ids: [ID] }))).status).toBe(401);
    expect(mockDismiss).not.toHaveBeenCalled();
    expect(mockUndo).not.toHaveBeenCalled();
  });

  it("400 on a missing/non-uuid id, an unknown reason or bad JSON; 415 on a non-JSON content type", async () => {
    expect((await POST(req("POST", {}))).status).toBe(400);
    expect((await POST(req("POST", { id: "b1", reason: "resolved" }))).status).toBe(400);
    expect((await POST(req("POST", { id: ID, reason: "resolved_elsewhere" }))).status).toBe(400);
    expect((await POST(req("POST", { id: ID }))).status).toBe(400);
    expect((await POST(req("POST", "{not json"))).status).toBe(400);
    expect((await POST(req("POST", { id: ID, reason: "resolved" }, "text/plain"))).status).toBe(415);
    expect(mockDismiss).not.toHaveBeenCalled();
  });

  it("dismisses as the caller and returns the retired ids", async () => {
    mockDismiss.mockResolvedValue({ ok: true, ids: [ID, ID2] });
    const res = await POST(req("POST", { id: ID, reason: "ignored" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, id: ID, reason: "ignored", ids: [ID, ID2] });
    expect(mockDismiss).toHaveBeenCalledWith(expect.anything(), "u1", ID, "ignored");
  });

  it("404 when the id is not a live blocker of the caller's; 500 on a write failure", async () => {
    mockDismiss.mockResolvedValue({ ok: false });
    expect((await POST(req("POST", { id: ID, reason: "resolved" }))).status).toBe(404);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockDismiss.mockRejectedValue(new Error("boom"));
    expect((await POST(req("POST", { id: ID, reason: "resolved" }))).status).toBe(500);
    errSpy.mockRestore();
  });
});

describe("DELETE /api/threads/blockers/dismiss (Undo)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
  });

  it("400 on an empty or non-uuid ids list", async () => {
    expect((await DELETE(req("DELETE", { ids: [] }))).status).toBe(400);
    expect((await DELETE(req("DELETE", { ids: ["b1"] }))).status).toBe(400);
    expect((await DELETE(req("DELETE", {}))).status).toBe(400);
    expect(mockUndo).not.toHaveBeenCalled();
  });

  it("lifts the caller's rows; 404 when nothing of theirs was dismissed", async () => {
    mockUndo.mockResolvedValue([ID]);
    const res = await DELETE(req("DELETE", { ids: [ID] }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ids: [ID] });
    expect(mockUndo).toHaveBeenCalledWith(expect.anything(), "u1", [ID]);
    mockUndo.mockResolvedValue([]);
    expect((await DELETE(req("DELETE", { ids: [ID2] }))).status).toBe(404);
  });
});

describe("GET /api/threads/blockers/dismiss (the dismissed list)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
  });

  it("401 without a session; the caller's list otherwise", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });
    expect((await GET(new NextRequest(URL))).status).toBe(401);
    expect(mockList).not.toHaveBeenCalled();
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    const item = { ids: [ID], text: "t", quote: null, reason: "ignored", dismissed_at: "2026-09-20T00:00:00Z" };
    mockList.mockResolvedValue([item]);
    const res = await GET(new NextRequest(URL));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ dismissed: [item] });
    expect(mockList).toHaveBeenCalledWith(expect.anything(), "u1");
  });
});
