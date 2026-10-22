// Local-stack provisioning (W7 design §6): the one local user, its password,
// and optionally a fresh device API key — without a browser. Called only by
// POST /api/internal/local/provision, which is 404 outside local mode.
//
// Key minting reuses the device-login path unchanged: upsertOwnedDevice
// (lib/device-auth.ts) for the devices row and mintApiKey (lib/api-keys.ts)
// for the `lls_` key + sha256 hash, inserted into api_keys exactly as
// approveDeviceAuth does. Keys this module mints are marked by the device's
// platform = LOCAL_DEVICE_PLATFORM; a later mint revokes every earlier key on
// such devices (revoked_at, the column validateApiKey filters on) and deletes
// those device rows, so one local key is live at a time. Device-login keys
// (any other platform) are never touched.
import { randomUUID } from "node:crypto";
import { mintApiKey } from "@/lib/api-keys";
import type { TypedDb } from "@/lib/db/types";
import { upsertOwnedDevice } from "@/lib/device-auth";

export const LOCAL_DEVICE_PLATFORM = "membral-local";

/** listUsers page size and page cap; the local stack has one user, this only bounds a pathological DB. */
const PER_PAGE = 1000;
const MAX_PAGES = 50;

export interface ProvisionInput {
  email: string;
  password: string;
  deviceName: string;
  mintKey: boolean;
}

export interface ProvisionResult {
  userId: string;
  email: string;
  created: boolean;
  apiKey: string | null;
}

async function findUserIdByEmail(db: TypedDb, email: string): Promise<string | null> {
  const wanted = email.toLowerCase();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: PER_PAGE });
    if (error) throw new Error(`Failed to list users: ${error.message}`);
    const users = data?.users ?? [];
    const hit = users.find((u) => (u.email ?? "").toLowerCase() === wanted);
    if (hit) return hit.id;
    if (users.length < PER_PAGE) return null;
  }
  return null;
}

async function ensureProfile(db: TypedDb, userId: string, email: string): Promise<void> {
  // The auth.users trigger (migration 004) normally made it; this covers a DB
  // where the trigger was missing when the user was created.
  const { data, error } = await db.from("profiles").select("id").eq("id", userId).maybeSingle();
  if (error) throw new Error(`Failed to read profile: ${error.message}`);
  if (data) return;
  const { error: insertError } = await db.from("profiles").insert({ id: userId, email });
  if (insertError) throw new Error(`Failed to create profile: ${insertError.message}`);
}

async function mintLocalKey(db: TypedDb, userId: string, deviceName: string): Promise<string> {
  const deviceId = randomUUID();
  await upsertOwnedDevice(db, { id: deviceId, userId, name: deviceName, platform: LOCAL_DEVICE_PLATFORM });

  const { raw, prefix, hash } = mintApiKey();
  const { error: keyError } = await db.from("api_keys").insert({
    user_id: userId,
    key_hash: hash,
    key_prefix: prefix,
    device_id: deviceId,
    label: deviceName,
  });
  if (keyError) throw new Error(`Failed to store API key: ${keyError.message}`);

  // Revoke after the new key is stored, so a failure never leaves zero keys.
  const { data: olds, error: oldError } = await db
    .from("devices")
    .select("id")
    .eq("user_id", userId)
    .eq("platform", LOCAL_DEVICE_PLATFORM)
    .neq("id", deviceId);
  if (oldError) throw new Error(`Failed to list previous local devices: ${oldError.message}`);
  const oldIds = ((olds ?? []) as { id: string }[]).map((d) => d.id);
  if (oldIds.length > 0) {
    const { error: revokeError } = await db
      .from("api_keys")
      .update({ revoked_at: new Date().toISOString() })
      .eq("user_id", userId)
      .in("device_id", oldIds)
      .is("revoked_at", null);
    if (revokeError) throw new Error(`Failed to revoke previous local keys: ${revokeError.message}`);
    const { error: deleteError } = await db.from("devices").delete().eq("user_id", userId).in("id", oldIds);
    if (deleteError) throw new Error(`Failed to remove previous local devices: ${deleteError.message}`);
  }
  return raw;
}

export async function provisionLocalUser(db: TypedDb, input: ProvisionInput): Promise<ProvisionResult> {
  const email = input.email.trim().toLowerCase();
  let userId = await findUserIdByEmail(db, email);
  let created = false;

  // An existing user keeps its password: a second `local up` changes nothing, and a
  // password the user set themselves survives. The password applies at creation only.
  if (!userId) {
    const { data, error } = await db.auth.admin.createUser({
      email,
      password: input.password,
      email_confirm: true,
    });
    if (error || !data?.user) throw new Error(`Failed to create user: ${error?.message ?? "no user returned"}`);
    userId = data.user.id;
    created = true;
  }

  await ensureProfile(db, userId, email);
  const apiKey = input.mintKey ? await mintLocalKey(db, userId, input.deviceName) : null;
  return { userId, email, created, apiKey };
}
