import { createHash, randomBytes } from "crypto";
import { getServiceClient } from "@/lib/db/clients";
import type { TypedDb } from "@/lib/db/types";
import { checkRateLimit, ipBucket, logRateLimitHit, resolveRule } from "./rate-limit";

function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

// Shape is load-bearing: existing keys + the SHA256 hash check in validateApiKey
// assume `lls_` + base64url. Changing it invalidates every stored hash.
function newApiKeyString(): string {
  return `lls_${randomBytes(24).toString("base64url")}`;
}

// Device-code sign-in (migration 052): a building block for lib/device-auth.ts's
// approve step, which inserts a row into the NEW api_keys table (multiple keys
// per user) rather than the single profiles.api_key_hash column. Reuses the
// exact same raw-key shape + hash function as generateApiKey above so a
// device-bound key is byte-for-byte indistinguishable from a profile key to
// validateApiKey and to /api/mcp — "same generator/hash as api-keys.ts", not a
// parallel format. Returns the pieces instead of persisting them: the caller
// owns which table the key lands in.
export function mintApiKey(): { raw: string; prefix: string; hash: string } {
  const raw = newApiKeyString();
  return { raw, prefix: raw.slice(0, 8), hash: hashKey(raw) };
}

// Canonical generator (single source for the /api/keys route). Persists the
// SHA256 hash of the full key + a display-only prefix; returns the raw key once.
//
// scopeNodeId (issue #83): null = not area-scoped; else a LifeArea node id
// (public.kg_nodes.id) that becomes a MANDATORY read bound on every key-authed
// chat surface.
//
// scopeCodeProjectId (ADR 0021 Q7): null = not code-project-scoped; else a
// code_projects.id that becomes the mandatory bound on the code tools.
//
// SINGLE-SCOPE (XOR): a key is area-scoped XOR code-project-scoped XOR
// unscoped. Passing BOTH is a caller bug — we throw here rather than persist an
// ambiguous key, and the DB backstops it with the profiles_api_key_single_scope
// CHECK (migration 029). The caller (POST /api/keys) is responsible for
// validating the id belongs to the user before passing it here — persisting a
// bad id fails CLOSED (empty result, see migrations 024/030), never open, but
// validating up front gives the user a clean error instead of a dead key.
export async function generateApiKey(
  userId: string,
  scopeNodeId: string | null = null,
  scopeCodeProjectId: string | null = null,
): Promise<string> {
  if (scopeNodeId != null && scopeCodeProjectId != null) {
    throw new Error("A key may be area-scoped or code-project-scoped, not both");
  }
  const supabase: TypedDb = getServiceClient();
  const raw = newApiKeyString();
  const hash = hashKey(raw);

  const { error } = await supabase
    .from("profiles")
    .update({
      api_key_hash: hash,
      api_key_prefix: raw.slice(0, 8),
      api_key_scope_node_id: scopeNodeId,
      api_key_scope_code_project_id: scopeCodeProjectId,
      updated_at: new Date().toISOString(),
    })
    .eq("id", userId);

  if (error) {
    throw new Error(`Failed to store API key: ${error.message}`);
  }

  return raw;
}

// Validation result carries the token's area scope so the /api/mcp route can
// inject it as the mandatory outer bound. scopeNodeId is null for an unscoped
// ("all of my graph") key — every read then behaves exactly as before #83.
//
// scopeCodeProjectId (ADR 0021 Q7): the code-project flavor of the same
// single-scope model — null unless the key is bound to one code_projects.id.
// A key is area-scoped XOR code-project-scoped XOR unscoped (migration 029's
// profiles_api_key_single_scope CHECK enforces this at the schema level too).
//
// rateLimited (issue #67): set when the caller's IP has exceeded the failed-
// validation budget. The route should surface a 429 with retryAfter instead of
// a plain 401 so a brute-forcer is throttled, not just told "wrong key".
// deviceId (migration 052): set only when the validated key came from the
// api_keys fall-through path AND is bound to a device — undefined for a
// legacy profiles key or an unscoped device key. Not currently consumed by
// any caller; threaded through now so a future route (e.g. device-scoped
// telemetry) doesn't need another validateApiKey shape change.
export interface ApiKeyValidation {
  valid: boolean;
  userId?: string;
  scopeNodeId?: string | null;
  scopeCodeProjectId?: string | null;
  deviceId?: string | null;
  /** api_keys.id when the key came from the api_keys table; null for a legacy profiles key. */
  apiKeyId?: string | null;
  rateLimited?: boolean;
  retryAfter?: number;
}

// clientIp (issue #67): when supplied, FAILED validations are throttled per IP
// (default 5/min, RATE_LIMIT_KEY_VALIDATION_FAIL) to bound brute-forcing the
// lls_ keyspace. Successful validations are NEVER counted, so a legit key in
// steady use can't lock itself out.
//
// SHARED-NAT TRADEOFF: the bucket is per-IP and counts only FAILED attempts, so
// many legit users behind one NAT/VPN egress IP share the failure budget only
// if they are *repeatedly presenting bad keys*. A correct key from any of them
// never consumes budget. We deliberately do NOT key by (IP + attempted-key)
// (that would let an attacker rotate keys freely) nor by user (a failed lookup
// has no user). The cost is that a burst of genuine misconfigurations from one
// shared egress can briefly 429 that IP; the window is short (60s) and the
// default (5) is generous for honest typos.
export async function validateApiKey(key: string, clientIp?: string): Promise<ApiKeyValidation> {
  const supabase: TypedDb = getServiceClient();
  const hash = hashKey(key);

  const { data, error } = await supabase
    .from("profiles")
    .select("id, api_key_scope_node_id, api_key_scope_code_project_id")
    .eq("api_key_hash", hash)
    .single();

  if (!error && data) {
    return {
      valid: true,
      userId: data.id,
      scopeNodeId: data.api_key_scope_node_id ?? null,
      scopeCodeProjectId: data.api_key_scope_code_project_id ?? null,
    };
  }

  // Fall through to api_keys (migration 052) — the multi-key table that
  // device-code sign-in mints into. A revoked row (revoked_at set) is
  // treated exactly like "no such key": `.is("revoked_at", null)` excludes
  // it from the lookup entirely, so a revoked device key never validates.
  const { data: deviceKeyRow, error: deviceKeyError } = await supabase
    .from("api_keys")
    .select("id, user_id, scope_node_id, scope_code_project_id, device_id")
    .eq("key_hash", hash)
    .is("revoked_at", null)
    .single();

  if (!deviceKeyError && deviceKeyRow) {
    // Fire-and-forget last_used_at bump — never block (or fail) the caller's
    // validation result on this write. Errors are swallowed on purpose: a
    // missed last_used_at stamp is cosmetic, not a validation concern.
    void supabase
      .from("api_keys")
      .update({ last_used_at: new Date().toISOString() })
      .eq("id", deviceKeyRow.id)
      .then(
        () => {},
        () => {},
      );

    return {
      valid: true,
      userId: deviceKeyRow.user_id,
      scopeNodeId: deviceKeyRow.scope_node_id ?? null,
      scopeCodeProjectId: deviceKeyRow.scope_code_project_id ?? null,
      deviceId: deviceKeyRow.device_id ?? null,
      apiKeyId: deviceKeyRow.id,
    };
  }

  // Failed validation on BOTH paths. Throttle by client IP (failed-only) so
  // a single IP can't brute-force the keyspace. Skipped when no IP is
  // threaded through.
  if (clientIp) {
    const rule = resolveRule("keyValidationFail");
    const bucket = ipBucket("keyfail", clientIp);
    const rl = await checkRateLimit({ bucket, limit: rule.limit, windowSeconds: rule.windowSeconds });
    if (!rl.allowed) {
      logRateLimitHit(bucket, rl);
      return { valid: false, rateLimited: true, retryAfter: rl.retryAfter };
    }
  }
  return { valid: false };
}

// Revoke one api_keys row (migration 052) for DELETE /api/keys/devices/[id].
// Constrained by BOTH id and user_id so a caller can never revoke another
// user's key by guessing an id — with the service client RLS is bypassed, so
// this predicate is the enforcement. `.is("revoked_at", null)` makes an
// already-revoked row a miss. Returns the raw `{ data, error }` so the caller
// keeps its own 500 (error) / 404 (no row) mapping.
export async function revokeApiKey(supabase: TypedDb, userId: string, id: string) {
  return await supabase
    .from("api_keys")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", id)
    .eq("user_id", userId)
    .is("revoked_at", null)
    .select("id");
}

export interface ApiKeyProfileRow {
  api_key_prefix: string | null;
  api_key_scope_node_id: string | null;
  api_key_scope_code_project_id: string | null;
}

/** /settings: the profile-key prefix + scope (area #83 / code-project ADR Q7).
 * Returns the raw `{ data, error }` — the settings loader reads `data` only. */
export async function getApiKeyProfile(
  supabase: TypedDb,
  userId: string,
): Promise<{ data: ApiKeyProfileRow | null; error: { message: string } | null }> {
  return await supabase
    .from("profiles")
    .select("api_key_prefix, api_key_scope_node_id, api_key_scope_code_project_id")
    .eq("id", userId)
    .single();
}

export interface ApiKeyListRow {
  id: string;
  key_prefix: string;
  label: string | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

/** /settings: every api_keys row (migration 052), newest first. No user_id
 * filter — the caller passes an RLS-scoped client, which does the isolation.
 * Returns the raw `{ data, error }` — the settings loader reads `data` only. */
export async function listApiKeys(
  supabase: TypedDb,
): Promise<{ data: ApiKeyListRow[] | null; error: { message: string } | null }> {
  return await supabase
    .from("api_keys")
    .select("id, key_prefix, label, created_at, last_used_at, revoked_at")
    .order("created_at", { ascending: false });
}
