import { tryServiceClient } from "@/lib/db/clients";
import type { Db } from "@/lib/db/types";
import { SERVICE_ROLE_KEY_ENV } from "./env";
import { log } from "./log";

// #134 adversarial review rounds 2-4, BLOCKER R2-B1 / R3-B1 / MAJOR R3-M1 /
// MAJOR R4-M1 / MAJOR R4-M2.
//
// MEMBRAL_SIGNUPS_DISABLED (lib/env.ts's signupsDisabled()) is the
// app-level emergency kill-switch — a Vercel env var, invisible to
// Supabase/GoTrue. It has no DB backing of its own, unlike migration 079's
// app_settings.signups_disabled row, which blocks the auth.users INSERT
// atomically for every path via a BEFORE INSERT trigger (see that
// migration's own comment). For Google sign-in specifically, GoTrue
// creates the auth.users row and links the identity during its OWN
// /auth/v1/callback hop with Google, BEFORE this app is ever handed a
// `code` to exchange — so by the time app/auth/callback/route.ts runs, the
// row already exists no matter what MEMBRAL_SIGNUPS_DISABLED says. The
// most this app can do for that env-only switch is react AFTER the fact
// (sign the just-created session back out).
//
// Round 1's version inferred "was this row just created" from timing
// (`created_at` near `last_sign_in_at`) — not retry-proof (round 2, R2-B1).
// Round 2's replacement persisted a `signups_disabled_at` marker but wrote
// it LAZILY and never cleared it (round 3: R3-M1, R3-B1). Round 3's fix —
// eager stamping from every observer, plus an app-side clear on observing
// the switch OFF — closed the main path but round 4 found two more edges
// in the same seam:
//   - R4-M1: when the CALLBACK ITSELF is the first thing to ever observe
//     the switch (a direct GoTrue call that skips signInWithGoogle()
//     entirely, or a flip landing in the narrow gap between
//     signInWithGoogle() running and the callback running), its own
//     upsert stamps the marker — but that stamp is necessarily LATER than
//     the row it was meant to catch (GoTrue created that row during its
//     own hop, before this callback ever ran). Attempt 1 is refused
//     (`justInserted` — see wasCreatedWhileSignupsDisabled below); on
//     attempt 2 `justInserted` is false, the plain timestamp comparison
//     runs, and `created_at < marker` admits the same attacker. Fixed by
//     BACK-DATING the marker to the offending row's `created_at` (never
//     later than what's already there) the moment this happens, so the
//     retry sees `created_at >= marker` too.
//   - R4-M2: the app-side clear (any of the three observe-sites deleting
//     the marker on seeing the switch OFF) is deployment-local state
//     deciding shared state's fate. MEMBRAL_SIGNUPS_DISABLED is read
//     per-deployment on Vercel — flipping it in the dashboard does not
//     retroactively touch already-running deployments (a stale production
//     deployment, or any preview/branch deployment, keeps its OLD value
//     until it's redeployed), and every deployment shares this project's
//     one Supabase instance. One request to ANY stale deployment that
//     still reads the switch as off deletes the marker every OTHER
//     deployment is relying on, silently reopening the incident window
//     mid-incident. Fixed by removing the app-side clear entirely: this
//     module no longer exports anything that deletes the marker.
//     `apps/cloud/scripts/flags.ts`'s `signups on` is now the ONLY thing
//     that clears it — a human running one explicit command against one
//     canonical Supabase project, not per-deployment env-var drift.
//
// Current design:
//   - ensureSignupsDisabledMarker() is called from every place that
//     OBSERVES MEMBRAL_SIGNUPS_DISABLED reading `true` — (auth)/actions.ts's
//     signup() and signInWithGoogle() (the latter BEFORE redirecting to
//     Google, closing R3-M1's main path — the marker predates anything
//     GoTrue creates for that click), and this route's own callback. It
//     ONLY ever stamps (insert-if-absent); nothing in the app ever clears.
//   - wasCreatedWhileSignupsDisabled() is the callback's block decision.
//     When its own call is the one that inserted the marker (R4-M1), it
//     back-dates that marker to the offending row's created_at before
//     returning "blocked", so a retry is refused on the SAME grounds.
//   - `apps/cloud/scripts/flags.ts`'s `signups on|off` sets/clears the
//     SAME app_settings key alongside `signups_disabled` — the
//     deterministic, deployment-independent lifecycle owner. `off` stamps
//     (matching ensureSignupsDisabledMarker's own upsert shape); `on` is
//     the ONLY delete.
//
// The marker's timestamp is Postgres's own `app_settings.updated_at
// default now()` (read back via RETURNING on insert, or a plain SELECT on
// conflict) — never `new Date()` in this Node process (R3-m1) — so it's
// compared against `auth.users.created_at` using ONE clock.
let cachedServiceClient: Db | null = null;

function getServiceSupabase(): Db | null {
  if (cachedServiceClient) return cachedServiceClient;
  const client = tryServiceClient();
  if (!client) {
    log.warn(`signups-disabled-marker: ${SERVICE_ROLE_KEY_ENV}/NEXT_PUBLIC_SUPABASE_URL not set`);
    return null;
  }
  cachedServiceClient = client;
  return cachedServiceClient;
}

const MARKER_KEY = "signups_disabled_at";

interface EnsureResult {
  /** DB-stamped (`app_settings.updated_at`) marker timestamp, or `null` if it couldn't be determined at all. */
  markerIso: string | null;
  /** True when THIS call's upsert is what inserted the row (no marker existed a moment ago). */
  justInserted: boolean;
}

/**
 * Insert-if-absent (`ON CONFLICT (key) DO NOTHING`, via `ignoreDuplicates`)
 * and report both the persisted marker timestamp AND whether this specific
 * call is the one that created it. `markerIso: null` means "couldn't
 * determine at all" (no service-role client configured, or the round trip
 * failed) — callers must fail closed on that per this module's header.
 */
async function ensureMarker(): Promise<EnsureResult> {
  const supabase = getServiceSupabase();
  if (!supabase) return { markerIso: null, justInserted: false };

  const { data: inserted, error: insertError } = await supabase
    .from("app_settings")
    .upsert({ key: MARKER_KEY, value: true }, { onConflict: "key", ignoreDuplicates: true })
    .select("updated_at");
  if (insertError) {
    log.warn("signups-disabled-marker: upsert failed", { err: insertError.message });
    return { markerIso: null, justInserted: false };
  }
  if (inserted && inserted.length > 0) {
    return { markerIso: (inserted[0] as { updated_at: string }).updated_at, justInserted: true };
  }

  // Someone else's upsert won the race (or a past request already created
  // it) — read back the SAME persisted row rather than trusting our own
  // insert attempt's absence of a return value.
  const { data, error: selectError } = await supabase
    .from("app_settings")
    .select("updated_at")
    .eq("key", MARKER_KEY)
    .maybeSingle();
  if (selectError || !data) {
    log.warn("signups-disabled-marker: select failed", { err: selectError?.message ?? "no row" });
    return { markerIso: null, justInserted: false };
  }
  return { markerIso: (data as { updated_at: string }).updated_at, justInserted: false };
}

/**
 * R4-M1: back-dates the persisted marker to `createdAtIso` — but only if
 * that's actually EARLIER than what's there (`least()` semantics; never
 * moves the marker later). Called only when THIS call's own upsert just
 * created the marker (see wasCreatedWhileSignupsDisabled below), so the
 * offending row's `created_at` becomes the marker going forward and a
 * retry is refused on the same grounds instead of quietly admitting it.
 */
async function backDateMarker(createdAtIso: string, currentMarkerIso: string): Promise<void> {
  const createdMs = new Date(createdAtIso).getTime();
  const currentMs = new Date(currentMarkerIso).getTime();
  if (!Number.isFinite(createdMs) || !Number.isFinite(currentMs) || createdMs >= currentMs) return;

  const supabase = getServiceSupabase();
  if (!supabase) return;
  const { error } = await supabase.from("app_settings").update({ updated_at: createdAtIso }).eq("key", MARKER_KEY);
  if (error) {
    log.warn("signups-disabled-marker: back-date failed", { err: error.message });
  }
}

/**
 * Called from every place that observes MEMBRAL_SIGNUPS_DISABLED reading
 * `true` (signup()'s kill-switch check, signInWithGoogle(), this route's
 * callback) — best-effort, side-effect only, no decision made here. Safe
 * to call unconditionally; a pre-existing marker is left untouched
 * (`ignoreDuplicates`). R4-M2: this module has no counterpart that clears
 * the marker — see this module's header for why the app never does that.
 */
export async function ensureSignupsDisabledMarker(): Promise<void> {
  await ensureMarker();
}

/**
 * Returns true when `createdAtIso` (an auth.users row's `created_at`)
 * should be treated as created WHILE MEMBRAL_SIGNUPS_DISABLED was active —
 * i.e. this identity was auto-provisioned during the current incident and
 * should be refused regardless of how many times the caller retries.
 * Fails closed (returns true — block) when the marker can't be determined
 * at all. When THIS call is the one that just created the marker (R3-M1's
 * residual race), it also back-dates that marker to `createdAtIso` (R4-M1)
 * before returning "blocked", so the SAME row is refused again on retry
 * instead of the marker's own late stamp quietly admitting it.
 */
export async function wasCreatedWhileSignupsDisabled(createdAtIso: string): Promise<boolean> {
  const { markerIso, justInserted } = await ensureMarker();
  if (markerIso === null) return true;

  if (justInserted) {
    await backDateMarker(createdAtIso, markerIso);
    return true;
  }

  const createdMs = new Date(createdAtIso).getTime();
  const markerMs = new Date(markerIso).getTime();
  if (!Number.isFinite(createdMs) || !Number.isFinite(markerMs)) return true;
  return createdMs >= markerMs;
}
