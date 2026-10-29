import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SERVICE_KEY = "local-service-role-key-for-tests";
vi.mock("@/lib/db/clients", () => ({ getServiceClient: () => ({ marker: "db" }) }));
vi.mock("@/lib/env", () => ({ getEnv: () => ({ supabaseServiceRoleKey: SERVICE_KEY }) }));

const reembedBatch = vi.fn();
vi.mock("@/lib/local/reembed", async (orig) => ({
  ...(await orig<typeof import("@/lib/local/reembed")>()),
  reembedBatch: (...a: unknown[]) => reembedBatch(...a),
}));
const createEmbedder = vi.fn();
vi.mock("@/lib/memory/raw-units/embed", () => ({ createDefaultUnitEmbedder: () => createEmbedder() }));

import { POST } from "../route";

const call = (qs = "", auth: string | null = `Bearer ${SERVICE_KEY}`) =>
  POST(
    new NextRequest(`http://localhost:3000/api/internal/local/reembed${qs}`, {
      method: "POST",
      headers: auth ? { authorization: auth } : {},
    }),
  );

const okResult = {
  ok: true,
  family: "nomic-embed-text",
  table: "session_memories",
  done: 2,
  failed: 0,
  deferred: 0,
  remaining_by_table: { session_memories: 0, conversations: 0, conversation_chunks: 0, session_raw_units: 0 },
  finished: true,
  next: null,
  dry_run: false,
};

describe("POST /api/internal/local/reembed", () => {
  beforeEach(() => {
    reembedBatch.mockReset().mockResolvedValue(okResult);
    createEmbedder.mockReset().mockReturnValue({ family: "nomic-embed-text", embedBatch: vi.fn() });
    vi.stubEnv("MEMBRAL_LOCAL", "1");
    vi.stubEnv("VERCEL", "");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => vi.unstubAllEnvs());

  it("is 404 off local mode, and with VERCEL set, before any work", async () => {
    vi.stubEnv("MEMBRAL_LOCAL", "");
    expect((await call()).status).toBe(404);
    vi.stubEnv("MEMBRAL_LOCAL", "1");
    vi.stubEnv("VERCEL", "1");
    expect((await call()).status).toBe(404);
    expect(reembedBatch).not.toHaveBeenCalled();
  });

  it("is 401 on a wrong or missing bearer", async () => {
    for (const auth of ["Bearer nope", `Bearer ${SERVICE_KEY}x`, null]) expect((await call("", auth)).status).toBe(401);
    expect(reembedBatch).not.toHaveBeenCalled();
  });

  it("passes batch, dry_run and the cursor through and returns the result", async () => {
    const res = await call("?batch=128&dry_run=1&table=conversations&after=abc");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ table: "session_memories", done: 2, finished: true });
    expect(reembedBatch).toHaveBeenCalledWith(
      { marker: "db" },
      expect.objectContaining({
        family: "nomic-embed-text",
        batch: 128,
        dryRun: true,
        cursor: { table: "conversations", after: "abc" },
      }),
    );
  });

  it("rejects a bad batch or table with 400", async () => {
    expect((await call("?batch=0")).status).toBe(400);
    expect((await call("?batch=x")).status).toBe(400);
    expect((await call("?table=profiles")).status).toBe(400);
    expect(reembedBatch).not.toHaveBeenCalled();
  });

  it("maps no_embedder to 409", async () => {
    createEmbedder.mockReturnValue(null);
    reembedBatch.mockResolvedValue({ ok: false, code: "no_embedder", message: "No embedding provider" });
    const res = await call();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "no_embedder" });
  });

  it("maps rate_limited to 429 with Retry-After", async () => {
    reembedBatch.mockResolvedValue({ ok: false, code: "rate_limited", message: "x", retryAfterMs: 4200 });
    const res = await call();
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("5");
    expect(await res.json()).toMatchObject({ error: "rate_limited", retry_after_ms: 4200 });
  });

  it("maps embedder_unavailable to 502 and db errors to 500", async () => {
    reembedBatch.mockResolvedValue({ ok: false, code: "embedder_unavailable", message: "down" });
    expect((await call()).status).toBe(502);
    reembedBatch.mockResolvedValue({ ok: false, code: "db", message: "oops" });
    expect((await call()).status).toBe(500);
  });

  it("maps embedding_dimension to 422 with its own error code", async () => {
    reembedBatch.mockResolvedValue({ ok: false, code: "embedding_dimension", message: "too wide", dimensions: 2048 });
    const res = await call();
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: "embedding_dimension", message: "too wide" });
  });

  it("returns the deferred count to the caller", async () => {
    reembedBatch.mockResolvedValue({ ...okResult, deferred: 3 });
    expect(await (await call()).json()).toMatchObject({ deferred: 3 });
  });
});
