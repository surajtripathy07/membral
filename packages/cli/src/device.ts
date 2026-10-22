// Shared device identity — a persistent identifier for "this machine",
// used by `membral login`/`setup`'s device-authorization sign-in flow
// (packages/cli/src/login-command.ts, apps/cloud's
// POST /api/auth/device/approve) to tie a minted API key to the machine
// that requested it, and reported by `membral status`. Originally built
// for the bridge (removed 2026-09-12 refocus goal's kill list, see
// apps/cloud/supabase/migrations/050's now-dropped bridge_claim_next_command)
// but the device-authorization use predates and outlives that.
//
// ~/.membral/device.json { id, name, platform } is created once on first
// use and reused thereafter. `id` and `platform` are immutable once
// created; `deviceName` (--device-name flag or MEMBRAL_DEVICE_NAME env,
// resolved by the caller) overrides — and persists — a new `name` on every
// load when given.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";

export interface DeviceIdentity {
  id: string;
  name: string;
  platform: string;
}

export function defaultDeviceIdentityPath(): string {
  return join(homedir(), ".membral", "device.json");
}

export interface LoadDeviceIdentityOptions {
  /** --device-name / MEMBRAL_DEVICE_NAME override — replaces and persists `name` when given. */
  deviceName?: string;
  /** Defaults to defaultDeviceIdentityPath(); overridable (tests, --workspace-style isolation). */
  path?: string;
}

function readExisting(path: string): Partial<DeviceIdentity> | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Partial<DeviceIdentity>) : null;
  } catch {
    return null; // corrupt/unreadable file — treated as absent, a fresh identity is written below
  }
}

/**
 * Reads just the `name` field out of an existing device.json WITHOUT
 * creating the file — issue #137: setup's machine-name prompt needs to show
 * "Name this machine [<the right default>]: " and the right default is the
 * existing device.json name when one is already there (a re-run/rename),
 * else the hostname — but calling loadOrCreateDeviceIdentity() to find that
 * out would create a hostname-named device.json before the user ever got
 * to answer the prompt. Returns undefined when the file doesn't exist yet,
 * is corrupt, or has no valid `name`.
 */
export function peekDeviceName(path: string = defaultDeviceIdentityPath()): string | undefined {
  const existing = readExisting(path);
  return typeof existing?.name === "string" && existing.name.trim() ? existing.name : undefined;
}

/**
 * Loads ~/.membral/device.json, creating it on first use. Exported for unit
 * testing via the `path` option — real callers should omit it and rely on
 * defaultDeviceIdentityPath().
 */
export function loadOrCreateDeviceIdentity(opts: LoadDeviceIdentityOptions = {}): DeviceIdentity {
  const path = opts.path ?? defaultDeviceIdentityPath();
  const existing = readExisting(path);

  const identity: DeviceIdentity = {
    id: (typeof existing?.id === "string" && existing.id) || randomUUID(),
    name: opts.deviceName?.trim() || (typeof existing?.name === "string" && existing.name) || hostname(),
    platform: (typeof existing?.platform === "string" && existing.platform) || process.platform,
  };

  const changed =
    !existing ||
    existing.id !== identity.id ||
    existing.name !== identity.name ||
    existing.platform !== identity.platform;

  if (changed) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(identity, null, 2)}\n`, "utf8");
  }

  return identity;
}
