import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const _originalFetch = globalThis.fetch;
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const { fetchWithTimeout } = await import("../common/fetch.js");

describe("fetchWithTimeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns response on success within timeout", async () => {
    const mockResponse = new Response("ok", { status: 200 });
    mockFetch.mockResolvedValue(mockResponse);

    const promise = fetchWithTimeout("https://example.com/api");
    vi.advanceTimersByTime(0);
    const response = await promise;

    expect(response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("passes init options and signal to fetch", async () => {
    mockFetch.mockResolvedValue(new Response("ok"));

    const promise = fetchWithTimeout("https://example.com/api", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    vi.advanceTimersByTime(0);
    await promise;

    const [, init] = mockFetch.mock.calls[0];
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("aborts fetch after timeout", async () => {
    mockFetch.mockImplementation((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal!.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });
    });

    const promise = fetchWithTimeout("https://example.com/api", undefined, 5000);
    vi.advanceTimersByTime(5000);

    await expect(promise).rejects.toThrow("aborted");
  });

  it("uses default 30s timeout when none specified", async () => {
    mockFetch.mockImplementation((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal!.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });
    });

    const promise = fetchWithTimeout("https://example.com/api");

    vi.advanceTimersByTime(29999);
    await vi.advanceTimersByTimeAsync(0);

    vi.advanceTimersByTime(1);
    await expect(promise).rejects.toThrow("aborted");
  });

  it("clears timeout on successful response", async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    mockFetch.mockResolvedValue(new Response("ok"));

    await fetchWithTimeout("https://example.com/api");

    expect(clearTimeoutSpy).toHaveBeenCalled();
    clearTimeoutSpy.mockRestore();
  });
});
