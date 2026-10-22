// Local-stack mode (W7, docs/design/w7-one-command-local.md §6, §10, §11).
//
// `membral local up` runs this app in Docker with MEMBRAL_LOCAL=1. Hosted
// never sets it, and VERCEL is set on every Vercel build and function, so a
// stray MEMBRAL_LOCAL in a hosted project's env still cannot turn local-only
// surfaces on. Env is injected (the lib/llm convention) so tests pass a plain
// object and no server-only env read is added outside lib/env.

export function isLocalMode(env: Record<string, string | undefined> = process.env): boolean {
  return env.MEMBRAL_LOCAL === "1" && !env.VERCEL;
}
