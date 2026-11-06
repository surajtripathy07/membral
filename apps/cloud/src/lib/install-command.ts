import { isLocalMode } from "@/lib/local/mode";

// The CLI install command the pages show.
//
// Hosted app: the CLI is the tarball this app serves at /membral-cli.tgz. The
// tarball packed on Vercel already defaults to this origin (packages/cli/
// scripts/stamp-default-url.mjs), so no --api-url is needed.
//
// Local stack (MEMBRAL_LOCAL=1, see isLocalMode): one command installs and
// starts it, `npx membral local up` (the CLI is on npm); no tarball is
// promised. Contributors build the CLI from a clone instead (`npm run
// cli:install`, see CONTRIBUTING.md).
export const START_COMMAND = "npx membral local up --embeddings ollama";

/** The one-command local install and start; the landing page always shows this one. */
export function localInstallCommand(): string {
  return "npx membral local up";
}

/** Hosted: install the served tarball, then sign in and wire hooks/MCP (membral setup). Local mode: `npx membral local up`. */
export function installCommand(appUrl: string, env: Record<string, string | undefined> = process.env): string {
  if (isLocalMode(env)) return localInstallCommand();
  const base = appUrl.trim().replace(/\/+$/, "");
  return `npm i -g ${base}/membral-cli.tgz && membral setup`;
}
