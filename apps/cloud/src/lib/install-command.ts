import { isLocalMode } from "@/lib/local/mode";

// The CLI install command the pages show.
//
// Hosted app: the CLI is the tarball this app serves at /membral-cli.tgz. The
// tarball packed on Vercel already defaults to this origin (packages/cli/
// scripts/stamp-default-url.mjs), so no --api-url is needed.
//
// Local stack (MEMBRAL_LOCAL=1, see isLocalMode): the CLI is installed from a
// clone of the repository (`npm run cli:install` builds it and installs it
// globally); no tarball is promised. Starting the local stack is the next
// command, shown beside it on the pages that need it.
export const START_COMMAND = "membral local up --embeddings ollama";

/** The clone-and-build install; the landing page always shows this one. */
export function localInstallCommand(): string {
  return "git clone https://github.com/surajtripathy07/membral && cd membral && npm ci && npm run cli:install";
}

/** Hosted: install the served tarball, then sign in and wire hooks/MCP (membral setup). Local mode: the clone install. */
export function installCommand(appUrl: string, env: Record<string, string | undefined> = process.env): string {
  if (isLocalMode(env)) return localInstallCommand();
  const base = appUrl.trim().replace(/\/+$/, "");
  return `npm i -g ${base}/membral-cli.tgz && membral setup`;
}
