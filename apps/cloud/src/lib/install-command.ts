// The one CLI install command every page shows. Built from the app's own
// public URL (getAppUrl) so a self-managed install shows its own address.
// The CLI is served as a tarball at /membral-cli.tgz; it is not on npm.
//
// A fresh `membral setup` signs in to https://membral.me unless told
// otherwise (DEFAULT_API_URL, packages/cli/src/credentials.ts), so any other
// origin needs `--api-url`. Kept as a local constant: cloud does not depend
// on the CLI package.
const CLI_DEFAULT_API_URL = "https://membral.me";

export function installCommand(appUrl: string): string {
  const base = appUrl.trim().replace(/\/+$/, "");
  const install = `npm i -g ${base}/membral-cli.tgz`;
  const setup = base === CLI_DEFAULT_API_URL ? "membral setup" : `membral setup --api-url ${base}`;
  return `${install} && ${setup}`;
}
