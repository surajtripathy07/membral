// Device-code sign-in for the Membral CLI (`membral setup`), migration 052.
// Shape follows RFC 8628 (OAuth 2.0 Device Authorization Grant) / GitHub
// CLI's device flow:
//
//   1. startDeviceAuth  — CLI calls POST /api/auth/device/start (no auth).
//      Creates a device_auth_requests row, returns a long secret
//      `deviceCode` (only this call ever sees the raw value — only its hash
//      is stored) and a short `userCode` to print in the terminal.
//   2. The user opens /device (in the browser, already signed in or not),
//      types/confirms the userCode, and approves or denies.
//   3. approveDeviceAuth / denyDeviceAuth — the /device page's actions,
//      cookie-session authenticated. Approve mints a real api_keys row
//      (lib/api-keys.ts's mintApiKey — same generator/hash as every other
//      lls_ key) and stages the RAW key in pending_api_key for delivery.
//   4. pollDeviceAuth — CLI calls POST /api/auth/device/poll with its
//      deviceCode every `interval` seconds until it gets back 'approved'
//      (with the raw key, delivered exactly once) or a terminal status.
//
// See migration 052's header for why device_id and pending_api_key exist on
// device_auth_requests beyond the task brief's original column list, and for
// the race-safety argument behind pollDeviceAuth's claim-then-read-then-scrub
// sequence.

import { createHash, randomBytes, randomInt, randomUUID } from "crypto";
import { getServiceClient } from "@/lib/db/clients";
import type { TypedDb } from "@/lib/db/types";
import { mintApiKey } from "./api-keys";

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export const DEVICE_AUTH_TTL_SECONDS = 600; // 10 minutes
export const DEVICE_AUTH_POLL_INTERVAL_SECONDS = 3;
// M2 (adversarial review): how long an APPROVED request stays collectible
// past its approved_at, independent of the original 10-minute minting
// window in expires_at. See pollDeviceAuth's header comment for why the two
// are no longer the same check.
export const APPROVED_GRACE_SECONDS = 300; // 5 minutes

// Thrown by upsertOwnedDevice / approveDeviceAuth when the caller's device
// id already belongs to a DIFFERENT user (H1, adversarial review) — a
// distinct type so route handlers can map it to 400/409 instead of a
// generic 500, without approveDeviceAuth having to encode HTTP semantics.
export class DeviceConflictError extends Error {
  constructor(message = "Device is already registered to another account") {
    super(message);
    this.name = "DeviceConflictError";
  }
}

// Unambiguous alphabet (GitHub device-flow style): digits 2-9 + A-Z minus
// I, L, O — no character a human has to squint at to distinguish from 0/1,
// since this code gets read off a terminal and typed into a browser by
// hand. 31 symbols, 8 of them per code -> ~31^8 (~8.5e11) combinations,
// plenty for a 10-minute-lived, low-volume code with IP rate limiting on
// both the minting (start) and consuming (poll) sides.
const USER_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const USER_CODE_RAW_LENGTH = 8;
const USER_CODE_INSERT_RETRIES = 5;

function randomUserCode(): string {
  let raw = "";
  for (let i = 0; i < USER_CODE_RAW_LENGTH; i++) {
    raw += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)];
  }
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

// Normalizes user-typed input against the "XXXX-XXXX" stored format:
// uppercases, strips anything that isn't in the alphabet (spaces, stray
// dashes), then re-inserts the single dash at position 4. A malformed
// input (wrong length after stripping) is returned uppercased/stripped but
// un-dashed — it simply won't match any stored user_code, which is the
// correct "not found" behaviour rather than a special error path.
export function normalizeUserCode(input: string): string {
  const cleaned = input
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  if (cleaned.length !== USER_CODE_RAW_LENGTH) return cleaned;
  return `${cleaned.slice(0, 4)}-${cleaned.slice(4)}`;
}

function newDeviceCode(): string {
  // Unrelated to the lls_ api-key shape on purpose — a device code is a
  // short-lived polling secret, never itself an api_keys.key_hash value.
  return `dvc_${randomBytes(32).toString("base64url")}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

// ------------------------------------------------------------
// upsertOwnedDevice — H1, adversarial review. Registers/refreshes a
// `devices` row WITHOUT ever letting a caller reassign another user's
// device row to themselves. A service-role `.upsert(payload, {onConflict:
// "id"})` (the old shape here and in the retired bridge's agent poll) has no
// ownership check at all: any caller supplying another user's device UUID
// could flip that row's user_id to itself, hijacking whatever the
// device-auth/bridge flows do next against that device id. This follows the
// same select-then-insert-or-update shape as the retired bridge's session
// route did: look the id up with NO user_id
// filter (so we can see who — if anyone — already owns it), insert only
// when the id is completely unused, update only when the caller already
// owns it, and reject outright (DeviceConflictError, never a silent
// reassignment) when the id exists for a DIFFERENT user.
// ------------------------------------------------------------
export interface UpsertOwnedDeviceParams {
  id: string;
  userId: string;
  name: string;
  platform?: string | null;
  lastSeenAt?: string;
}

export async function upsertOwnedDevice(supabase: TypedDb, params: UpsertOwnedDeviceParams): Promise<void> {
  const { data: existing, error: lookupError } = await supabase
    .from("devices")
    .select("id, user_id")
    .eq("id", params.id)
    .maybeSingle();

  if (lookupError) {
    throw new Error(`Failed to look up device: ${lookupError.message}`);
  }

  const typedExisting = existing as { id: string; user_id: string } | null;
  const lastSeenAt = params.lastSeenAt ?? new Date().toISOString();

  if (typedExisting) {
    if (typedExisting.user_id !== params.userId) {
      throw new DeviceConflictError();
    }
    const { error: updateError } = await supabase
      .from("devices")
      .update({ name: params.name, platform: params.platform ?? null, last_seen_at: lastSeenAt })
      .eq("id", params.id)
      .eq("user_id", params.userId);
    if (updateError) throw new Error(`Failed to update device: ${updateError.message}`);
    return;
  }

  const { error: insertError } = await supabase.from("devices").insert({
    id: params.id,
    user_id: params.userId,
    name: params.name,
    platform: params.platform ?? null,
    last_seen_at: lastSeenAt,
  });
  if (insertError) throw new Error(`Failed to register device: ${insertError.message}`);
}

// Cheap opportunistic scrub (M2, adversarial review): an approved-but-
// never-collected request whose grace window has lapsed still has a raw key
// sitting in pending_api_key. There's no cron/sweep job wired up for this
// stopgap table (see migration 052's header), so piggyback the cleanup on
// every /start call instead — a single indexed UPDATE
// (idx_device_auth_requests_status_expires covers the `status` half),
// fire-and-forget, never blocks the response it rides along with.
function scrubExpiredApprovedRequests(supabase: TypedDb): void {
  const cutoff = new Date(Date.now() - APPROVED_GRACE_SECONDS * 1000).toISOString();
  void supabase
    .from("device_auth_requests")
    .update({ status: "expired", pending_api_key: null })
    .eq("status", "approved")
    .lt("approved_at", cutoff)
    .then(
      () => {},
      () => {},
    );
}

export interface StartDeviceAuthParams {
  deviceName?: string | null;
  devicePlatform?: string | null;
  /** The CLI's own client-generated device id (~/.membral/device.json). */
  deviceId?: string | null;
}

export interface StartDeviceAuthResult {
  deviceCode: string;
  userCode: string;
  expiresIn: number;
  interval: number;
}

export async function startDeviceAuth(params: StartDeviceAuthParams): Promise<StartDeviceAuthResult> {
  const supabase: TypedDb = getServiceClient();

  // Opportunistic, fire-and-forget — see scrubExpiredApprovedRequests's
  // comment. Never awaited: a scrub failure must not block minting a new
  // device code.
  scrubExpiredApprovedRequests(supabase);

  const deviceCode = newDeviceCode();
  const deviceCodeHash = hash(deviceCode);
  const expiresAt = new Date(Date.now() + DEVICE_AUTH_TTL_SECONDS * 1000).toISOString();

  let lastErrorMessage = "unknown error";
  for (let attempt = 0; attempt < USER_CODE_INSERT_RETRIES; attempt++) {
    const userCode = randomUserCode();
    const { error } = await supabase.from("device_auth_requests").insert({
      device_code_hash: deviceCodeHash,
      user_code: userCode,
      device_id: params.deviceId ?? null,
      device_name: params.deviceName ?? null,
      device_platform: params.devicePlatform ?? null,
      expires_at: expiresAt,
    });

    if (!error) {
      return {
        deviceCode,
        userCode,
        expiresIn: DEVICE_AUTH_TTL_SECONDS,
        interval: DEVICE_AUTH_POLL_INTERVAL_SECONDS,
      };
    }

    lastErrorMessage = error.message;
    // 23505 = unique_violation. Only a user_code collision is worth retrying
    // (astronomically unlikely at 31^8, but cheap to handle); a
    // device_code_hash collision would mean a randomBytes(32) collision,
    // and any other error is a real failure — bail immediately either way.
    if (error.code !== "23505") break;
  }

  throw new Error(`Failed to create device auth request: ${lastErrorMessage}`);
}

export type PollDeviceAuthResult =
  | { status: "pending" }
  | { status: "approved"; apiKey: string; email: string; userId: string }
  | { status: "denied" }
  | { status: "expired" }
  | { status: "consumed" };

interface DeviceAuthRequestRow {
  id: string;
  status: string;
  expires_at: string;
  approved_at: string | null;
  consumed_at: string | null;
}

// M2 (adversarial review): expires_at is the original 10-minute MINTING
// window (start -> approve) — it says nothing about how long an
// already-approved request should stay collectible. Before this fix, an
// approved row whose expires_at had simply ticked past (e.g. the human
// approved right near the end of the 10-minute window, or the CLI's poll
// loop lagged) reported `expired` FOREVER and never delivered the key —
// with pending_api_key left sitting in storage indefinitely, since the
// delivery path (which scrubs it) was never reached. status === 'approved'
// is now exempt from the plain expires_at check; it instead gets its own
// grace window off approved_at (APPROVED_GRACE_SECONDS), checked right
// before the atomic claim, which also scrubs pending_api_key on expiry —
// see the `graceExpired` branch below and scrubExpiredApprovedRequests for
// the opportunistic sweep on the `start` side.
export async function pollDeviceAuth(deviceCode: string): Promise<PollDeviceAuthResult> {
  const supabase: TypedDb = getServiceClient();
  const deviceCodeHash = hash(deviceCode);

  const { data: row, error } = await supabase
    .from("device_auth_requests")
    .select("id, status, expires_at, approved_at, consumed_at")
    .eq("device_code_hash", deviceCodeHash)
    .single();

  if (error || !row) {
    // Unknown/garbage deviceCode -> same terminal response as an expired
    // one. Never distinguish "wrong code" from "expired" to a caller —
    // both mean "start over," and it avoids giving a guesser a signal.
    return { status: "expired" };
  }

  const typedRow = row as DeviceAuthRequestRow;

  if (typedRow.status === "denied") return { status: "denied" };

  if (typedRow.status !== "approved") {
    const isExpired = new Date(typedRow.expires_at).getTime() < Date.now();
    if (typedRow.status === "pending" && isExpired) {
      // Lazily flip the row so a subsequent approve attempt on this code is
      // rejected too (approveDeviceAuth also re-checks expiry itself, but
      // this keeps `status` honest for anything else that reads the row).
      void supabase
        .from("device_auth_requests")
        .update({ status: "expired" })
        .eq("id", typedRow.id)
        .eq("status", "pending")
        .then(
          () => {},
          () => {},
        );
      return { status: "expired" };
    }
    if (typedRow.status === "expired" || isExpired) return { status: "expired" };
    if (typedRow.status === "pending") return { status: "pending" };
    // Any other status shouldn't happen given the CHECK constraint, but
    // fail to the same safe terminal response as expired rather than fall
    // through.
    return { status: "expired" };
  }

  // status === 'approved' from here on.
  if (typedRow.consumed_at) return { status: "consumed" };

  const approvedAtMs = typedRow.approved_at ? new Date(typedRow.approved_at).getTime() : null;
  const graceExpired = approvedAtMs === null || Date.now() - approvedAtMs > APPROVED_GRACE_SECONDS * 1000;
  if (graceExpired) {
    // Never collected within the grace window (or a legacy/bugged row with
    // no approved_at at all, which we treat as already expired rather than
    // let it linger) — scrub the staged raw key so it doesn't sit in
    // pending_api_key forever, and report the same terminal state a
    // never-approved request would.
    void supabase
      .from("device_auth_requests")
      .update({ status: "expired", pending_api_key: null })
      .eq("id", typedRow.id)
      .eq("status", "approved")
      .then(
        () => {},
        () => {},
      );
    return { status: "expired" };
  }

  // Atomic claim: this UPDATE only affects a row still gated on
  // status='approved' AND consumed_at IS NULL. Postgres row-level locking
  // makes a single UPDATE...WHERE atomic, so at most one concurrent poll
  // ever sees a non-empty `claimed` result — see migration 052's header.
  const { data: claimed, error: claimError } = await supabase
    .from("device_auth_requests")
    .update({ consumed_at: new Date().toISOString() })
    .eq("id", typedRow.id)
    .eq("status", "approved")
    .is("consumed_at", null)
    .select("id");

  if (claimError || !claimed || claimed.length === 0) {
    // Lost the race to a concurrent poll (or a re-poll landed between the
    // read above and here) -> the winner already has it.
    return { status: "consumed" };
  }

  // We won the claim. Read the staged key + user now (safe: consumed_at is
  // already set, so no other poll can win this claim), then scrub the
  // plaintext key back to NULL — best-effort, never blocks the response.
  const { data: full } = await supabase
    .from("device_auth_requests")
    .select("pending_api_key, user_id")
    .eq("id", typedRow.id)
    .single();

  const apiKey = (full as { pending_api_key: string | null; user_id: string | null } | null)?.pending_api_key ?? null;
  const userId = (full as { pending_api_key: string | null; user_id: string | null } | null)?.user_id ?? null;

  void supabase
    .from("device_auth_requests")
    .update({ pending_api_key: null })
    .eq("id", typedRow.id)
    .then(
      () => {},
      () => {},
    );

  if (!apiKey || !userId) {
    // Defensive: an approved+claimed row with no staged key is a bug
    // elsewhere, not a state the CLI should be told to keep polling for.
    return { status: "consumed" };
  }

  const { data: profile } = await supabase.from("profiles").select("email").eq("id", userId).single();

  return {
    status: "approved",
    apiKey,
    email: (profile as { email: string | null } | null)?.email ?? "",
    userId,
  };
}

export interface ApproveDeviceAuthParams {
  userCode: string;
  userId: string;
  /** Optional display-name override from the /device page's form. */
  deviceName?: string | null;
}

export interface ApproveDeviceAuthResult {
  deviceName: string;
  keyPrefix: string;
}

interface PendingRequestRow {
  id: string;
  status: string;
  expires_at: string;
  device_id: string | null;
  device_name: string | null;
  device_platform: string | null;
}

// Returns null for "not found, not pending, or expired" — the route turns
// that into a single generic 400 so a guesser can't distinguish the three.
// Throws DeviceConflictError (H1) when the request's device_id already
// belongs to a different user — the route maps that to 409 instead of the
// generic 500 other thrown errors get, since it's a caller-fixable/
// attacker-relevant condition, not an infra failure.
export async function approveDeviceAuth(params: ApproveDeviceAuthParams): Promise<ApproveDeviceAuthResult | null> {
  const supabase: TypedDb = getServiceClient();
  const userCode = normalizeUserCode(params.userCode);

  const { data: row, error } = await supabase
    .from("device_auth_requests")
    .select("id, status, expires_at, device_id, device_name, device_platform")
    .eq("user_code", userCode)
    .single();

  if (error || !row) return null;
  const typedRow = row as PendingRequestRow;
  if (typedRow.status !== "pending") return null;
  if (new Date(typedRow.expires_at).getTime() < Date.now()) return null;

  const resolvedDeviceId = typedRow.device_id ?? randomUUID();
  const resolvedName = params.deviceName?.trim() || typedRow.device_name?.trim() || "CLI device";

  // Register/refresh the devices row (migration 050) so this key's device
  // shows up in the online-status UI (the retired bridge's device list) exactly like
  // any device that authenticated the older way. Ownership-checked (H1,
  // adversarial review) — see upsertOwnedDevice's header comment: a plain
  // `.upsert(..., {onConflict:"id"})` here would let a caller supplying
  // ANOTHER user's device UUID (device_id is threaded through from /start's
  // body, which is unauthenticated) reassign that row to itself. Run
  // BEFORE minting the api key so a conflict aborts cleanly with nothing
  // minted or written.
  await upsertOwnedDevice(supabase, {
    id: resolvedDeviceId,
    userId: params.userId,
    name: resolvedName,
    platform: typedRow.device_platform ?? null,
  });

  const { raw, prefix, hash: keyHash } = mintApiKey();

  const { data: keyRow, error: keyError } = await supabase
    .from("api_keys")
    .insert({
      user_id: params.userId,
      key_hash: keyHash,
      key_prefix: prefix,
      device_id: resolvedDeviceId,
      label: resolvedName,
    })
    .select("id")
    .single();
  if (keyError || !keyRow) {
    throw new Error(`Failed to store device API key: ${keyError?.message ?? "no row returned"}`);
  }
  const typedKeyRow = keyRow as { id: string };

  // Guard against a double-approve race with `.eq("status", "pending")`:
  // if another request already flipped this row, this UPDATE affects zero
  // rows. We don't currently roll back the api_keys insert above in that
  // case (rare, demo-quality tradeoff) — the orphaned key is still a
  // validly minted, revocable key, just not the one this call reports back.
  const { error: updateError } = await supabase
    .from("device_auth_requests")
    .update({
      status: "approved",
      user_id: params.userId,
      api_key_id: typedKeyRow.id,
      approved_at: new Date().toISOString(),
      pending_api_key: raw,
    })
    .eq("id", typedRow.id)
    .eq("status", "pending");
  if (updateError) throw new Error(`Failed to finalize device approval: ${updateError.message}`);

  return { deviceName: resolvedName, keyPrefix: prefix };
}

export interface DeviceAuthStatus {
  status: string;
  deviceName: string | null;
  devicePlatform: string | null;
}

// GET-side helper for the /device page (NOT part of the CLI's three-route
// contract — start/poll/approve/deny are what the CLI talks to; this is
// what the page uses to show "you're about to authorize <device name>"
// BEFORE the user clicks Approve, which is the security-meaningful moment
// in a device flow — confirming an unfamiliar code isn't silently
// authorizing someone else's machine). Deliberately returns only display
// fields — never device_code_hash, pending_api_key, or user_id.
export async function lookupDeviceAuthStatus(userCode: string): Promise<DeviceAuthStatus | null> {
  const supabase: TypedDb = getServiceClient();
  const normalized = normalizeUserCode(userCode);

  const { data: row, error } = await supabase
    .from("device_auth_requests")
    .select("status, expires_at, device_name, device_platform")
    .eq("user_code", normalized)
    .single();

  if (error || !row) return null;
  const typedRow = row as {
    status: string;
    expires_at: string;
    device_name: string | null;
    device_platform: string | null;
  };

  const isExpired = new Date(typedRow.expires_at).getTime() < Date.now();
  const status = typedRow.status === "pending" && isExpired ? "expired" : typedRow.status;

  return { status, deviceName: typedRow.device_name, devicePlatform: typedRow.device_platform };
}

export interface DenyDeviceAuthParams {
  userCode: string;
}

// Returns true iff a pending request was found and denied.
export async function denyDeviceAuth(params: DenyDeviceAuthParams): Promise<boolean> {
  const supabase: TypedDb = getServiceClient();
  const userCode = normalizeUserCode(params.userCode);

  const { data, error } = await supabase
    .from("device_auth_requests")
    .update({ status: "denied" })
    .eq("user_code", userCode)
    .eq("status", "pending")
    .select("id");

  if (error) return false;
  return (data?.length ?? 0) > 0;
}
