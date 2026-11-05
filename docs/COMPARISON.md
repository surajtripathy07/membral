# How Membral compares

Membral is one of several ways to give a coding agent a past. This page compares it with the common approaches by
category, not by product, so every row describes how the approach works rather than any one tool's features. The
Membral column states only what the [README](../README.md) documents.

| | Hand-kept notes (`CLAUDE.md`, `AGENTS.md`, rules files) | Each agent's own transcript history | Hosted memory service | Membral |
|---|---|---|---|---|
| Where it lives | Files in your repo or home directory | Per-agent folders on disk | The vendor's servers | Docker on your machine (Postgres + pgvector) |
| Who writes it | You | The agent, automatically, as raw transcripts | Usually an extraction model the service runs | An extraction model you choose (Claude login, Ollama 7B+, or an API key) |
| Covers several agents | Only if you copy it between files | No, one store per agent | Depends on the service | Yes: Claude Code, Codex CLI, opencode, GitHub Copilot, Antigravity |
| Keeps the original words | Whatever you wrote | Yes, it is the transcript | Depends on the service | Yes: each decision and learning keeps its verbatim quote and links to the session turn |
| Search | Read the file, or `grep` | Per-agent resume or search, if offered | Depends on the service | By meaning (needs an embedder), keyword fallback, over MCP |
| Check a recalled fact against its source | You remember where it came from | Open the transcript yourself | Depends on the service | `get_code_session` with a `turn` shows the turns around the quote |
| Where session text goes | Stays where the file is | Stays on disk | To the service | Stays on your machine, except model calls: an API key sends session text to that provider, a Claude login sends it to Anthropic through Claude Code |
| Effort to keep current | Manual | None | Depends on the service | None after setup (end-of-session hooks plus a 20-minute sweep) |

## When each fits

- **Hand-kept notes** are the right place for rules every session must follow. Membral does not replace them; it
  records what happened and what was decided, not the standing rules you want applied.
- **Per-agent history** is enough if you use one agent and only need to resume a recent session.
- **A hosted service** suits you if you would rather not run containers and are fine with session text leaving your
  machine. Check each service's own documentation for what it stores and whether quotes are kept.
- **Membral** suits you if you use more than one agent, want recalled facts to carry their source, and want the store
  local.

## Limits of Membral

- One store per person; no team or admin controls yet.
- It is not live state: whether a PR is merged or what is deployed is checked in your forge.
- You run Docker (Compose 2.23+) and need one extraction model.
- Prompt-time lookup works in Claude Code only; the other agents get the session-start preamble and MCP search.
- Without an embedder, search is keyword-only.
