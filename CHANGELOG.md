# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `membral mcp` — a stdio MCP server in `@membral/cli`, with a slim non-root `Dockerfile.mcp` (#20).
- `excludePathPatterns` in `sync.json` to skip scratch projects when syncing sessions (#17).
- Semantic chat search on local embedding families (#30).
- The container image is now published for `linux/arm64` alongside `amd64` (#14).

### Changed

- MCP `session_summary` now serves a session's handoff note (#27).
- `membral local up/status/logs` have clearer help and diagnostics and accept `--project` (#15).
- Local images pull the caddy and node base images from ECR Public, and CI pulls base images from a GHCR mirror (#18).

### Fixed

- Empty session timestamps on import are treated as missing instead of failing (#28).
- Stopped an embedding storm caused by cross-linking sessions (#29).
- `membral sessions` fixes to the `--source` usage message and relative `--since` values (#16).

### Removed

- `@membral/mcp` (`mcp-local`) — the self-hosted stdio MCP server. Deprecated by ADR 0001's 2026-06-30 addendum (one store — Postgres only, no SQLite mirror; one MCP surface — the cloud app's `POST /api/mcp`) and removed in #40. `@membral/cli`'s `enable-memories` command, which only existed to configure this pipeline's Ollama dependency, was removed alongside it. `npx mcp-remote <url>` now bridges stdio-only clients to `/api/mcp` — see the README's "MCP Server" section.

## [0.1.0] - 2026-05-01

Initial tagged build. The source is open (MIT) but nothing has been published to npm yet; see
`README.md`'s "Open source, under MIT" note.

### Added

- `@membral/core` — common conversation schema and provider normalizers (ChatGPT, Claude, Claude Code).
- `@membral/extension` — Chrome MV3 extension that auto-syncs conversations from supported AI tools.
- `@membral/mcp` (`mcp-local`) — self-hosted stdio MCP server exposing `search_conversations`, `get_conversation`, `list_conversations`, and the memory-layer tools. **Removed** — see `[Unreleased] Removed` above.
- `@membral/cli` — `npx @membral/cli setup` for one-command local installs (npm publish never happened; the working install is `npm link` from a local clone — see `docs/SELF-HOSTING.md`) and `enable-memories` for opt-in extraction. `enable-memories` **removed** alongside `mcp-local` — see `[Unreleased] Removed` above.
- `@membral/cloud` — Next.js + Supabase cloud app with conversation dashboard, hybrid full-text + vector search, memory-layer view, and Stripe billing.
- Two-pass memory-extraction pipeline (per-conversation analysis + profile synthesis), running in the cloud on OpenAI. **The Ollama-backed local variant of this pipeline was removed in #40** — see the `[Unreleased] Removed` entry above; it never shipped as the default.
- Documentation: `README`, `CONTRIBUTING`, issue and PR templates.
