// Stamps the hosted origin into a packed CLI bundle.
//
// The CLI source default stays http://localhost:3000 (local-first, fc05cc82):
// every build that is not the hosted app's tarball keeps it. Only when
// apps/cloud's prebuild packs the tarball on Vercel does pack.mjs call this to
// rewrite the bundled default, so `npm i -g https://membral.me/membral-cli.tgz`
// followed by `membral login` signs in to the hosted app, not localhost.
//
// Pure functions on strings and an env object so they are unit-testable
// (packages/cli/src/__tests__/stamp-default-url.test.ts).

export const SOURCE_DEFAULT_URL = "http://localhost:3000";
export const HOSTED_FALLBACK_ORIGIN = "https://membral.me";

/** The origin to stamp, or undefined when this is not a hosted (Vercel) build. */
export function hostedOrigin(env) {
  if (!env.VERCEL) return undefined;
  const fromEnv = (env.NEXT_PUBLIC_APP_URL ?? "").trim().replace(/\/+$/, "");
  return fromEnv || HOSTED_FALLBACK_ORIGIN;
}

/**
 * Rewrites the bundled DEFAULT_API_URL declaration (exactly one must exist,
 * so a refactor cannot silently skip the stamp) and the "(default <url>)"
 * help text. Other localhost:3000 strings stay: the "local" profile's URL is
 * still localhost.
 */
export function stampDefaultApiUrl(bundle, origin) {
  const decl = new RegExp(`(\\bDEFAULT_API_URL = )"${SOURCE_DEFAULT_URL}"`, "g");
  const matches = bundle.match(decl) ?? [];
  if (matches.length !== 1) {
    throw new Error(`[pack-cli] expected exactly one DEFAULT_API_URL declaration to stamp, found ${matches.length}`);
  }
  return bundle
    .replace(decl, (_m, head) => `${head}${JSON.stringify(origin)}`)
    .replaceAll(`(default ${SOURCE_DEFAULT_URL})`, `(default ${origin})`);
}
