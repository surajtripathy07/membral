// #173: search-as-you-type must never let a stale response overwrite newer
// results. A fake fetch holds each request until the test releases it, and
// rejects with AbortError when its signal aborts (as the real fetch does).
import { describe, expect, it, vi } from "vitest";
import { createSearchRunner, type SearchSink } from "../search-runner";

interface Pending {
  url: string;
  signal: AbortSignal;
  resolve: (body: unknown) => void;
}

function fakeFetch() {
  const pending: Pending[] = [];
  const impl = vi.fn((url: string, init?: RequestInit) => {
    const signal = init?.signal as AbortSignal;
    return new Promise<Response>((resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      pending.push({
        url,
        signal,
        resolve: (body) => resolve(new Response(JSON.stringify(body), { status: 200 })),
      });
    });
  });
  return { impl: impl as unknown as typeof fetch, pending };
}

function sink() {
  const state = { results: [] as unknown[], memories: [] as unknown[], loading: false, searched: false };
  const s: SearchSink = {
    setResults: (r) => {
      state.results = r;
    },
    setMemoryResults: (m) => {
      state.memories = m;
    },
    setLoading: (l) => {
      state.loading = l;
    },
    setSearched: (v) => {
      state.searched = v;
    },
  };
  return { state, s };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("createSearchRunner (#173)", () => {
  it("two queries, the first resolves last: only the second's results show", async () => {
    const { impl, pending } = fakeFetch();
    const { state, s } = sink();
    const runner = createSearchRunner({ getAccessToken: async () => "tok", fetchImpl: impl, sink: s });

    const first = runner.run({ q: "alpha", mode: "hybrid", tab: "conversations", lane: "all" });
    await flush();
    const second = runner.run({ q: "beta", mode: "hybrid", tab: "conversations", lane: "all" });
    await flush();

    expect(pending).toHaveLength(2);
    expect(pending[0].url).toContain("q=alpha");
    expect(pending[0].signal.aborted).toBe(true);
    expect(pending[1].signal.aborted).toBe(false);

    pending[1].resolve({ results: [{ id: "beta-hit" }] });
    await second;
    // The stale response lands last; it must change nothing.
    pending[0].resolve({ results: [{ id: "alpha-hit" }] });
    await first;
    await flush();

    expect(state.results).toEqual([{ id: "beta-hit" }]);
    expect(state.loading).toBe(false);
    expect(state.searched).toBe(true);
  });

  it("clearing the query aborts the in-flight request and drops its results", async () => {
    const { impl, pending } = fakeFetch();
    const { state, s } = sink();
    const runner = createSearchRunner({ getAccessToken: async () => "tok", fetchImpl: impl, sink: s });

    const first = runner.run({ q: "alpha", mode: "hybrid", tab: "all", lane: "all" });
    await flush();
    await runner.run({ q: "  ", mode: "hybrid", tab: "all", lane: "all" });
    pending[0].resolve({ results: [{ id: "alpha-hit" }] });
    await first;
    await flush();

    expect(pending.every((p) => p.signal.aborted)).toBe(true);
    expect(state.results).toEqual([]);
    expect(state.memories).toEqual([]);
    expect(state.loading).toBe(false);
    expect(state.searched).toBe(false);
  });

  it("a signed-out session clears both lists without fetching", async () => {
    const { impl } = fakeFetch();
    const { state, s } = sink();
    const runner = createSearchRunner({ getAccessToken: async () => null, fetchImpl: impl, sink: s });
    await runner.run({ q: "alpha", mode: "hybrid", tab: "all", lane: "all" });
    expect(impl).not.toHaveBeenCalled();
    expect(state.results).toEqual([]);
    expect(state.loading).toBe(false);
  });
});
