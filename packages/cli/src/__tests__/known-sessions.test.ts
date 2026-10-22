import { FORGE_ACTIONS_VERSION, type RawCodeSession } from "@membral/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UploadAuthError } from "../code-session-upload.js";
import { fetchKnownSessions, KnownSessionsUnavailableError } from "../known-sessions.js";

const config = { apiUrl: "https://cloud.example.com", apiKey: "lls_test" };

function session(id: string): RawCodeSession {
  return {
    source: "claude-code",
    sourceSessionId: id,
    contentHash: "h",
    repo: {},
    startedAt: "2026-02-01T00:00:00.000Z",
    endedAt: "2026-02-01T00:05:00.000Z",
    turns: [],
    filesTouched: [],
    toolCounts: {},
  };
}

describe("fetchKnownSessions", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("queries in chunks of 500 and maps each chunk's indexes back to its sessions", async () => {
    const sessions = Array.from({ length: 1001 }, (_, i) => session(`s-${i}`));
    const sizes: number[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as { sessions: unknown[] };
        sizes.push(body.sessions.length);
        return {
          ok: true,
          status: 200,
          json: async () => ({ known: [0] }),
          text: async () => JSON.stringify({ known: [0] }),
        };
      }),
    );

    const known = await fetchKnownSessions(config, sessions);

    expect(sizes).toEqual([500, 500, 1]);
    expect([...known].map((s) => s.sourceSessionId)).toEqual(["s-0", "s-500", "s-1000"]);
  });

  it("waits out a 429 (Retry-After) before retrying, never immediately", async () => {
    const sleep = vi.fn(async () => {});
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => {
        call++;
        if (call === 1)
          return { ok: false, status: 429, headers: new Headers({ "retry-after": "3" }), text: async () => "" };
        return {
          ok: true,
          status: 200,
          json: async () => ({ known: [] }),
          text: async () => JSON.stringify({ known: [] }),
        };
      }),
    );

    await fetchKnownSessions(config, [session("a")], { sleep });

    expect(sleep).toHaveBeenCalledWith(3000);
  });

  it("throws UploadAuthError on 401 and KnownSessionsUnavailableError on 404 or an out-of-range index", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401, text: async () => "" }));
    await expect(fetchKnownSessions(config, [session("a")])).rejects.toBeInstanceOf(UploadAuthError);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404, text: async () => "" }));
    await expect(fetchKnownSessions(config, [session("a")])).rejects.toBeInstanceOf(KnownSessionsUnavailableError);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ known: [5] }),
        text: async () => JSON.stringify({ known: [5] }),
      }),
    );
    await expect(fetchKnownSessions(config, [session("a")])).rejects.toBeInstanceOf(KnownSessionsUnavailableError);
  });

  it("sends the parser's actions_version on each probe (issue #171)", async () => {
    let probes: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
        probes = (JSON.parse(init.body as string) as { sessions: Record<string, unknown>[] }).sessions;
        return {
          ok: true,
          status: 200,
          json: async () => ({ known: [] }),
          text: async () => JSON.stringify({ known: [] }),
        };
      }),
    );

    await fetchKnownSessions(config, [{ ...session("a"), actionsVersion: FORGE_ACTIONS_VERSION }]);

    expect(probes).toEqual([
      {
        source: "claude-code",
        source_session_id: "a",
        turn_count: 0,
        ended_at: "2026-02-01T00:05:00.000Z",
        actions_version: FORGE_ACTIONS_VERSION,
      },
    ]);
  });
});
