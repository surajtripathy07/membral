# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

## What Membral is

Membral is the session layer for coding sessions — every harness, one store. It normalizes
Claude Code and opencode session transcripts into one shape (turns, models, token usage, tools,
files touched, sub-agent tree, cost), with ChatGPT/Claude.ai chats as a secondary, ranked-second
input. The CLI puts sessions in, the web dashboard is where you read them, and MCP pulls detail back.

## Architecture

```
packages/core/       # Shared types, normalizer, session-parser interface (@membral/core)
packages/extension/  # Chrome MV3 extension, vanilla HTML+TS, no React (@membral/extension)
packages/cli/        # setup/login/status/import/sessions commands (@membral/cli)
apps/cloud/          # Next.js 15 App Router + Tailwind v4 cloud app (@membral/cloud)
```

- **core**: types, interfaces, normalizer, no runtime dependencies — everything shared goes here.
- **extension**: MV3 service worker, no DOM APIs; all CSS inline in HTML files.
- **cloud**: Supabase auth + Postgres + pgvector, no component library — all
  source under `apps/cloud/src/` (`(auth)` and `(dashboard)` route groups).

## Development

- `npm install` — install all workspace dependencies
- `npm run hooks:install` — once per clone: points `core.hooksPath` at the committed `.githooks/`
- `npx turbo build|test|lint|typecheck` — build/test/lint/typecheck all packages (add
  `--filter=@membral/cli` etc. for one package); CI runs all four on Node 20
- Cloud env: `cd apps/cloud && npx supabase start`, then copy the printed values into
  `apps/cloud/.env.local`; dev server: `npm run dev --workspace=@membral/cloud` on `:3001`
- `npm run smoke` — the end-to-end check: imports fixture sessions through the built CLI and
  asserts the dashboard renders them
- `npm run ci:local` — the CI gate, run by the pre-push hook; `--smoke` adds the end-to-end run

### Testing

- Vitest across all packages. `vi.fn()`/`vi.mock()`; mock `globalThis.fetch` or the OpenAI SDK
  client for LLM-call tests; mock the Supabase client in cloud tests.

## Rules that bite

1. **Never `turbo build` `@membral/cloud` while `next dev` is running** — they share `.next` and
   corrupt each other.
2. **No private names or real names in code, docs, commits, or examples** — the pre-commit scrub
   guard reads an optional, gitignored `.claude/scrub-list.txt`; use a fictional name like CodeHub.
3. **Always validate LLM JSON output against a Zod schema** — fall back to a heuristic path on a
   malformed or empty response, never throw.
4. **Rate limits**: never retry a 429 immediately; back off proportionally (bigger multiplier at
   small delay, smaller as delay grows) and decay on success by 0.9x, never reset to initial.
5. **Styling is tokens only** — `apps/cloud/src/app/globals.css` is the single token source;
   never use raw `gray-*` Tailwind utilities in cloud UI.
