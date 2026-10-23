// Manifest assembly for the extension build, kept out of vite.config.ts so a unit test can pin
// host_permissions for every build flavour without running vite.
//
// Which Membral does a build talk to?
// - VITE_MEMBRAL_PROD=1  -> the hosted instance, https://membral.me, and nothing else.
// - any other build      -> a local Membral (`membral local up`), http://localhost:3000 by default.
// - VITE_CLOUD_URL, when set, replaces the default target in either flavour.
// The ChatGPT and Claude.ai origins stay in manifest.json; the target origins are added here, never
// hard-coded in the checked-in JSON. Any other server the user types into the options page is reached
// through optional_host_permissions, requested at save time.

export interface BuildEnv {
  VITE_MEMBRAL_PROD?: string;
  VITE_CLOUD_URL?: string;
}

export interface BaseManifest {
  host_permissions: string[];
  [key: string]: unknown;
}

export const HOSTED_ORIGIN_PATTERN = "https://membral.me/*";
export const DEFAULT_LOCAL_PORT = "3000";
export const OPTIONAL_HOST_PERMISSIONS = ["http://*/*", "https://*/*"];

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);

export function isProdBuild(env: BuildEnv): boolean {
  return env.VITE_MEMBRAL_PROD === "1";
}

/** Origin match patterns for the VITE_CLOUD_URL override; a loopback host also gets its twin (localhost <-> 127.0.0.1). */
function patternsFromCloudUrl(raw: string): string[] {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return [];
    if (LOCAL_HOSTS.has(url.hostname)) {
      const port = url.port || (url.protocol === "https:" ? "443" : "80");
      return [`${url.protocol}//localhost:${port}/*`, `${url.protocol}//127.0.0.1:${port}/*`];
    }
    return [`${url.protocol}//${url.host}/*`];
  } catch {
    return [];
  }
}

export function targetHostPermissions(env: BuildEnv): string[] {
  // Mirrors DEFAULT_CLOUD_URL in src/sync/cloud-push.ts: the override wins, then the flavour default.
  const fromOverride = env.VITE_CLOUD_URL ? patternsFromCloudUrl(env.VITE_CLOUD_URL) : [];
  if (fromOverride.length > 0) return [...new Set(fromOverride)];
  if (isProdBuild(env)) return [HOSTED_ORIGIN_PATTERN];
  return [`http://localhost:${DEFAULT_LOCAL_PORT}/*`, `http://127.0.0.1:${DEFAULT_LOCAL_PORT}/*`];
}

export function buildManifest<M extends BaseManifest>(base: M, env: BuildEnv) {
  return {
    ...base,
    host_permissions: [...base.host_permissions, ...targetHostPermissions(env)],
    optional_host_permissions: OPTIONAL_HOST_PERMISSIONS,
  };
}
