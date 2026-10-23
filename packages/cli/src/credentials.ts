// ~/.membral/credentials.json — written by `membral login`'s device auth
// flow (deliverable 1). Holds the signed-in identity so every other command
// can resolve an API URL/key without the user re-passing --api-key on every
// invocation.
//
// THIS FILE IS THE SINGLE CREDENTIAL RESOLVER FOR THE WHOLE CLI (issue #136).
// Before this fix, three different modules had three different opinions on
// how to resolve an API key: this file's resolveApiKey/resolveApiUrl (used
// by bridge.ts/code-session-upload.ts), configure.ts's OWN private
// resolveApiKey/resolveApiUrl (no credentials.json fallback at all), and
// login-command.ts's whoamiCommand (read credentials.json directly, ignored
// flag/env entirely). The bug this caused: `membral setup` signs in and
// writes a fresh, valid key to credentials.json, but a stale MEMBRAL_API_KEY
// left exported in the user's shell profile silently outranked it forever —
// every subsequent command (import, start, agent, MCP) kept using the dead
// env key and 401ing, with no message ever naming the env var as the cause.
//
// Precedence (unchanged, and now enforced everywhere via resolveCredentials
// below): --api-key/--api-url FLAGS > MEMBRAL_API_KEY/MEMBRAL_API_URL ENV
// VARS > ~/.membral/credentials.json (written by `membral login`) > default
// API URL (no default key — "" means "not configured"). A flag is always
// explicit user intent and is never second-guessed. Plain resolveCredentials
// is a SYNC, NON-VALIDATING resolve — it always prefers env over
// credentials.json even when the env var is stale, by design (cheap, no
// network, safe to call on every command). That is exactly what caused
// #136, so any caller that is about to DO something consequential with the
// resolved key that's expensive to get wrong (setup writing a launchd plist
// + MCP config) should call `resolveValidatedCredentials` instead:
// it validates the env candidate against the resolved API URL first and,
// if THAT 401s while a *different*, currently-untried credentials.json key
// validates successfully, falls back to the credentials.json key and
// reports that it did (never silently prefers a rejected env key). See its
// doc comment below for the exact fallback rule.
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createApiClient } from "./lib/api-client.js";

/** Moved here from the upload module (3C-3) to break an import cycle; that
 * module re-exports it so existing importers are unaffected. */
export const DEFAULT_API_URL = "http://localhost:3000";

export interface Credentials {
  apiUrl: string;
  apiKey: string;
  email: string;
  userId: string;
  createdAt: string;
}

// Profiles (local <-> prod switch): one credentials.json holds a named
// profile per server the user has signed in to, plus which one is active.
// The top-level Credentials fields keep MIRRORING the active profile so any
// reader that only knows the old single-profile shape (older CLI builds,
// the launchd sweep script) still resolves the active URL/key unchanged.
// A pre-profiles file (top-level fields only) is read as a one-profile file
// and rewritten in the new shape on the next save.
export interface Profile {
  apiUrl: string;
  apiKey: string;
  email?: string;
  userId?: string;
  createdAt: string;
  /** Who wrote it: "local-stack" = `membral local up`. Absent on login-written profiles (and older files). */
  source?: string;
}

export interface ProfilesState {
  activeProfile: string;
  profiles: Record<string, Profile>;
}

export function defaultCredentialsPath(): string {
  return join(homedir(), ".membral", "credentials.json");
}

/**
 * localhost/127.0.0.1/::1 on port 3000 (or no port) -> "local", other local
 * ports -> "local-<port>", membral.me -> "prod", anything else -> host[:port].
 *
 * With `existing` (W7): a profile that already holds this exact URL keeps
 * its name, so `membral local up` on another port still owns "local"; and
 * a :3000 URL never takes over a "local" that points elsewhere (it becomes
 * "local-3000"). Without `existing`, or for existing users whose "local"
 * is :3000, the result is unchanged.
 */
export function profileNameForUrl(apiUrl: string, existing?: ProfilesState | null): string {
  if (existing) {
    const norm = (u: string) => u.replace(/\/+$/, "");
    const same = Object.entries(existing.profiles)
      .filter(([, p]) => norm(p.apiUrl) === norm(apiUrl))
      .map(([name]) => name);
    if (same.length > 0) return same.includes("local") ? "local" : same[0];
    const derived = profileNameForUrl(apiUrl);
    if (derived === "local" && existing.profiles.local) {
      let port = "3000";
      try {
        port = new URL(apiUrl).port || "3000";
      } catch {
        // keep the default
      }
      return `local-${port}`;
    }
    return derived;
  }
  let url: URL;
  try {
    url = new URL(apiUrl);
  } catch {
    return apiUrl.replace(/^[a-z]+:\/\//i, "").replace(/\/.*$/, "") || "default";
  }
  const host = url.hostname.toLowerCase();
  const port = url.port;
  if (host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1") {
    return port === "" || port === "3000" ? "local" : `local-${port}`;
  }
  if (host === "membral.me" || host === "www.membral.me") return "prod";
  return port ? `${host}:${port}` : host;
}

/**
 * Removes the ACTIVE profile only. Another profile (prefer "prod", else the
 * first left) becomes active; the file is deleted once none remain.
 * Returns what was removed and what is active now (null when the file is gone).
 */
export function removeActiveProfile(
  path: string = defaultCredentialsPath(),
): { removed: string; nowActive: string | null } | null {
  const state = loadProfiles(path);
  if (!state) return null;
  const removed = state.activeProfile;
  delete state.profiles[removed];
  const remaining = Object.keys(state.profiles);
  if (remaining.length === 0) {
    deleteCredentials(path);
    return { removed, nowActive: null };
  }
  state.activeProfile = remaining.includes("prod") ? "prod" : remaining[0];
  saveProfiles(state, path);
  return { removed, nowActive: state.activeProfile };
}

function isProfile(v: unknown): v is Profile {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return typeof r.apiUrl === "string" && typeof r.apiKey === "string" && r.apiKey.length > 0;
}

function toProfile(r: Record<string, unknown>): Profile {
  const p: Profile = {
    apiUrl: String(r.apiUrl),
    apiKey: String(r.apiKey),
    createdAt: typeof r.createdAt === "string" ? r.createdAt : "",
  };
  if (typeof r.email === "string") p.email = r.email;
  if (typeof r.userId === "string") p.userId = r.userId;
  if (typeof r.source === "string") p.source = r.source;
  return p;
}

function profileToCredentials(p: Profile): Credentials {
  return { apiUrl: p.apiUrl, apiKey: p.apiKey, email: p.email ?? "", userId: p.userId ?? "", createdAt: p.createdAt };
}

/**
 * Reads credentials.json into its profiles view. A pre-profiles file becomes
 * a single profile named from its URL. Missing/unreadable/corrupt all
 * degrade to `null` — never throws.
 */
export function loadProfiles(path: string = defaultCredentialsPath()): ProfilesState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const r = parsed as Record<string, unknown>;

  const profiles: Record<string, Profile> = {};
  if (r.profiles && typeof r.profiles === "object") {
    for (const [name, value] of Object.entries(r.profiles as Record<string, unknown>)) {
      if (isProfile(value)) profiles[name] = toProfile(value as unknown as Record<string, unknown>);
    }
  }

  const topLevel = isProfile(r) ? toProfile(r) : null;
  let active = typeof r.activeProfile === "string" && profiles[r.activeProfile] ? r.activeProfile : undefined;

  if (!active && topLevel) {
    // Old single-profile file, or a profiles map that lost its active entry:
    // the top-level mirror is the source of truth for what was active.
    const match = Object.entries(profiles).find(
      ([, p]) => p.apiKey === topLevel.apiKey && p.apiUrl === topLevel.apiUrl,
    );
    active = match ? match[0] : profileNameForUrl(topLevel.apiUrl);
    if (!match) profiles[active] = topLevel;
  }
  if (!active) {
    const first = Object.keys(profiles)[0];
    if (!first) return null;
    active = first;
  }
  return { activeProfile: active, profiles };
}

/** Writes the full profiles file atomically (tmp + rename), mode 0600, top-level mirroring the active profile. */
export function saveProfiles(state: ProfilesState, path: string = defaultCredentialsPath()): void {
  const active = state.profiles[state.activeProfile];
  if (!active) throw new Error(`active profile "${state.activeProfile}" is not in the profiles map`);
  const body = { ...profileToCredentials(active), activeProfile: state.activeProfile, profiles: state.profiles };
  mkdirSync(dirname(path), { recursive: true });
  // Symlink-safe (dotfiles-managed ~/.membral): write through to the target
  // so the rename never replaces the link itself with a plain file.
  let target = path;
  try {
    if (lstatSync(path).isSymbolicLink()) target = realpathSync(path);
  } catch {
    // missing file — nothing to resolve
  }
  const tmpPath = `${target}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmpPath, `${JSON.stringify(body, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(tmpPath, 0o600);
  } catch {
    // best-effort — not fatal if the platform/filesystem doesn't support it
  }
  renameSync(tmpPath, target);
}

/** Missing/unreadable/corrupt file all degrade to `null` — never throws. Returns the ACTIVE profile. */
export function loadCredentials(path: string = defaultCredentialsPath()): Credentials | null {
  const state = loadProfiles(path);
  if (!state) return null;
  return profileToCredentials(state.profiles[state.activeProfile]);
}

/** Returns one named profile, or null when it (or the file) doesn't exist. */
export function loadProfile(name: string, path: string = defaultCredentialsPath()): Profile | null {
  return loadProfiles(path)?.profiles[name] ?? null;
}

/**
 * Saves `creds` into its profile (named from its URL unless `profileName` is
 * given) and makes that profile active. Other profiles are kept. Atomic,
 * mode 0600.
 */
export function saveCredentials(
  creds: Credentials,
  path: string = defaultCredentialsPath(),
  profileName?: string,
): void {
  const loaded = loadProfiles(path);
  const name = profileName ?? profileNameForUrl(creds.apiUrl, loaded);
  const state = loaded ?? { activeProfile: name, profiles: {} };
  state.profiles[name] = toProfile(creds as unknown as Record<string, unknown>);
  state.activeProfile = name;
  saveProfiles(state, path);
}

/** Makes `name` the active profile. Returns the profile, or null (nothing written) when it doesn't exist. */
export function setActiveProfile(name: string, path: string = defaultCredentialsPath()): Profile | null {
  const state = loadProfiles(path);
  const profile = state?.profiles[name];
  if (!state || !profile) return null;
  state.activeProfile = name;
  saveProfiles(state, path);
  return profile;
}

/** Returns true if a credentials file existed and was removed; false if there was nothing to remove. */
export function deleteCredentials(path: string = defaultCredentialsPath()): boolean {
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

/** flags > env > credentials.json > defaultUrl. Trailing slashes stripped, same convention as the other resolveXConfig functions. */
export function resolveApiUrl(
  flagUrl: string | undefined,
  envUrl: string | undefined,
  defaultUrl: string,
  credsPath?: string,
): string {
  const url = flagUrl ?? envUrl ?? loadCredentials(credsPath)?.apiUrl ?? defaultUrl;
  return url.replace(/\/+$/, "");
}

/** flags > env > credentials.json > "" (empty = not configured). */
export function resolveApiKey(flagKey: string | undefined, envKey: string | undefined, credsPath?: string): string {
  return flagKey ?? envKey ?? loadCredentials(credsPath)?.apiKey ?? "";
}

/**
 * `membral login`'s own URL chain (3C-3): flag > env > DEFAULT_API_URL,
 * trailing slashes stripped — same `??`/trim shape as resolveApiUrl above,
 * but deliberately does NOT read credentials.json. Login is what WRITES
 * that file, so consulting it here would let a stale saved URL decide where
 * a fresh sign-in goes; every other command reads the file (via
 * resolveApiUrl/resolveCredentials), only login skips it.
 */
export function resolveLoginUrl(flagUrl: string | undefined, envUrl: string | undefined): string {
  const url = flagUrl ?? envUrl ?? DEFAULT_API_URL;
  return url.replace(/\/+$/, "");
}

export type CredentialSource = "flag" | "env" | "credentials" | "none";

export interface ResolvedCredentials {
  apiKey: string;
  apiKeySource: CredentialSource;
  apiUrl: string;
  apiUrlSource: CredentialSource;
}

export interface ResolveCredentialsInput {
  flagKey?: string;
  flagUrl?: string;
  /** Caller passes `process.env.MEMBRAL_API_KEY` explicitly (never read here) so tests never depend on the real shell environment. */
  envKey?: string;
  envUrl?: string;
  defaultUrl: string;
  credsPath?: string;
}

/**
 * THE resolver every command should call (issue #136, deliverable 1). Pure,
 * synchronous, never touches the network — just decides which of
 * flag/env/credentials.json/default wins for the key and the URL
 * independently, and reports WHICH source won as `apiKeySource`/
 * `apiUrlSource` so callers can print/log it (status, whoami, the agent
 * loop's 401 message) instead of a bare, unexplained key.
 *
 * Precedence for both apiKey and apiUrl: flag > env > credentials.json >
 * default ("" for the key — there's no sane default key — `defaultUrl` for
 * the URL). This function does NOT know whether the resolved key actually
 * works — see resolveValidatedCredentials for the network-validating,
 * env-can-fall-back-to-credentials-json variant setup/login use.
 */
export function resolveCredentials(input: ResolveCredentialsInput): ResolvedCredentials {
  const creds = loadCredentials(input.credsPath);

  let apiKey: string;
  let apiKeySource: CredentialSource;
  if (input.flagKey) {
    apiKey = input.flagKey;
    apiKeySource = "flag";
  } else if (input.envKey) {
    apiKey = input.envKey;
    apiKeySource = "env";
  } else if (creds?.apiKey) {
    apiKey = creds.apiKey;
    apiKeySource = "credentials";
  } else {
    apiKey = "";
    apiKeySource = "none";
  }

  let apiUrl: string;
  let apiUrlSource: CredentialSource;
  if (input.flagUrl) {
    apiUrl = input.flagUrl;
    apiUrlSource = "flag";
  } else if (input.envUrl) {
    apiUrl = input.envUrl;
    apiUrlSource = "env";
  } else if (creds?.apiUrl) {
    apiUrl = creds.apiUrl;
    apiUrlSource = "credentials";
  } else {
    apiUrl = input.defaultUrl;
    apiUrlSource = "none";
  }

  return { apiKey, apiKeySource, apiUrl: apiUrl.replace(/\/+$/, ""), apiUrlSource };
}

const SOURCE_LABEL: Record<CredentialSource, string> = {
  flag: "the --api-key/--api-url flag",
  env: "the MEMBRAL_API_KEY/MEMBRAL_API_URL environment variable",
  credentials: "~/.membral/credentials.json (written by `membral login`)",
  none: "no configured source",
};

const KEY_SOURCE_LABEL: Record<CredentialSource, string> = {
  flag: "the --api-key flag",
  env: "the MEMBRAL_API_KEY environment variable",
  credentials: "~/.membral/credentials.json",
  none: "no configured source",
};

const URL_SOURCE_LABEL: Record<CredentialSource, string> = {
  flag: "the --api-url flag",
  env: "the MEMBRAL_API_URL environment variable",
  credentials: "~/.membral/credentials.json",
  none: "the default API URL",
};

/** Human label for a CredentialSource, generic (key or URL) — used in short log lines. */
export function describeSource(source: CredentialSource): string {
  return SOURCE_LABEL[source];
}

/** Human label specifically for where an API KEY came from. */
export function describeKeySource(source: CredentialSource): string {
  return KEY_SOURCE_LABEL[source];
}

/** Human label specifically for where an API URL came from. */
export function describeUrlSource(source: CredentialSource): string {
  return URL_SOURCE_LABEL[source];
}

/**
 * Masks an API key down to a short, unambiguous prefix (e.g. `lls_mT…`) —
 * enough for a human to tell two keys apart in a log/status line, never
 * enough to reconstruct the key. Never print a resolved key raw (req 5).
 */
export function maskApiKey(apiKey: string): string {
  if (!apiKey) return "(none)";
  // m2 (adversarial round 1): a key this short doesn't have 6 usable prefix
  // chars to mask down to without printing (nearly) the whole thing — treat
  // anything at/under 8 chars as unsafe to show any of, full stop.
  return apiKey.length <= 8 ? "…" : `${apiKey.slice(0, 6)}…`;
}

export type ApiKeyValidationStatus = "valid" | "invalid" | "unknown";

export interface ApiKeyValidation {
  status: ApiKeyValidationStatus;
  httpStatus?: number;
  error?: string;
}

// GET /api/code-sessions/stats?days=1 is the cheapest existing
// authenticated, read-only endpoint every credentialed CLI command already
// depends on transitively (it accepts the same unscoped `lls_` key as
// every other CLI-facing route, via authenticateCodeSessionsRead) — a
// 1-day window keeps the underlying code_sessions read small, so this is a
// genuinely cheap probe, not a synthetic "whoami" endpoint. Replaces
// GET /api/bridge/context (removed with the bridge, 2026-09-12 refocus
// goal's kill list). A 401 unambiguously means "this key is rejected by
// this URL"; anything else (network error, 5xx, ...) is "unknown" on
// purpose — a transient server hiccup must never look like a bad key and
// permanently block setup/login.
// The path (/api/code-sessions/stats?days=1) and the 10 s timeout live in
// lib/api-client.ts ENDPOINTS.validateKey (m4, adversarial round 1: a
// black-holed --api-url must not hang setup for undici's 300 s default).

/**
 * Never throws. Distinguishes a definite 401 (`invalid`) from everything else
 * (`unknown`) so callers never treat a network blip/timeout/wrong-endpoint as
 * a bad key. Runs through the policy client (endpoint "validateKey": 10 s, no
 * retry, a 401 is the answer, never an env-key fallback — the key under test
 * is sent as given).
 */
export async function validateApiKey(
  apiUrl: string,
  apiKey: string,
  fetchImpl?: typeof fetch,
): Promise<ApiKeyValidation> {
  if (!apiKey) return { status: "invalid", error: "no API key" };
  const client = createApiClient({
    credentials: { apiKey, apiKeySource: "flag", apiUrl, apiUrlSource: "flag" },
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  const result = await client.call<unknown>("validateKey");
  if (result.ok) {
    // m3 (adversarial round 1): a 200 alone isn't proof this is actually
    // the Membral API — a captive portal, a reverse proxy, or a typo'd
    // --api-url that happens to 200 would otherwise read as "key valid".
    // /api/code-sessions/stats's success body always has a top-level
    // `totals` object.
    const body = result.data;
    const looksLikeCodeSessionsStats =
      body !== null && typeof body === "object" && typeof (body as { totals?: unknown }).totals === "object";
    return looksLikeCodeSessionsStats
      ? { status: "valid", httpStatus: result.status }
      : {
          status: "unknown",
          httpStatus: result.status,
          error: "200 response did not look like /api/code-sessions/stats",
        };
  }
  switch (result.kind) {
    case "auth":
      return result.status === 401 ? { status: "invalid", httpStatus: 401 } : { status: "unknown", httpStatus: 403 };
    case "bad_json":
      return { status: "unknown", httpStatus: result.status, error: "200 response was not valid JSON" };
    case "http":
      return { status: "unknown", httpStatus: result.status };
    case "rate_limited":
      return { status: "unknown", httpStatus: 429 };
    case "network":
    case "timeout":
      return { status: "unknown", error: result.message };
    default:
      return { status: "unknown", error: "deferred" };
  }
}

/**
 * The env-key fallback rule the policy client applies after a 401 (design
 * note §4): only for a key that came from MEMBRAL_API_KEY, only when
 * credentials.json holds a DIFFERENT key, and only when that key was saved
 * for this same server (trimmed URLs equal) — a key is never sent to a host
 * it was not saved for, and a run is never moved to another server. Null when
 * there is nothing to fall back to. Reads the file each call (never throws).
 */
export function resolveKeyFallback(
  used: Pick<ResolvedCredentials, "apiKey" | "apiKeySource" | "apiUrl">,
  credsPath?: string,
): { apiKey: string; apiUrl: string } | null {
  if (used.apiKeySource !== "env") return null;
  let creds: Credentials | null;
  try {
    creds = loadCredentials(credsPath);
  } catch {
    return null;
  }
  if (!creds?.apiKey || creds.apiKey === used.apiKey) return null;
  const trim = (u: string) => u.replace(/\/+$/, "");
  if (trim(creds.apiUrl) !== trim(used.apiUrl)) return null;
  return { apiKey: creds.apiKey, apiUrl: trim(creds.apiUrl) };
}

export interface ValidatedCredentials extends ResolvedCredentials {
  validation: ApiKeyValidation;
  /** Set whenever an env key was tried first, got a definite 401, and a credentials.json fallback was tried (successfully or not) — a one-line warning/note callers should print (req 3, B1). */
  fallbackWarning?: string;
  /** Set only on the env-key-rejected path — whether ~/.membral/credentials.json existed at all, so describeAuthRejection's hint (m1) doesn't claim a nonexistent file was checked. Undefined when this path was never reached (credsExist is irrelevant to the other apiKeySource branches). */
  credentialsFileFound?: boolean;
}

/**
 * The network-validating resolver setup/login use before doing anything
 * consequential with the resolved key (req 2/3). Precedence rule, spelled
 * out because it's the whole point of #136:
 *
 *   - flag key: always used as-is, even if invalid — explicit user intent
 *     is never second-guessed by falling back to something else.
 *   - env key present: tried FIRST (matches resolveCredentials' plain
 *     precedence). If it validates (or the validation is merely
 *     "unknown" — see validateApiKey), it's used. If it gets a DEFINITE
 *     401 AND a different key is sitting in credentials.json, THAT key is
 *     validated too (against ITS OWN recorded apiUrl — the url/key pair
 *     `membral login` actually proved worked together — unless the caller
 *     passed an explicit --api-url flag, which still wins). If the
 *     credentials.json key validates, it's used instead, with
 *     `fallbackWarning` set so the caller can print a one-line notice
 *     naming the env var. This is what makes a stale shell-exported
 *     MEMBRAL_API_KEY self-heal instead of permanently shadowing a fresh
 *     `membral login`.
 *   - credentials.json key only (no env, no flag): validated as-is.
 *   - no key at all: reported `invalid` with no fallback to try.
 *
 * Never throws (validateApiKey never throws).
 */
export async function resolveValidatedCredentials(
  input: ResolveCredentialsInput,
  fetchImpl: typeof fetch = fetch,
): Promise<ValidatedCredentials> {
  const resolved = resolveCredentials(input);

  if (resolved.apiKeySource !== "env") {
    const validation = resolved.apiKey
      ? await validateApiKey(resolved.apiUrl, resolved.apiKey, fetchImpl)
      : ({ status: "invalid", error: "no API key configured" } satisfies ApiKeyValidation);
    return { ...resolved, validation };
  }

  const envValidation = await validateApiKey(resolved.apiUrl, resolved.apiKey, fetchImpl);
  if (envValidation.status !== "invalid") {
    return { ...resolved, validation: envValidation };
  }

  // The env key got a definite 401 — see if credentials.json has a
  // DIFFERENT key that validates. Issue #136 B1: an explicit --api-url
  // flag OR MEMBRAL_API_URL env var is the user's stated intent for THIS
  // run (e.g. a self-hoster pointing at their own instance) and must never
  // be silently swapped out for credentials.json's OWN recorded URL just
  // because that combination happens to validate — that would upload a
  // self-hoster's data to the wrong (possibly public) instance. The
  // fallback key is validated against whichever URL is actually explicit
  // for this run; only when NEITHER --api-url nor MEMBRAL_API_URL was
  // given (so resolved.apiUrl already came from credentials.json itself,
  // or the default) does the fallback fall back to credentials.json's own
  // recorded URL, same as before.
  const creds = loadCredentials(input.credsPath);
  if (creds?.apiKey && creds.apiKey !== resolved.apiKey) {
    const explicitUrl = (input.flagUrl ?? input.envUrl)?.replace(/\/+$/, "");
    const credsUrl = creds.apiUrl.replace(/\/+$/, "");

    // n1 (adversarial round 2): an explicit URL that differs from
    // credentials.json's own recorded URL means that (key, url) pair was
    // never proven to work together — `membral login` never validated it.
    // Skip the fallback attempt ENTIRELY rather than transmitting a
    // membral.me-minted key as a Bearer token to a foreign, unrelated host
    // (e.g. a self-hoster's instance) just to find out. Go straight to the
    // hard-stop message, which already names both URLs.
    if (explicitUrl && credsUrl !== explicitUrl) {
      return {
        ...resolved,
        validation: envValidation,
        credentialsFileFound: true,
        fallbackWarning:
          `The MEMBRAL_API_KEY environment variable was rejected (401) by ${resolved.apiUrl} (from ` +
          `${URL_SOURCE_LABEL[resolved.apiUrlSource]}). A different key exists in ~/.membral/credentials.json, ` +
          `but it's recorded against ${credsUrl}, not ${resolved.apiUrl} — that untried (key, url) pair was never ` +
          `sent anywhere, since an explicit URL was configured for this run and is never silently swapped out. ` +
          "If you meant to use that account, unset MEMBRAL_API_URL (or drop --api-url) and re-run.",
      };
    }

    const fallbackUrl = explicitUrl ?? credsUrl;
    const fallbackUrlSource: CredentialSource = input.flagUrl ? "flag" : input.envUrl ? "env" : "credentials";
    const credsValidation = await validateApiKey(fallbackUrl, creds.apiKey, fetchImpl);

    if (credsValidation.status === "valid") {
      return {
        apiKey: creds.apiKey,
        apiKeySource: "credentials",
        apiUrl: fallbackUrl,
        apiUrlSource: fallbackUrlSource,
        validation: credsValidation,
        credentialsFileFound: true,
        fallbackWarning:
          `The MEMBRAL_API_KEY environment variable was rejected (401) by ${resolved.apiUrl} — using the key ` +
          `from ~/.membral/credentials.json instead, validated against ${fallbackUrl} ` +
          `(${explicitUrl ? `the same ${fallbackUrlSource === "flag" ? "--api-url flag" : "MEMBRAL_API_URL"} this run was already configured with` : "its own recorded API URL"}). ` +
          "Run `unset MEMBRAL_API_KEY` (or remove it from your shell profile) so this stops happening.",
      };
    }
  }

  return { ...resolved, validation: envValidation, credentialsFileFound: creds !== null };
}

/**
 * Builds the "stop before writing plist/MCP config" message (req 2) for the
 * case resolveValidatedCredentials came back `invalid` with no working
 * fallback. Names the source the rejected key came from and the URL it was
 * checked against (+ that URL's own source, so a key minted against
 * localhost that 401s against the hosted default is diagnosable at a
 * glance), plus a source-specific fix hint.
 */
export function describeAuthRejection(
  v: Pick<ValidatedCredentials, "apiKeySource" | "apiUrl" | "apiUrlSource"> &
    Partial<Pick<ValidatedCredentials, "credentialsFileFound">>,
): string {
  const head = `The API key from ${KEY_SOURCE_LABEL[v.apiKeySource]} was rejected by ${v.apiUrl} (401) — that URL came from ${URL_SOURCE_LABEL[v.apiUrlSource]}.`;
  let hint: string;
  switch (v.apiKeySource) {
    case "env":
      // m1 (adversarial round 1): don't assert a file was checked and found
      // wanting when there was no file to check at all — `credentialsFileFound
      // === false` means resolveValidatedCredentials's fallback attempt found
      // nothing on disk, not that it tried a key from there and failed too.
      hint =
        v.credentialsFileFound === false
          ? "Run `unset MEMBRAL_API_KEY` (or remove it from your shell profile) and re-run — " +
            "there's no ~/.membral/credentials.json either. Run `membral login` to sign in and create one."
          : "Run `unset MEMBRAL_API_KEY` (or remove it from your shell profile) and re-run — " +
            "no working key was found in ~/.membral/credentials.json either. `membral login` mints a fresh one.";
      break;
    case "credentials":
      hint = "Run `membral login` to sign in again and mint a fresh key.";
      break;
    case "flag":
      hint = "Check the --api-key value you passed, or run `membral login` and omit --api-key.";
      break;
    default:
      hint = "Run `membral login`, or pass --api-key <key>.";
  }
  return `${head}\n${hint}`;
}
