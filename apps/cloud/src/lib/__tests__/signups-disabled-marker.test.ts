import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// #134 adversarial review round 2/3/4: this module exists to make the
// MEMBRAL_SIGNUPS_DISABLED Google sign-in refusal RETRY-PROOF (R2-B1),
// correctly WINDOWED per-incident (R3-B1/R4-M2: only
// scripts/flags.ts's `signups on` ever clears the marker now — the app
// only ever stamps), and correct against the FIRST-OBSERVER race (R3-M1:
// stamped before the row it's meant to catch can exist on the main path;
// R4-M1: when the callback itself is the first observer, the marker it
// creates is back-dated to the offending row so a retry stays refused).
// These tests exercise that directly against a mocked Postgres table
// (in-memory call recording), rather than mocking the exported functions
// themselves the way route.test.ts/actions.test.ts do for their own
// purposes.

const mockUpsertSelect = vi.fn(); // .upsert(...).select("updated_at") -> { data, error }
const mockSelectMaybeSingle = vi.fn(); // .select("updated_at").eq(...).maybeSingle() -> { data, error }
const mockUpdateEq = vi.fn(); // .update({ updated_at }).eq(...) -> { error }

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    from: vi.fn(() => ({
      upsert: vi.fn(() => ({ select: mockUpsertSelect })),
      select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: mockSelectMaybeSingle })) })),
      update: vi.fn(() => ({ eq: mockUpdateEq })),
    })),
  })),
}));

describe("signups-disabled-marker", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env = {
      ...originalEnv,
      NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "svc",
    };
    mockUpdateEq.mockResolvedValue({ error: null });
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("wasCreatedWhileSignupsDisabled", () => {
    it("does not block a row created before a PRE-EXISTING marker (upsert conflicts, select reads the real value)", async () => {
      mockUpsertSelect.mockResolvedValue({ data: [], error: null }); // conflict: nothing inserted
      mockSelectMaybeSingle.mockResolvedValue({ data: { updated_at: "2026-09-08T12:00:00.000Z" }, error: null });
      const { wasCreatedWhileSignupsDisabled } = await import("../signups-disabled-marker");

      expect(await wasCreatedWhileSignupsDisabled("2026-01-01T00:00:00.000Z")).toBe(false);
    });

    it("blocks a row created on/after a PRE-EXISTING marker", async () => {
      mockUpsertSelect.mockResolvedValue({ data: [], error: null });
      mockSelectMaybeSingle.mockResolvedValue({ data: { updated_at: "2026-09-08T12:00:00.000Z" }, error: null });
      const { wasCreatedWhileSignupsDisabled } = await import("../signups-disabled-marker");

      expect(await wasCreatedWhileSignupsDisabled("2026-09-08T12:00:00.500Z")).toBe(true);
    });

    // ---- R3-M1 / R4-M1: the marker didn't exist yet — THIS call created it ----

    it(
      "R3-M1: blocks unconditionally when THIS call is the one that inserted the marker — a row that predates a " +
        "marker this call had to create is exactly the case being defended against, timestamps aside",
      async () => {
        // upsert().select() returns the INSERTED row (non-empty) -> we won the race, no prior marker existed.
        mockUpsertSelect.mockResolvedValue({ data: [{ updated_at: "2026-09-08T12:00:10.400Z" }], error: null });
        const { wasCreatedWhileSignupsDisabled } = await import("../signups-disabled-marker");

        // the row was created BEFORE the marker this call just stamped —
        // exactly R3-M1's race (GoTrue creates the row before this route
        // runs) — and it must still block.
        expect(await wasCreatedWhileSignupsDisabled("2026-09-08T12:00:10.000Z")).toBe(true);
        expect(mockSelectMaybeSingle).not.toHaveBeenCalled(); // no need to re-read what we just inserted
      },
    );

    it(
      "R4-M1: back-dates the just-inserted marker to the offending row's created_at (never later than what's " +
        "there), and a RETRY is refused too — closing the hole where attempt 1's refusal admitted attempt 2",
      async () => {
        mockUpsertSelect.mockResolvedValue({ data: [{ updated_at: "2026-09-08T12:00:10.400Z" }], error: null });
        const { wasCreatedWhileSignupsDisabled } = await import("../signups-disabled-marker");

        const offendingCreatedAt = "2026-09-08T12:00:10.000Z"; // predates the marker THIS call just stamped

        // attempt 1: justInserted -> blocked, AND back-dates the marker.
        expect(await wasCreatedWhileSignupsDisabled(offendingCreatedAt)).toBe(true);
        expect(mockUpdateEq).toHaveBeenCalledTimes(1);
        expect(mockUpdateEq).toHaveBeenCalledWith("key", "signups_disabled_at");

        // attempt 2 (retry): the marker no longer exists as "just inserted"
        // — it's a pre-existing row now, back-dated to offendingCreatedAt —
        // so this exercises the PLAIN comparison path, not justInserted.
        mockUpsertSelect.mockResolvedValue({ data: [], error: null }); // conflict this time
        mockSelectMaybeSingle.mockResolvedValue({ data: { updated_at: offendingCreatedAt }, error: null });
        expect(await wasCreatedWhileSignupsDisabled(offendingCreatedAt)).toBe(true);
      },
    );

    it("R4-M1: never moves the marker LATER — a back-date is skipped when created_at is already >= the marker", async () => {
      mockUpsertSelect.mockResolvedValue({ data: [{ updated_at: "2026-09-08T12:00:10.400Z" }], error: null });
      const { wasCreatedWhileSignupsDisabled } = await import("../signups-disabled-marker");

      // Not the R4-M1 race — created_at is AFTER the marker this call
      // stamped (a genuinely new attacker showing up after the marker
      // already existed would never hit justInserted at all in practice,
      // but this proves the back-date guard itself is a true `least()`,
      // not an unconditional overwrite).
      await wasCreatedWhileSignupsDisabled("2026-09-08T12:00:20.000Z");
      expect(mockUpdateEq).not.toHaveBeenCalled();
    });

    it("fails closed (blocks) when no service-role client is configured", async () => {
      process.env = { ...originalEnv };
      delete process.env.SUPABASE_SERVICE_ROLE_KEY;
      delete process.env.NEXT_PUBLIC_SUPABASE_URL;
      const { wasCreatedWhileSignupsDisabled } = await import("../signups-disabled-marker");

      expect(await wasCreatedWhileSignupsDisabled(new Date().toISOString())).toBe(true);
      expect(mockUpsertSelect).not.toHaveBeenCalled();
    });

    it("fails closed (blocks) when the upsert errors", async () => {
      mockUpsertSelect.mockResolvedValue({ data: null, error: { message: "connection refused" } });
      const { wasCreatedWhileSignupsDisabled } = await import("../signups-disabled-marker");

      expect(await wasCreatedWhileSignupsDisabled(new Date().toISOString())).toBe(true);
    });

    it("fails closed (blocks) when the select-on-conflict errors or returns no row", async () => {
      mockUpsertSelect.mockResolvedValue({ data: [], error: null });
      mockSelectMaybeSingle.mockResolvedValue({ data: null, error: null });
      const { wasCreatedWhileSignupsDisabled } = await import("../signups-disabled-marker");

      expect(await wasCreatedWhileSignupsDisabled(new Date().toISOString())).toBe(true);
    });
  });

  // ---- R4-M2: the app only ever STAMPS; nothing here clears ----

  describe("ensureSignupsDisabledMarker", () => {
    it("ensures (upserts) the marker", async () => {
      mockUpsertSelect.mockResolvedValue({ data: [{ updated_at: "2026-09-08T12:00:00.000Z" }], error: null });
      const { ensureSignupsDisabledMarker } = await import("../signups-disabled-marker");

      await ensureSignupsDisabledMarker();

      expect(mockUpsertSelect).toHaveBeenCalledTimes(1);
    });

    it("R4-M2: exports nothing that deletes the marker — clearing is scripts/flags.ts's `signups on` alone", async () => {
      const marker = await import("../signups-disabled-marker");

      expect((marker as Record<string, unknown>).clearSignupsDisabledMarker).toBeUndefined();
      expect((marker as Record<string, unknown>).syncSignupsDisabledMarker).toBeUndefined();
    });

    it("no-ops safely without a service-role client", async () => {
      process.env = { ...originalEnv };
      delete process.env.SUPABASE_SERVICE_ROLE_KEY;
      delete process.env.NEXT_PUBLIC_SUPABASE_URL;
      const { ensureSignupsDisabledMarker } = await import("../signups-disabled-marker");

      await expect(ensureSignupsDisabledMarker()).resolves.toBeUndefined();
      expect(mockUpsertSelect).not.toHaveBeenCalled();
    });
  });
});
