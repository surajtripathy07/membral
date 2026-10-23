// The one CLI install command every page shows. The CLI is installed from a
// clone of the repository (`npm run cli:install` builds it and installs it
// globally); it is not on npm and no hosted tarball is promised. Starting the
// local stack is the next command, shown beside it on the pages that need it.
export const START_COMMAND = "membral local up --embeddings ollama";

export function installCommand(_appUrl?: string): string {
  return "git clone https://github.com/surajtripathy07/membral && cd membral && npm ci && npm run cli:install";
}
