import { beforeEach, describe, expect, it, vi } from "vitest";

// #134 adversarial review round 3/4: "redesign the refusal so these four
// cases are each covered by a test and provably hold" —
//   (1) existing email/password user linking Google during a closed
//       window -> admitted (route.test.ts covers this one directly, via
//       the identities-based guard in route.ts itself — see the
//       "R3: an existing non-Google identity is never blocked" test
//       there).
//   (2) Google-only user created BEFORE the window -> admitted
//   (3) first new Google-only user after the flip -> refused, and refused
//       again on retry
//   (4) a second, later window -> users created between the windows are
//       admitted
//
// (2)-(4) are proven here against the ACTUAL exported functions
// (ensureSignupsDisabledMarker / wasCreatedWhileSignupsDisabled) driving a
// small STATEFUL in-memory fake of the app_settings table — not by mocking
// the module's own decision, as route.test.ts does for its own (different)
// purposes. The fake's `updated_at` is produced by a controllable fake
// clock standing in for Postgres's `default now()`, so "DB-side timestamp"
// is exercised as designed (R3-m1) without relying on real wall-clock
// timing in a test.
//
// R4-M2: the app-side clear was removed entirely — only
// scripts/flags.ts's `signups on` clears the marker now (see that file
// and lib/signups-disabled-marker.ts's own module comment for why). This
// file cannot literally invoke that standalone CLI script, so
// operatorSignupsOn()/operatorSignupsOff() below replicate its exact
// app_settings operations (upsert-ignoreDuplicates for `off`, delete for
// `on` — see scripts/flags.ts's `signups()`) against the SAME fake table
// the app-side functions use, to prove case (4) is driven by the
// operator's tool, not by app traffic observing the switch go off.

let dbNow = new Date("2026-09-01T00:00:00.000Z");
function advanceTo(iso: string) {
  dbNow = new Date(iso);
}

interface Row {
  value: unknown;
  updated_at: string;
}

function makeFakeAppSettings() {
  const rows = new Map<string, Row>();
  return {
    _rows: rows,
    from: (table: string) => {
      if (table !== "app_settings") throw new Error(`unexpected table ${table}`);
      return {
        upsert: (payload: { key: string; value: unknown }, opts: { ignoreDuplicates?: boolean }) => ({
          select: (_cols: string) => {
            const existing = rows.get(payload.key);
            if (existing && opts.ignoreDuplicates) {
              // ON CONFLICT (key) DO NOTHING -> RETURNING yields no rows,
              // and critically the existing row (its updated_at included)
              // is left completely untouched.
              return Promise.resolve({ data: [], error: null });
            }
            const row: Row = { value: payload.value, updated_at: dbNow.toISOString() };
            rows.set(payload.key, row);
            return Promise.resolve({ data: [{ updated_at: row.updated_at }], error: null });
          },
        }),
        select: (_cols: string) => ({
          eq: (_col: string, key: string) => ({
            maybeSingle: () => {
              const row = rows.get(key);
              return Promise.resolve({ data: row ? { updated_at: row.updated_at } : null, error: null });
            },
          }),
        }),
        update: (payload: { updated_at: string }) => ({
          eq: (_col: string, key: string) => {
            const existing = rows.get(key);
            if (existing) rows.set(key, { ...existing, updated_at: payload.updated_at });
            return Promise.resolve({ error: null });
          },
        }),
        delete: () => ({
          eq: (_col: string, key: string) => {
            rows.delete(key);
            return Promise.resolve({ error: null });
          },
        }),
      };
    },
  };
}

let fakeDb: ReturnType<typeof makeFakeAppSettings>;

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => fakeDb),
}));

// Mirrors scripts/flags.ts's `signups off` — an upsert-if-absent, same
// shape as the app's own ensureSignupsDisabledMarker(). Kept as a separate
// helper (rather than just calling ensureSignupsDisabledMarker()) so each
// test reads as "the operator ran this command", matching case (4)'s
// brief.
function operatorSignupsOff() {
  return fakeDb
    .from("app_settings")
    .upsert({ key: "signups_disabled_at", value: true }, { ignoreDuplicates: true })
    .select("updated_at");
}

// Mirrors scripts/flags.ts's `signups on` — the ONLY thing that clears the
// marker after R4-M2 (the app itself never does).
function operatorSignupsOn() {
  return fakeDb.from("app_settings").delete().eq("key", "signups_disabled_at");
}

describe("signups-disabled-marker — full incident lifecycle (R3-B1, R3-M1, R4-M1, R4-M2)", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://x.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";
    fakeDb = makeFakeAppSettings();
    dbNow = new Date("2026-09-01T00:00:00.000Z");
  });

  it("(2) a Google-only user created BEFORE the window is admitted", async () => {
    const { ensureSignupsDisabledMarker, wasCreatedWhileSignupsDisabled } = await import("../signups-disabled-marker");

    // A Google-only user signed up normally, well before any incident.
    const preIncidentUser = { created_at: "2026-08-01T00:00:00.000Z" };

    // Incident starts: someone (signInWithGoogle(), signup(), or the
    // callback) observes the switch ON and eagerly stamps the marker.
    advanceTo("2026-09-01T12:00:00.000Z");
    await ensureSignupsDisabledMarker();

    // That same pre-existing user later clicks "Continue with Google"
    // during the incident.
    expect(await wasCreatedWhileSignupsDisabled(preIncidentUser.created_at)).toBe(false);
  });

  it(
    "(3) the FIRST new Google-only user after the flip is refused, and refused again on retry — " +
      "closes R3-M1 (GoTrue creates the row before this app ever sees a code) via eager stamping " +
      "at signInWithGoogle()-time, simulated here as the marker already existing by the time the row is created",
    async () => {
      const { ensureSignupsDisabledMarker, wasCreatedWhileSignupsDisabled } = await import(
        "../signups-disabled-marker"
      );

      // signInWithGoogle() observes the switch ON and stamps the marker
      // BEFORE redirecting to Google — i.e. before GoTrue can create any
      // row for this click.
      advanceTo("2026-09-08T12:00:00.000Z");
      await ensureSignupsDisabledMarker();

      // GoTrue creates the brand-new auth.users row a moment later, during
      // its own callback hop with Google.
      const newUser = { created_at: "2026-09-08T12:00:00.400Z" };

      expect(await wasCreatedWhileSignupsDisabled(newUser.created_at)).toBe(true); // first attempt
      expect(await wasCreatedWhileSignupsDisabled(newUser.created_at)).toBe(true); // retry — still refused
    },
  );

  it(
    "(3b)/(3c) R3-M1's residual race: NOBODY stamped the marker before the row was created (a direct GoTrue " +
      "call that skipped signInWithGoogle() entirely) — the callback's own upsert is the first ever, blocks " +
      "unconditionally rather than trusting a same-request timestamp comparison, AND (R4-M1) back-dates the " +
      "marker to the offending row so a RETRY is refused too, not admitted by the marker's own late stamp",
    async () => {
      const { wasCreatedWhileSignupsDisabled } = await import("../signups-disabled-marker");

      advanceTo("2026-09-08T12:00:10.400Z");
      const newUser = { created_at: "2026-09-08T12:00:10.000Z" }; // predates the marker THIS call creates

      expect(await wasCreatedWhileSignupsDisabled(newUser.created_at)).toBe(true); // attempt 1

      // Real time moves on before the retry — proving this isn't just
      // "still within the same call", but that the PERSISTED marker was
      // actually rewritten to newUser.created_at (R4-M1's back-date).
      advanceTo("2026-09-08T12:05:00.000Z");
      expect(await wasCreatedWhileSignupsDisabled(newUser.created_at)).toBe(true); // attempt 2 (retry)
      expect(fakeDb._rows.get("signups_disabled_at")?.updated_at).toBe(newUser.created_at);
    },
  );

  it(
    "(4) a second, later window driven by the OPERATOR's tool (scripts/flags.ts signups off/on), not by app " +
      "traffic observing the switch — users created BETWEEN the two incidents are admitted, not caught by the " +
      "first incident's stale marker (R4-M2: the app itself never clears)",
    async () => {
      const { wasCreatedWhileSignupsDisabled } = await import("../signups-disabled-marker");

      // --- Operator runs `signups off` — incident 1 starts ---
      advanceTo("2026-09-01T00:00:00.000Z");
      await operatorSignupsOff();
      const attacker1 = { created_at: "2026-09-01T00:00:05.000Z" };
      expect(await wasCreatedWhileSignupsDisabled(attacker1.created_at)).toBe(true);

      // --- Operator runs `signups on` — incident 1 ends, marker cleared ---
      advanceTo("2026-09-01T06:00:00.000Z");
      await operatorSignupsOn();
      expect(fakeDb._rows.has("signups_disabled_at")).toBe(false);

      // --- Day 2 (signups open): a legitimate signup, Google-only ---
      const day2User = { created_at: "2026-09-03T00:00:00.000Z" };

      // --- Operator runs `signups off` again, 30 days later — incident 2 starts ---
      advanceTo("2026-10-01T00:00:00.000Z");
      await operatorSignupsOff();

      // The day-2 user (created between the two incidents) must be
      // admitted — R3-B1's exact failure mode was refusing this user
      // because incident 1's marker was still in effect.
      expect(await wasCreatedWhileSignupsDisabled(day2User.created_at)).toBe(false);

      // A genuinely new attacker during incident 2 is still refused.
      const attacker2 = { created_at: "2026-10-01T00:00:05.000Z" };
      expect(await wasCreatedWhileSignupsDisabled(attacker2.created_at)).toBe(true);

      // The incident-1 attacker's row now predates incident 2's (reset)
      // marker too, so this mechanism admits them again — matching this
      // whole design's own stated philosophy (route.ts: "reversible... a
      // maintainer flipping the switch back on can just let the person log
      // in again", never delete-on-refusal). This marker is a per-incident
      // GATE, not a permanent blacklist; a row a maintainer actually wants
      // gone stays their call, made from the console.error trail, same as
      // for the very first incident's refusal.
      expect(await wasCreatedWhileSignupsDisabled(attacker1.created_at)).toBe(false);
    },
  );

  // ---- R4-M2 regression: no app-side path clears the marker ----

  it(
    "R4-M2: a full incident that only the APP observes (never the operator's tool) never clears its own " +
      "marker — proves there is no app-side delete path left to accidentally reopen a window",
    async () => {
      const { ensureSignupsDisabledMarker, wasCreatedWhileSignupsDisabled } = await import(
        "../signups-disabled-marker"
      );

      advanceTo("2026-09-01T00:00:00.000Z");
      await ensureSignupsDisabledMarker(); // e.g. signInWithGoogle() observing the switch ON
      expect(fakeDb._rows.has("signups_disabled_at")).toBe(true);

      // The switch reads OFF on some later request (e.g. a stale
      // deployment, or the real incident just ending) — nothing in the
      // app's own exported surface can act on that to clear the marker;
      // only calling ensureSignupsDisabledMarker() again (still just an
      // upsert-if-absent) is possible, and it's a no-op against an
      // existing row.
      await ensureSignupsDisabledMarker();
      expect(fakeDb._rows.has("signups_disabled_at")).toBe(true);

      const stillWithinIncident = { created_at: "2026-09-01T00:00:05.000Z" };
      expect(await wasCreatedWhileSignupsDisabled(stillWithinIncident.created_at)).toBe(true);
    },
  );
});
