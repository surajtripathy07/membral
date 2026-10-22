import { describe, expect, it, vi } from "vitest";
import { fetchServedUsedLine, formatServedUsedLine } from "../served-used-line.js";

const payload = {
  days: 7,
  totals: { served: 42, used: 9, ignored: 25, pending: 8, unlinked: 4 },
  surfaces: [
    { surface: "mcp", served: 30, used: 7, ignored: 20, pending: 3, unlinked: 1 },
    { surface: "preamble", served: 12, used: 2, ignored: 5, pending: 5, unlinked: 3 },
  ],
};

describe("formatServedUsedLine", () => {
  it("formats one line with the exact prefix and per-surface counts", () => {
    expect(formatServedUsedLine(payload)).toBe(
      "served 42 · used 9 · ignored 25 · pending 8 · unlinked 4 (7 days; mcp 30/7/20/3/1, preamble 12/2/5/5/3)",
    );
  });
  it("prints zeros without a surface list", () => {
    expect(formatServedUsedLine({ days: 7, totals: {}, surfaces: [] })).toBe(
      "served 0 · used 0 · ignored 0 · pending 0 · unlinked 0 (7 days)",
    );
  });
  it("returns null for a wrong shape", () => {
    expect(formatServedUsedLine(null)).toBeNull();
    expect(formatServedUsedLine({ error: "x" })).toBeNull();
  });
});

describe("fetchServedUsedLine", () => {
  const config = { apiUrl: "https://membral.test", apiKey: "lls_k", apiKeySource: "credentials" as const };
  it("returns the line on 200", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 }));
    const line = await fetchServedUsedLine(config, { fetchImpl: f as unknown as typeof fetch });
    expect(line).toMatch(/^served 42 /);
    expect(String((f.mock.calls[0] as unknown[])[0])).toContain("/api/memory/served-used");
  });
  it("returns null on 404 (old server) and on network failure, never throwing", async () => {
    const f404 = vi.fn(async () => new Response("nf", { status: 404 }));
    expect(await fetchServedUsedLine(config, { fetchImpl: f404 as unknown as typeof fetch })).toBeNull();
    const fErr = vi.fn(async () => {
      throw new Error("down");
    });
    expect(await fetchServedUsedLine(config, { fetchImpl: fErr as unknown as typeof fetch })).toBeNull();
  });
  it("bounds the whole call, including a 401 fallback, to the budget", async () => {
    const f = vi.fn(
      (_u: unknown, init?: RequestInit) =>
        new Promise<Response>((_res, rej) => {
          init?.signal?.addEventListener("abort", () => rej(new Error("aborted")));
        }),
    );
    const t0 = Date.now();
    const line = await fetchServedUsedLine(config, { fetchImpl: f as unknown as typeof fetch, budgetMs: 150 });
    expect(line).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(f.mock.calls.length).toBeLessThanOrEqual(2);
  });
});
