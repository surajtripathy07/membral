import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks ---
// pingSupabase() builds a client and runs `.from("conversations").select(...)`.
// We drive that select to resolve (reachable) or reject (down).
const mockSelect = vi.fn();

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    from: () => ({ select: mockSelect }),
  })),
}));

process.env.NEXT_PUBLIC_SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";

import { GET } from "../route";

describe("GET /api/health", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("returns 200 { status: ok, checks.supabase: ok } when the Supabase ping resolves", async () => {
    mockSelect.mockResolvedValue({ error: null });
    const res = await GET(new Request("http://x/api/health"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: "ok", checks: { supabase: "ok" } });
  });

  it("returns 503 { status: degraded, checks.supabase: down } when the ping rejects", async () => {
    mockSelect.mockRejectedValue(new Error("ECONNREFUSED"));
    const res = await GET(new Request("http://x/api/health"));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toEqual({ status: "degraded", checks: { supabase: "down" } });
  });

  it("marks supabase down (503) when the query returns a PostgREST error", async () => {
    mockSelect.mockResolvedValue({ error: { message: "relation missing" } });
    const res = await GET(new Request("http://x/api/health"));
    expect(res.status).toBe(503);
    expect((await res.json()).checks.supabase).toBe("down");
  });

  it("echoes an inbound x-request-id and always sets the header", async () => {
    mockSelect.mockResolvedValue({ error: null });
    const res = await GET(new Request("http://x/api/health", { headers: { "x-request-id": "probe-1" } }));
    expect(res.headers.get("x-request-id")).toBe("probe-1");
  });

  it("reports no openai check (the kg pass-1 key check is gone)", async () => {
    mockSelect.mockResolvedValue({ error: null });
    const res = await GET(new Request("http://x/api/health"));
    expect((await res.json()).checks.openai).toBeUndefined();
  });

  describe("local stack llm block", () => {
    const LLM_ENV = [
      "MEMBRAL_LOCAL",
      "VERCEL",
      "OPENAI_API_KEY",
      "OPENROUTER_API_KEY",
      "ANTHROPIC_API_KEY",
      "GEMINI_API_KEY",
      "MEMBRAL_MODEL",
      "MEMBRAL_MODEL_BASE_URL",
      "MEMBRAL_EMBEDDINGS_BASE_URL",
      "MEMBRAL_EMBEDDING_MODEL",
      "MEMBRAL_EMBED_MODEL",
    ];
    beforeEach(() => {
      for (const k of LLM_ENV) vi.stubEnv(k, "");
      mockSelect.mockResolvedValue({ error: null });
    });
    afterEach(() => vi.unstubAllEnvs());

    it("hosted (MEMBRAL_LOCAL unset) body is unchanged even with a key set", async () => {
      vi.stubEnv("OPENAI_API_KEY", "sk-test");
      const res = await GET(new Request("http://x/api/health"));
      expect(await res.text()).toBe(JSON.stringify({ status: "ok", checks: { supabase: "ok" } }));
    });

    it("omits llm when VERCEL is set, even with MEMBRAL_LOCAL=1", async () => {
      vi.stubEnv("MEMBRAL_LOCAL", "1");
      vi.stubEnv("VERCEL", "1");
      const body = await (await GET(new Request("http://x/api/health"))).json();
      expect(body.llm).toBeUndefined();
    });

    it("local, no key: extraction off, nothing configured", async () => {
      vi.stubEnv("MEMBRAL_LOCAL", "1");
      const body = await (await GET(new Request("http://x/api/health"))).json();
      expect(body).toEqual({
        status: "ok",
        checks: { supabase: "ok" },
        llm: {
          configured: false,
          provider: null,
          model: null,
          extraction: "off",
          embeddings: { configured: false, model: null },
        },
      });
    });

    it("local, OpenRouter key: provider, model and embeddings reported, never the key", async () => {
      vi.stubEnv("MEMBRAL_LOCAL", "1");
      vi.stubEnv("OPENROUTER_API_KEY", "sk-or-secret");
      const res = await GET(new Request("http://x/api/health"));
      const text = await res.text();
      expect(text).not.toContain("sk-or-secret");
      expect(JSON.parse(text).llm).toEqual({
        configured: true,
        provider: "openrouter",
        model: "openai/gpt-4o-mini",
        extraction: "on",
        embeddings: { configured: true, model: "openai/text-embedding-3-small" },
      });
    });

    it("local, Anthropic key only: extraction on, embeddings off", async () => {
      vi.stubEnv("MEMBRAL_LOCAL", "1");
      vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-secret");
      const body = await (await GET(new Request("http://x/api/health"))).json();
      expect(body.llm).toMatchObject({
        provider: "anthropic",
        extraction: "on",
        embeddings: { configured: false, model: null },
      });
    });
  });
});
