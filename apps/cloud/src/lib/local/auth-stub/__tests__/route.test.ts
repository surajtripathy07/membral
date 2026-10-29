import { afterEach, describe, expect, it, vi } from "vitest";

const { handleLocalAuth } = vi.hoisted(() => ({
  handleLocalAuth: vi.fn(async () => new Response("stub", { status: 200 })),
}));
vi.mock("@/lib/local/auth-stub", () => ({ handleLocalAuth }));

import { GET, POST } from "@/app/auth/v1/[...path]/route";

afterEach(() => {
  vi.unstubAllEnvs();
  handleLocalAuth.mockClear();
});

const ctx = (path: string[]) => ({ params: Promise.resolve({ path }) });

describe("/auth/v1 route", () => {
  it("is 404 unless local mode", async () => {
    vi.stubEnv("MEMBRAL_LOCAL", "");
    const res = await GET(new Request("http://127.0.0.1:3001/auth/v1/settings"), ctx(["settings"]));
    expect(res.status).toBe(404);
    expect(handleLocalAuth).not.toHaveBeenCalled();
  });

  it("is 404 when MEMBRAL_LOCAL is set on Vercel", async () => {
    vi.stubEnv("MEMBRAL_LOCAL", "1");
    vi.stubEnv("VERCEL", "1");
    const res = await POST(new Request("http://127.0.0.1:3001/auth/v1/token", { method: "POST" }), ctx(["token"]));
    expect(res.status).toBe(404);
    expect(handleLocalAuth).not.toHaveBeenCalled();
  });

  it("delegates in local mode", async () => {
    vi.stubEnv("MEMBRAL_LOCAL", "1");
    vi.stubEnv("VERCEL", "");
    const res = await POST(new Request("http://127.0.0.1:3001/auth/v1/token", { method: "POST" }), ctx(["token"]));
    expect(res.status).toBe(200);
    expect(handleLocalAuth).toHaveBeenCalledWith(expect.any(Request), ["token"]);
  });
});
