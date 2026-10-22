// Unit tests for sync/engine.ts's orchestration additions (goal 2026-07-26
// step 15, #27/#57): cursor seeded from the cloud manifest (never local
// storage alone), the forceFull reconciliation-backstop bypass, and the
// cancel mechanism (CLAUDE.md "Cancel mechanism" rule) -- cancelling stops
// the whole run, and a cancelled provider's cursor is never advanced.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CURSOR_OVERLAP_MS } from "../sync/delta.js";

function withOverlap(iso: string): string {
  return new Date(new Date(iso).getTime() - CURSOR_OVERLAP_MS).toISOString();
}

const mockGetAccessToken = vi.fn();
vi.mock("../auth/auth.js", () => ({
  getAccessToken: (...args: unknown[]) => mockGetAccessToken(...args),
}));

const mockGetConversationCountByProvider = vi.fn().mockResolvedValue(0);
const mockGetKnownUpdatedAtByProvider = vi.fn().mockResolvedValue(new Map());
const mockGetSettings = vi.fn().mockResolvedValue({ enabledProviders: ["claude", "chatgpt"] });
const mockGetSyncState = vi.fn().mockResolvedValue({ providers: {}, lastFullSyncAt: null });
const mockSaveConversationsBatch = vi.fn().mockResolvedValue(undefined);
const mockSetLastFullSyncAt = vi.fn().mockResolvedValue(undefined);
const mockUpdateProviderSyncState = vi.fn().mockResolvedValue(undefined);
vi.mock("../common/storage.js", () => ({
  getConversationCountByProvider: (...args: unknown[]) => mockGetConversationCountByProvider(...args),
  getKnownUpdatedAtByProvider: (...args: unknown[]) => mockGetKnownUpdatedAtByProvider(...args),
  getSettings: (...args: unknown[]) => mockGetSettings(...args),
  getSyncState: (...args: unknown[]) => mockGetSyncState(...args),
  saveConversationsBatch: (...args: unknown[]) => mockSaveConversationsBatch(...args),
  setLastFullSyncAt: (...args: unknown[]) => mockSetLastFullSyncAt(...args),
  updateProviderSyncState: (...args: unknown[]) => mockUpdateProviderSyncState(...args),
}));

const mockClaudeSync = vi.fn();
vi.mock("../providers/claude.js", () => ({
  provider: { id: "claude", name: "Claude.ai", sync: (...args: unknown[]) => mockClaudeSync(...args) },
}));

const mockChatgptSync = vi.fn();
vi.mock("../providers/chatgpt.js", () => ({
  provider: { id: "chatgpt", name: "ChatGPT", sync: (...args: unknown[]) => mockChatgptSync(...args) },
}));

const mockGetCloudIdMap = vi.fn().mockResolvedValue(new Map());
vi.mock("../sync/cloud-manifest.js", () => ({
  getCloudIdMap: (...args: unknown[]) => mockGetCloudIdMap(...args),
}));

const mockGetCloudUrl = vi.fn().mockResolvedValue("http://localhost:3000");
vi.mock("../sync/cloud-push.js", () => ({
  getCloudUrl: (...args: unknown[]) => mockGetCloudUrl(...args),
}));

const okResult = () => ({
  conversations: [],
  failedIds: [],
  newCount: 0,
  updatedCount: 0,
  cancelled: false,
  listTruncated: false,
});

describe("sync/engine.ts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mockGetAccessToken.mockResolvedValue(null); // no cloud auth by default
    mockGetConversationCountByProvider.mockResolvedValue(0);
    mockGetKnownUpdatedAtByProvider.mockResolvedValue(new Map());
    // syncWindowDays: null ("All history") by default -- pins every
    // pre-existing test below (written for the cursor/manifest logic, not
    // windowing) to the OLD unbounded behavior so their assertions are
    // unaffected. The "sync window (#120)" describe block below overrides
    // this per-test to exercise the window floor itself.
    mockGetSettings.mockResolvedValue({ enabledProviders: ["claude", "chatgpt"], syncWindowDays: null });
    mockGetSyncState.mockResolvedValue({ providers: {}, lastFullSyncAt: null });
    mockGetCloudIdMap.mockResolvedValue(new Map());
    mockClaudeSync.mockResolvedValue(okResult());
    mockChatgptSync.mockResolvedValue(okResult());
  });

  describe("cursor seeded from the cloud manifest", () => {
    // MAJOR fix (adversarial review, #120): these tests isolate the cursor
    // COMPUTATION (manifest vs local vs wall-clock preference ordering) from
    // the sync-window "unknown coverage" protection, which has its own
    // dedicated tests below ("unknown local coverage (MAJOR fix)"). Each
    // fixture below sets `syncWindowFloorIso: null` explicitly, representing
    // a provider with already-CONFIRMED full/no-floor coverage (e.g. a
    // pre-#120 install, or one that already completed an unknown-coverage
    // cycle) -- WITHOUT that, an empty/undefined `syncWindowFloorIso` plus a
    // non-null manifest/local cursor is exactly the MAJOR bug pattern, and
    // engine.ts would (correctly, post-fix) override sinceTimestamp to the
    // window floor instead of the cursor these tests exist to check.
    it("B1 regression: passes the manifest's max updated_at (not local storage), MINUS the safety overlap, as sinceTimestamp -- even when local lastSyncAt is LATER than the manifest max", async () => {
      mockGetAccessToken.mockResolvedValue("cloud-token");
      mockGetSyncState.mockResolvedValue({
        providers: {
          claude: {
            // Deliberately LATER than the manifest max below -- the pre-fix
            // code took the LATER of the two, so local wall-clock would have
            // won here. It must NOT: the manifest alone governs.
            lastSyncAt: "2024-09-01T00:00:00.000Z",
            lastSyncStatus: "success",
            lastError: null,
            conversationCount: 5,
            syncWindowFloorIso: null, // confirmed full coverage -- see describe comment
          },
        },
        lastFullSyncAt: null,
      });
      mockGetCloudIdMap.mockResolvedValue(
        new Map([
          ["claude:a", "2024-05-01T00:00:00.000Z"],
          ["claude:b", "2024-08-01T00:00:00.000Z"], // max
        ]),
      );

      const { syncOne } = await import("../sync/engine.js");
      await syncOne("claude", () => {});

      expect(mockClaudeSync).toHaveBeenCalledTimes(1);
      const [sinceTimestamp] = mockClaudeSync.mock.calls[0];
      expect(sinceTimestamp).toBe(withOverlap("2024-08-01T00:00:00.000Z"));
    });

    it("MAJOR fix regression: a wiped/reinstalled extension (empty provider state) no longer blindly trusts the manifest cursor -- coverage is UNKNOWN, so this cycle runs widen-style instead", async () => {
      mockGetAccessToken.mockResolvedValue("cloud-token");
      mockGetSyncState.mockResolvedValue({
        providers: {}, // nothing locally -- fresh install / wiped storage / second device
        lastFullSyncAt: null,
      });
      mockGetCloudIdMap.mockResolvedValue(new Map([["claude:a", "2024-05-01T00:00:00.000Z"]]));

      const { syncOne } = await import("../sync/engine.js");
      await syncOne("claude", () => {});

      // Pre-fix, this asserted the manifest cursor (withOverlap("2024-05-01
      // ...")) was used as-is -- exactly the MAJOR bug: `providerState` has
      // no recorded `syncWindowFloorIso` (undefined, not the confirmed
      // `null` the tests above deliberately set), so this device has never
      // verified the manifest's cursor actually reflects full coverage back
      // to the window floor. With `syncWindowDays: null` ("All history", the
      // beforeEach default), the corrected behavior is a full re-list
      // (sinceTimestamp === null) to establish ground truth honestly, not a
      // silent skip past everything older than the manifest's cursor.
      const [sinceTimestamp] = mockClaudeSync.mock.calls[0];
      expect(sinceTimestamp).toBeNull();
    });

    it("degrades to a cursor derived from LOCAL DATA (never lastSyncAt) when there is no cloud auth", async () => {
      mockGetAccessToken.mockResolvedValue(null);
      mockGetSyncState.mockResolvedValue({
        providers: {
          claude: {
            // Deliberately different from (and later than) the local-data
            // max below -- lastSyncAt is wall-clock sync-completion time,
            // not data, and B1's fix means it must never be consulted here.
            lastSyncAt: "2024-09-01T00:00:00.000Z",
            lastSyncStatus: "success",
            lastError: null,
            conversationCount: 5,
            syncWindowFloorIso: null, // confirmed full coverage -- see describe comment
          },
        },
        lastFullSyncAt: null,
      });
      mockGetKnownUpdatedAtByProvider.mockResolvedValue(
        new Map([
          ["a", "2024-02-01T00:00:00.000Z"],
          ["b", "2024-03-01T00:00:00.000Z"], // max local data
        ]),
      );

      const { syncOne } = await import("../sync/engine.js");
      await syncOne("claude", () => {});

      expect(mockGetCloudIdMap).not.toHaveBeenCalled();
      const [sinceTimestamp] = mockClaudeSync.mock.calls[0];
      expect(sinceTimestamp).toBe(withOverlap("2024-03-01T00:00:00.000Z"));
    });

    it("round-2 follow-up fix: token present but manifest empty/unavailable falls back to the LOCAL-DATA-derived max (never null, never re-listing everything)", async () => {
      mockGetAccessToken.mockResolvedValue("cloud-token");
      mockGetSyncState.mockResolvedValue({
        providers: {
          claude: {
            lastSyncAt: "2024-09-01T00:00:00.000Z",
            lastSyncStatus: "success",
            lastError: null,
            conversationCount: 5,
            syncWindowFloorIso: null, // confirmed full coverage -- see describe comment
          },
        },
        lastFullSyncAt: null,
      });
      // Fresh login that never pushed to the cloud yet (or a failed
      // manifest fetch with nothing cached) -- computeCursor returns null
      // here since the manifest has no entries for this provider.
      mockGetCloudIdMap.mockResolvedValue(new Map());
      mockGetKnownUpdatedAtByProvider.mockResolvedValue(
        new Map([
          ["a", "2024-02-01T00:00:00.000Z"],
          ["b", "2024-03-01T00:00:00.000Z"], // max local data
        ]),
      );

      const { syncOne } = await import("../sync/engine.js");
      await syncOne("claude", () => {});

      const [sinceTimestamp] = mockClaudeSync.mock.calls[0];
      expect(sinceTimestamp).toBe(withOverlap("2024-03-01T00:00:00.000Z"));
    });

    it("no cursor yet (true fresh start, no cloud auth, no local data) passes null, not an overlap-adjusted value", async () => {
      mockGetAccessToken.mockResolvedValue(null);
      mockGetSyncState.mockResolvedValue({
        providers: {},
        lastFullSyncAt: null,
      });
      mockGetKnownUpdatedAtByProvider.mockResolvedValue(new Map());

      const { syncOne } = await import("../sync/engine.js");
      await syncOne("claude", () => {});

      const [sinceTimestamp] = mockClaudeSync.mock.calls[0];
      expect(sinceTimestamp).toBeNull();
    });
  });

  describe("forceFull (reconciliation backstop)", () => {
    it("bypasses the cursor entirely -- passes null sinceTimestamp and an empty known map even with manifest + local data", async () => {
      mockGetAccessToken.mockResolvedValue("cloud-token");
      mockGetSyncState.mockResolvedValue({
        providers: {
          claude: {
            lastSyncAt: "2024-03-01T00:00:00.000Z",
            lastSyncStatus: "success",
            lastError: null,
            conversationCount: 5,
          },
        },
        lastFullSyncAt: null,
      });
      mockGetCloudIdMap.mockResolvedValue(new Map([["claude:a", "2024-05-01T00:00:00.000Z"]]));
      mockGetKnownUpdatedAtByProvider.mockResolvedValue(new Map([["a", "2024-05-01T00:00:00.000Z"]]));

      const { syncOne } = await import("../sync/engine.js");
      await syncOne("claude", () => {}, { forceFull: true });

      // forceFull must never even ask the cloud/local for known state.
      expect(mockGetCloudIdMap).not.toHaveBeenCalled();
      expect(mockGetKnownUpdatedAtByProvider).not.toHaveBeenCalled();
      const [sinceTimestamp, , , , known] = mockClaudeSync.mock.calls[0];
      expect(sinceTimestamp).toBeNull();
      expect((known as Map<string, string>).size).toBe(0);
    });
  });

  describe("cancel mechanism", () => {
    it("a cancellation requested while provider A is running stops provider B from ever starting (multi-provider run)", async () => {
      const { syncAll, requestCancel } = await import("../sync/engine.js");
      // Simulate the popup's Cancel button firing mid-way through claude's
      // (provider A, first in enabledProviders) run -- requestCancel() is
      // only meaningful once a run is actually in flight (reset-at-start
      // guards against a STALE cancel from a *previous* run leaking into a
      // fresh one; see the reset test below).
      mockClaudeSync.mockImplementation(async () => {
        requestCancel();
        return okResult();
      });

      const { results } = await syncAll(() => {});

      expect(mockClaudeSync).toHaveBeenCalledTimes(1);
      expect(mockChatgptSync).not.toHaveBeenCalled();
      expect(results.claude).toBeDefined();
      expect(results.chatgpt).toBeUndefined();
    });

    it("a provider that reports cancelled:true does NOT get lastSyncAt advanced (cursor must not skip unlisted pages)", async () => {
      mockClaudeSync.mockResolvedValue({
        conversations: [],
        failedIds: ["c-not-fetched-yet"],
        newCount: 2,
        updatedCount: 0,
        cancelled: true,
        listTruncated: false,
      });

      const { syncOne } = await import("../sync/engine.js");
      const result = await syncOne("claude", () => {});

      expect(result.success).toBe(false);
      expect(result.cancelled).toBe(true);
      const updateCall = mockUpdateProviderSyncState.mock.calls.find(
        ([, updates]) => updates.lastSyncStatus === "cancelled",
      );
      expect(updateCall).toBeDefined();
      const [, updates] = updateCall!;
      expect(updates.lastSyncAt).toBeUndefined();
      expect(updates.failedIds).toEqual(["c-not-fetched-yet"]);
      expect(updates.lastDeltaNew).toBe(2);
    });

    it("M1 regression: cancelling during LISTING (before any per-conversation fetch attempt) preserves the previous failedIds retry queue instead of wiping it", async () => {
      mockGetSyncState.mockResolvedValue({
        providers: {
          claude: {
            lastSyncAt: null,
            lastSyncStatus: "error",
            lastError: null,
            conversationCount: 0,
            failedIds: ["old-1", "old-2"],
          },
        },
        lastFullSyncAt: null,
      });
      // Cancellation during listing -- the per-conversation loop never even
      // started, so result.failedIds is empty even though there IS a
      // pre-existing retry queue from a previous cycle.
      mockClaudeSync.mockResolvedValue({
        conversations: [],
        failedIds: [],
        newCount: 0,
        updatedCount: 0,
        cancelled: true,
        listTruncated: false,
      });

      const { syncOne } = await import("../sync/engine.js");
      await syncOne("claude", () => {});

      const updateCall = mockUpdateProviderSyncState.mock.calls.find(
        ([, updates]) => updates.lastSyncStatus === "cancelled",
      );
      expect(updateCall).toBeDefined();
      const [, updates] = updateCall!;
      expect(updates.failedIds).toEqual(["old-1", "old-2"]);
    });

    it("a cancel flag left over from BEFORE a run starts does not leak in -- the run resets it and proceeds normally", async () => {
      const { syncAll, requestCancel } = await import("../sync/engine.js");
      requestCancel(); // nothing is running yet -- this must not poison the next run

      const { results } = await syncAll(() => {});
      expect(mockClaudeSync).toHaveBeenCalled();
      expect(mockChatgptSync).toHaveBeenCalled();
      expect(results.claude?.success).toBe(true);
      expect(results.chatgpt?.success).toBe(true);
    });
  });

  describe("delta telemetry propagation", () => {
    it("stores newCount/updatedCount from the provider result on updateProviderSyncState", async () => {
      mockClaudeSync.mockResolvedValue({
        conversations: [{}],
        failedIds: [],
        newCount: 3,
        updatedCount: 5,
        cancelled: false,
        listTruncated: false,
      });

      const { syncOne } = await import("../sync/engine.js");
      await syncOne("claude", () => {});

      const successCall = mockUpdateProviderSyncState.mock.calls.find(
        ([, updates]) => updates.lastSyncStatus === "success",
      );
      expect(successCall).toBeDefined();
      const [, updates] = successCall!;
      expect(updates.lastDeltaNew).toBe(3);
      expect(updates.lastDeltaUpdated).toBe(5);
    });
  });

  // Sync window (#120): a first sync used to fetch a provider's ENTIRE
  // history (~10 hours for a large account) -- the default 30-day floor,
  // the cursor+window combination, the widen-backfill override, and
  // persisting the floor actually used.
  describe("sync window (#120)", () => {
    const NOW = new Date("2024-08-31T00:00:00.000Z");
    const daysAgo = (days: number) => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("applies the default 30-day floor on a fresh sync when syncWindowDays is unset", async () => {
      mockGetSettings.mockResolvedValue({ enabledProviders: ["claude", "chatgpt"] }); // no syncWindowDays key
      const { syncOne } = await import("../sync/engine.js");
      await syncOne("claude", () => {});

      const [sinceTimestamp] = mockClaudeSync.mock.calls[0];
      expect(sinceTimestamp).toBe(daysAgo(30));
    });

    it("a MORE RECENT window floor wins over a stale delta cursor (narrow window, old activity)", async () => {
      mockGetSettings.mockResolvedValue({ enabledProviders: ["claude", "chatgpt"], syncWindowDays: 7 });
      mockGetKnownUpdatedAtByProvider.mockResolvedValue(new Map([["a", "2024-01-01T00:00:00.000Z"]]));

      const { syncOne } = await import("../sync/engine.js");
      await syncOne("claude", () => {});

      const [sinceTimestamp] = mockClaudeSync.mock.calls[0];
      expect(sinceTimestamp).toBe(daysAgo(7));
    });

    it("a recent delta cursor wins over a wider window -- steady-state fast delta is preserved", async () => {
      // MAJOR fix (adversarial review): `syncWindowFloorIso` set to the SAME
      // 90-day floor represents an already-CONFIRMED steady state (not an
      // undefined/unknown-coverage first cycle, which is covered separately
      // below and would otherwise override this to the window floor alone).
      mockGetSyncState.mockResolvedValue({
        providers: {
          claude: {
            lastSyncAt: null,
            lastSyncStatus: "success",
            lastError: null,
            conversationCount: 5,
            syncWindowFloorIso: daysAgo(90),
          },
        },
        lastFullSyncAt: null,
      });
      mockGetSettings.mockResolvedValue({ enabledProviders: ["claude", "chatgpt"], syncWindowDays: 90 });
      const recentCursor = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString(); // 1 hour ago
      mockGetKnownUpdatedAtByProvider.mockResolvedValue(new Map([["a", recentCursor]]));

      const { syncOne } = await import("../sync/engine.js");
      await syncOne("claude", () => {});

      const [sinceTimestamp] = mockClaudeSync.mock.calls[0];
      expect(sinceTimestamp).toBe(new Date(new Date(recentCursor).getTime() - CURSOR_OVERLAP_MS).toISOString());
    });

    // Unknown local coverage (MAJOR fix, adversarial review): a reinstall or
    // second device has an EMPTY local provider state (`syncWindowFloorIso`
    // is `undefined` -- never recorded, NOT the confirmed `null` used above)
    // but can still get a non-null delta cursor from the cloud manifest
    // (another device's data). That cursor's "everything before this is
    // already known" assumption has never actually been verified against
    // the window -- the 30-day default makes this the NORMAL case for any
    // reinstall/second device with existing cloud coverage, not an edge
    // case. engine.ts must treat this first cycle as unknown coverage and
    // run it widen-style (sinceTimestamp = the window floor alone), so the
    // floor persisted afterward is actually truthful.
    describe("unknown local coverage (MAJOR fix)", () => {
      it("cloud token + populated manifest + empty provider state + syncWindowDays: null -> sinceTimestamp is null (full re-list), not the manifest cursor", async () => {
        mockGetAccessToken.mockResolvedValue("cloud-token");
        mockGetSyncState.mockResolvedValue({ providers: {}, lastFullSyncAt: null }); // no syncWindowFloorIso recorded
        mockGetSettings.mockResolvedValue({ enabledProviders: ["claude", "chatgpt"], syncWindowDays: null });
        mockGetCloudIdMap.mockResolvedValue(
          new Map([["claude:a", new Date(NOW.getTime() - 60 * 60 * 1000).toISOString()]]), // recent manifest cursor
        );

        const { syncOne } = await import("../sync/engine.js");
        await syncOne("claude", () => {});

        const [sinceTimestamp] = mockClaudeSync.mock.calls[0];
        expect(sinceTimestamp).toBeNull();
      });

      it("cloud token + populated manifest + empty provider state + syncWindowDays: 30 -> sinceTimestamp is the 30-day cutoff, not the manifest cursor", async () => {
        mockGetAccessToken.mockResolvedValue("cloud-token");
        mockGetSyncState.mockResolvedValue({ providers: {}, lastFullSyncAt: null }); // no syncWindowFloorIso recorded
        mockGetSettings.mockResolvedValue({ enabledProviders: ["claude", "chatgpt"], syncWindowDays: 30 });
        mockGetCloudIdMap.mockResolvedValue(
          new Map([["claude:a", new Date(NOW.getTime() - 60 * 60 * 1000).toISOString()]]), // recent manifest cursor
        );

        const { syncOne } = await import("../sync/engine.js");
        await syncOne("claude", () => {});

        const [sinceTimestamp] = mockClaudeSync.mock.calls[0];
        expect(sinceTimestamp).toBe(daysAgo(30));
      });

      it("a truly fresh start (no manifest data either) is unaffected -- combine already reduces to the window floor on its own", async () => {
        mockGetAccessToken.mockResolvedValue("cloud-token");
        mockGetSyncState.mockResolvedValue({ providers: {}, lastFullSyncAt: null });
        mockGetSettings.mockResolvedValue({ enabledProviders: ["claude", "chatgpt"], syncWindowDays: 30 });
        mockGetCloudIdMap.mockResolvedValue(new Map()); // nothing in the manifest either
        mockGetKnownUpdatedAtByProvider.mockResolvedValue(new Map());

        const { syncOne } = await import("../sync/engine.js");
        await syncOne("claude", () => {});

        const [sinceTimestamp] = mockClaudeSync.mock.calls[0];
        expect(sinceTimestamp).toBe(daysAgo(30));
      });

      it("once the floor is confirmed (recorded, non-undefined), the SAME manifest-cursor scenario goes back to normal steady-state combine", async () => {
        mockGetAccessToken.mockResolvedValue("cloud-token");
        mockGetSyncState.mockResolvedValue({
          providers: {
            claude: {
              lastSyncAt: null,
              lastSyncStatus: "success",
              lastError: null,
              conversationCount: 5,
              syncWindowFloorIso: daysAgo(30), // now confirmed -- this is cycle 2, not cycle 1
            },
          },
          lastFullSyncAt: null,
        });
        mockGetSettings.mockResolvedValue({ enabledProviders: ["claude", "chatgpt"], syncWindowDays: 30 });
        const recentCursor = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString();
        mockGetCloudIdMap.mockResolvedValue(new Map([["claude:a", recentCursor]]));

        const { syncOne } = await import("../sync/engine.js");
        await syncOne("claude", () => {});

        const [sinceTimestamp] = mockClaudeSync.mock.calls[0];
        expect(sinceTimestamp).toBe(new Date(new Date(recentCursor).getTime() - CURSOR_OVERLAP_MS).toISOString());
      });
    });

    it("widening 30d -> 90d drops the delta cursor entirely and pages down to the new floor instead", async () => {
      mockGetSyncState.mockResolvedValue({
        providers: {
          claude: {
            lastSyncAt: null,
            lastSyncStatus: "success",
            lastError: null,
            conversationCount: 5,
            syncWindowFloorIso: daysAgo(30),
          },
        },
        lastFullSyncAt: null,
      });
      mockGetSettings.mockResolvedValue({ enabledProviders: ["claude", "chatgpt"], syncWindowDays: 90 });
      // A recent cursor is present -- if it won, pagination would stop almost
      // immediately and never reach the newly-widened 30-90 day range.
      mockGetKnownUpdatedAtByProvider.mockResolvedValue(
        new Map([["a", new Date(NOW.getTime() - 60 * 60 * 1000).toISOString()]]),
      );

      const { syncOne } = await import("../sync/engine.js");
      await syncOne("claude", () => {});

      const [sinceTimestamp] = mockClaudeSync.mock.calls[0];
      expect(sinceTimestamp).toBe(daysAgo(90));
    });

    it("widening to 'All history' passes a null sinceTimestamp, re-listing everything", async () => {
      mockGetSyncState.mockResolvedValue({
        providers: {
          claude: {
            lastSyncAt: null,
            lastSyncStatus: "success",
            lastError: null,
            conversationCount: 5,
            syncWindowFloorIso: daysAgo(30),
          },
        },
        lastFullSyncAt: null,
      });
      mockGetSettings.mockResolvedValue({ enabledProviders: ["claude", "chatgpt"], syncWindowDays: null });
      mockGetKnownUpdatedAtByProvider.mockResolvedValue(
        new Map([["a", new Date(NOW.getTime() - 60 * 60 * 1000).toISOString()]]),
      );

      const { syncOne } = await import("../sync/engine.js");
      await syncOne("claude", () => {});

      const [sinceTimestamp] = mockClaudeSync.mock.calls[0];
      expect(sinceTimestamp).toBeNull();
    });

    it("an UNCHANGED window is not a widen -- normal cursor+window combine applies", async () => {
      mockGetSyncState.mockResolvedValue({
        providers: {
          claude: {
            lastSyncAt: null,
            lastSyncStatus: "success",
            lastError: null,
            conversationCount: 5,
            syncWindowFloorIso: daysAgo(30),
          },
        },
        lastFullSyncAt: null,
      });
      mockGetSettings.mockResolvedValue({ enabledProviders: ["claude", "chatgpt"], syncWindowDays: 30 });
      const recentCursor = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString();
      mockGetKnownUpdatedAtByProvider.mockResolvedValue(new Map([["a", recentCursor]]));

      const { syncOne } = await import("../sync/engine.js");
      await syncOne("claude", () => {});

      const [sinceTimestamp] = mockClaudeSync.mock.calls[0];
      expect(sinceTimestamp).toBe(new Date(new Date(recentCursor).getTime() - CURSOR_OVERLAP_MS).toISOString());
    });

    it("NARROWING the window (90d -> 7d) is not treated as a widen -- no backfill override", async () => {
      mockGetSyncState.mockResolvedValue({
        providers: {
          claude: {
            lastSyncAt: null,
            lastSyncStatus: "success",
            lastError: null,
            conversationCount: 5,
            syncWindowFloorIso: daysAgo(90),
          },
        },
        lastFullSyncAt: null,
      });
      mockGetSettings.mockResolvedValue({ enabledProviders: ["claude", "chatgpt"], syncWindowDays: 7 });
      mockGetKnownUpdatedAtByProvider.mockResolvedValue(new Map());

      const { syncOne } = await import("../sync/engine.js");
      await syncOne("claude", () => {});

      const [sinceTimestamp] = mockClaudeSync.mock.calls[0];
      expect(sinceTimestamp).toBe(daysAgo(7));
    });

    it("persists the window floor actually used after a successful cycle", async () => {
      mockGetSettings.mockResolvedValue({ enabledProviders: ["claude", "chatgpt"], syncWindowDays: 30 });

      const { syncOne } = await import("../sync/engine.js");
      await syncOne("claude", () => {});

      const successCall = mockUpdateProviderSyncState.mock.calls.find(
        ([, updates]) => updates.lastSyncStatus === "success",
      );
      expect(successCall).toBeDefined();
      const [, updates] = successCall!;
      expect(updates.syncWindowFloorIso).toBe(daysAgo(30));
    });

    it("persists a null floor when the window is 'All history'", async () => {
      mockGetSettings.mockResolvedValue({ enabledProviders: ["claude", "chatgpt"], syncWindowDays: null });

      const { syncOne } = await import("../sync/engine.js");
      await syncOne("claude", () => {});

      const successCall = mockUpdateProviderSyncState.mock.calls.find(
        ([, updates]) => updates.lastSyncStatus === "success",
      );
      const [, updates] = successCall!;
      expect(updates.syncWindowFloorIso).toBeNull();
    });

    it("does NOT advance the window floor when the cycle is cancelled", async () => {
      mockGetSettings.mockResolvedValue({ enabledProviders: ["claude", "chatgpt"], syncWindowDays: 30 });
      mockClaudeSync.mockResolvedValue({
        conversations: [],
        failedIds: [],
        newCount: 0,
        updatedCount: 0,
        cancelled: true,
        listTruncated: false,
      });

      const { syncOne } = await import("../sync/engine.js");
      await syncOne("claude", () => {});

      const cancelCall = mockUpdateProviderSyncState.mock.calls.find(
        ([, updates]) => updates.lastSyncStatus === "cancelled",
      );
      expect(cancelCall).toBeDefined();
      const [, updates] = cancelCall!;
      expect(updates.syncWindowFloorIso).toBeUndefined();
    });

    it("test gap (b): does NOT advance (or even attempt to persist) the window floor when the provider throws", async () => {
      mockGetSettings.mockResolvedValue({ enabledProviders: ["claude", "chatgpt"], syncWindowDays: 30 });
      mockClaudeSync.mockRejectedValue(new Error("network error"));

      const { syncOne } = await import("../sync/engine.js");
      const result = await syncOne("claude", () => {});

      expect(result.success).toBe(false);
      const errorCall = mockUpdateProviderSyncState.mock.calls.find(
        ([, updates]) => updates.lastSyncStatus === "error",
      );
      expect(errorCall).toBeDefined();
      const [, updates] = errorCall!;
      // The error-path update call doesn't even include lastSyncAt/failedIds/
      // delta telemetry fields, let alone syncWindowFloorIso -- confirms the
      // catch block never reaches the success-path update that would
      // persist it.
      expect(updates.syncWindowFloorIso).toBeUndefined();
      expect(updates.lastSyncAt).toBeUndefined();
    });

    it("NOTE fix (adversarial review): a listing truncated by the page-count guard does NOT advance the window floor, even on an otherwise-successful cycle", async () => {
      mockGetSettings.mockResolvedValue({ enabledProviders: ["claude", "chatgpt"], syncWindowDays: 30 });
      mockClaudeSync.mockResolvedValue({
        conversations: [{ source: "claude", source_id: "a" }],
        failedIds: [],
        newCount: 1,
        updatedCount: 0,
        cancelled: false,
        listTruncated: true, // MAX_LIST_PAGES fired mid-listing
      });

      const { syncOne } = await import("../sync/engine.js");
      const result = await syncOne("claude", () => {});

      expect(result.success).toBe(true); // the cycle itself still succeeds
      const successCall = mockUpdateProviderSyncState.mock.calls.find(
        ([, updates]) => updates.lastSyncStatus === "success",
      );
      expect(successCall).toBeDefined();
      const [, updates] = successCall!;
      // The floor is NOT recorded as achieved -- listing never confirmed it
      // actually reached the requested cutoff, so the next cycle must
      // re-attempt from the same starting point rather than trust a floor
      // that was never actually verified.
      expect(updates.syncWindowFloorIso).toBeUndefined();
    });

    it("test gap (c): a widen cycle that gets cancelled does NOT persist the new floor, so the NEXT cycle re-detects the same widen and completes it", async () => {
      // Cycle 1: widen 30d -> 90d, but it gets cancelled mid-listing.
      mockGetSyncState.mockResolvedValue({
        providers: {
          claude: {
            lastSyncAt: null,
            lastSyncStatus: "success",
            lastError: null,
            conversationCount: 5,
            syncWindowFloorIso: daysAgo(30),
          },
        },
        lastFullSyncAt: null,
      });
      mockGetSettings.mockResolvedValue({ enabledProviders: ["claude", "chatgpt"], syncWindowDays: 90 });
      mockClaudeSync.mockResolvedValueOnce({
        conversations: [],
        failedIds: ["c-not-fetched-yet"],
        newCount: 0,
        updatedCount: 0,
        cancelled: true,
        listTruncated: false,
      });

      const { syncOne } = await import("../sync/engine.js");
      const cycle1 = await syncOne("claude", () => {});

      expect(cycle1.cancelled).toBe(true);
      const [cycle1Since] = mockClaudeSync.mock.calls[0];
      expect(cycle1Since).toBe(daysAgo(90)); // widen-style: cursor dropped, paged to the new floor
      const cycle1Cancel = mockUpdateProviderSyncState.mock.calls.find(
        ([, updates]) => updates.lastSyncStatus === "cancelled",
      );
      expect(cycle1Cancel![1].syncWindowFloorIso).toBeUndefined(); // NOT persisted -- widen never confirmed complete

      // Cycle 2: nothing else changed (still stored at the 30-day floor from
      // before cycle 1, since it was never advanced) -- the SAME widen must
      // be re-detected, not silently skipped now that a cycle already
      // "tried."
      mockUpdateProviderSyncState.mockClear();
      mockClaudeSync.mockResolvedValueOnce({
        conversations: [],
        failedIds: [],
        newCount: 0,
        updatedCount: 0,
        cancelled: false,
        listTruncated: false,
      });

      const cycle2 = await syncOne("claude", () => {});

      expect(cycle2.success).toBe(true);
      const [cycle2Since] = mockClaudeSync.mock.calls[1];
      expect(cycle2Since).toBe(daysAgo(90)); // widen re-detected on cycle 2 too
      const cycle2Success = mockUpdateProviderSyncState.mock.calls.find(
        ([, updates]) => updates.lastSyncStatus === "success",
      );
      // This time it completes (not cancelled, not truncated) -- the floor
      // IS persisted, closing out the widen.
      expect(cycle2Success![1].syncWindowFloorIso).toBe(daysAgo(90));
    });

    it("forceFull bypasses the window entirely (unchanged reconciliation-backstop behavior) and leaves the stored floor untouched", async () => {
      mockGetSettings.mockResolvedValue({ enabledProviders: ["claude", "chatgpt"], syncWindowDays: 30 });

      const { syncOne } = await import("../sync/engine.js");
      await syncOne("claude", () => {}, { forceFull: true });

      const [sinceTimestamp] = mockClaudeSync.mock.calls[0];
      expect(sinceTimestamp).toBeNull();
      const successCall = mockUpdateProviderSyncState.mock.calls.find(
        ([, updates]) => updates.lastSyncStatus === "success",
      );
      const [, updates] = successCall!;
      expect(updates.syncWindowFloorIso).toBeUndefined();
    });
  });

  describe("syncLock / concurrency (N2 fix)", () => {
    it("syncOne refuses to run while another sync is already in progress, instead of running concurrently or resetting the in-flight cancel flag", async () => {
      const { syncOne } = await import("../sync/engine.js");

      const firstCall = syncOne("claude", () => {});
      const secondResult = await syncOne("chatgpt", () => {});

      expect(secondResult.error).toBe("Sync already in progress");
      expect(mockChatgptSync).not.toHaveBeenCalled();

      await firstCall;
      expect(mockClaudeSync).toHaveBeenCalledTimes(1);
    });
  });
});
