# Contributing to Membral

## Quick start

```bash
gh repo fork surajtripathy07/membral --clone && cd membral    # forks, then clones your fork; needs Node 22.5 or newer
npx -y npm@11.19.0 ci                                          # the npm version package.json pins
npm run hooks:install                                          # runs the gate before every push
npm run ci:local                                               # the gate; prints RESULT PASS when green
git switch -c my-change && git commit -am "why, in 72 chars" && gh pr create   # after your edit; gh offers to push the branch to your fork
```

`npm run ci:local` runs the same checks CI runs (build, test, lint, typecheck) on your machine. It needs no
Docker and no Supabase; only `npm run ci:local -- --smoke` does. If it fails, re-run it once. If it fails
again, open an issue with the output.

New here? Pick an issue labelled
[good first issue](https://github.com/surajtripathy07/membral/issues?q=label%3A%22good+first+issue%22).
Each one lists the exact commands to reproduce it, where in the code to look, and what done looks like.
Comment that you are taking it, and ask in the issue if anything is unclear.


## How decisions work

Product decisions are the maintainer's. Propose a change through an issue before writing code.
Bug-fix and small PRs are welcome. Larger PRs are by invitation in the first months, so open an issue and wait
for a go-ahead.

Be kind. Critique code, not people. Assume good faith. If someone's behavior does not fit that, open an issue.

## Prerequisites

- **Node 22.5 or newer** (CI runs 22).
- **npm 11.19.0**, pinned by `packageManager` in `package.json`. The quick start installs it through `npx`.
- Docker and the [Supabase CLI](https://supabase.com/docs/guides/cli) only for cloud app work and `--smoke`.

`npm run hooks:install` points git at the committed `.githooks/`. The pre-push hook runs `npm run ci:local`;
`CI_LOCAL_SKIP=1 git push` skips it, with a warning. The pre-commit hook runs `scripts/check-scrub.sh`, which
does nothing unless you keep a local deny-list file.

## Day to day

```bash
npx turbo build|test|lint|typecheck        # everything
npx turbo test --filter=@membral/cli       # one package
npm run smoke                              # end to end: fixture sessions through the CLI to the dashboard
```

### Cloud app (only if you touch `apps/cloud`)

```bash
cd apps/cloud
npx supabase start
cp .env.example .env.local        # fill in the values printed by `supabase start`
npm run dev --workspace=@membral/cloud
```

Required: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`.
Optional: `OPENAI_API_KEY` (extraction). Do not run `npx turbo build` for
`@membral/cloud` while `next dev` is running: they share `.next` and corrupt each other.

### CLI and extension from your clone

CLI: `npx turbo build --filter=@membral/cli`, then `node packages/cli/dist/index.js <command>`.
Extension: `npx turbo build --filter=@membral/extension`, then load `packages/extension/dist/` as an unpacked
extension in `chrome://extensions/` with Developer mode on.

## Repository layout

```
packages/
  core/        # shared types, normalizer, session-parser interface
  cli/         # the `membral` CLI
  extension/   # Chrome MV3 extension (chat sync)
  test-kit/    # shared test helpers
apps/cloud/    # Next.js + Supabase app: dashboard, API, MCP at POST /api/mcp
```

One npm workspace driven by [Turbo](https://turbo.build). `@membral/core` holds everything shared and has no
runtime dependencies; every other package consumes its normalized shapes. [CLAUDE.md](CLAUDE.md) lists the
package layout and project rules.

## Code style

- **Formatter and linter**: [Biome](https://biomejs.dev), see [`biome.json`](biome.json). Run `npx turbo lint` before pushing.
- **Indentation**: 2 spaces, line width 120.
- **TypeScript**: strict. Avoid `any`; when you need an escape hatch, document why.
- **Comments**: explain *why*, not *what*.
- **Names in examples**: fictional ones (for instance CodeHub), never real people or companies.

If a file's existing style differs, match the file. Do not reformat unrelated lines.

## Testing

Every package uses [Vitest](https://vitest.dev). Run `npx turbo test`, or one package with `--filter=@membral/core`.
Watch mode: `npm run test:watch --workspace=@membral/cloud`. Mock `globalThis.fetch` or the SDK client for LLM
calls, and the Supabase client in cloud tests.

LLM output is always validated against a Zod schema, with a heuristic fallback on a malformed or empty reply.
Changes that alter extraction or parsing output update the matching golden file in the same PR.

## Pull requests

1. Fork the repo and branch from `main`.
2. One feature or fix per PR; link the issue it resolves.
3. Commit subjects of 72 characters or fewer, focused on *why*.
4. Add or update tests.
5. `npm run ci:local` prints RESULT PASS.
6. Fill in the [PR template](.github/PULL_REQUEST_TEMPLATE.md): a summary, related issues, screenshots for any UI
   change, and the testing checklist.
7. Be ready to iterate; review comments are conversations, not verdicts.

We will not merge PRs that bundle unrelated refactors, add dependencies without justification, break the public
type contract in `@membral/core` without a migration note, or make the local path depend on a remote service by
default.

## Reporting bugs and suggesting features

- **Bugs**: open an issue with the [bug report](.github/ISSUE_TEMPLATE/bug_report.md) template: version, OS and
  steps to reproduce.
- **Features**: use the [feature request](.github/ISSUE_TEMPLATE/feature_request.md) template: the problem first,
  the proposed solution second.
- **Security**: do not open a public issue. Follow [SECURITY.md](SECURITY.md).

Membral is released under the license in [LICENSE](LICENSE).
