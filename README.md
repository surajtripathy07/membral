# Membral

Your coding agent can answer from what your past sessions found, including what nobody wrote down.

In short: your coding agent can look up what past sessions found. A session is one conversation with Claude
Code, Codex, opencode or Copilot. Membral saves each one, so the next session can check what was already
decided instead of guessing, or redoing work that was settled ([Proof](#proof)).

For the outage question "how was production brought back after the database stopped responding", no run without
Membral said the database was restarted rather than restored, and every run with Membral did: 5 of 5 in each of
four recorded sets (one repository, one developer, hand-recounted answers).

Also measured: a power-user setup (an opus session that delegates to sub-agents) on six frozen tasks, five runs each. Membral helped where the answer lives only in past sessions and did not help where the code or your own notes already answer, or when resuming from a summary that holds the facts. Work on serving less stale and duplicate material is in progress and not yet at target.

Membral remembers what your sessions did, decided and found, even a few hours ago. It is not a live view of your forge: it hands your agent the PR or issue, and the agent checks its current state live.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

## Install

Needs Node 22.5 or newer. Membral runs on your own machine ([Run it locally](#run-it-locally) starts the app); the hosted service at membral.me stays up for existing accounts. Install the CLI, then:

```
npm i -g https://membral.me/membral-cli.tgz && membral setup
```

`membral setup` signs in to the server you point it at (nothing to paste), finds the coding agents on this machine,
asks which projects may sync, imports the last 30 days of sessions, and installs the hooks that save every
later session when it ends.

Using only Claude Code and happy to paste an API key? There is a two-line plugin alternative under
[Install in detail](#install-in-detail).

**What you see afterwards.** In Claude Code, on your next prompt, matching records from earlier sessions are
added to what your agent reads, each with the quote it came from and a link to the session. That lookup at
prompt time is Claude Code only. Sessions from Codex, opencode, Copilot and Antigravity are saved and searchable too, and
those agents can search them through the MCP tools, but they were not evaluated. The agent can also search for
more itself (`memory_search`, `memory_recall`; they reach it over MCP, the standard plug-in format agents use
for outside tools). `membral status` shows your account and what synced last (trimmed example):

```
$ membral status
Account:
  signed in as you@example.com (https://membral.me)
Sync:
  claude-code: 1/1 project(s) enabled
Last sweep:
  last success: 2026-01-01T00:00:00Z
```

The sessions are listed at membral.me, under Code.

## Proof

On one repository, with one developer and Claude Code only, five runs each way across four recorded sets: all five runs with Membral recovered an outage fact that no run without it did (the database was restarted, not restored), and Membral did not help where the code or your own notes already hold the answer. The runs were hand-recounted, and the harness is not part of this repository.

## What it does

Each coding agent (Claude Code, opencode, GitHub Copilot, Codex CLI, Antigravity) keeps its own transcripts in its own
format, on one machine, until it prunes them. Membral is the store underneath all of them: every session in
one shape, kept as long as you want, with its turns in order, the models, token usage, tools called, files
touched and sub-agent tree. Decisions, learnings and outcomes are extracted from them, each with a link back
to the session and the quote. Your ChatGPT and Claude.ai chats come in as a second input.

**Good uses:** decisions and settled designs; issues and PRs you created or worked on; outcomes and
measurements; mistakes and dead ends; what a parallel session did today.

**Not for:** whether a PR is merged, CI status, merge conflicts, issue status, or what is deployed.
Membral remembers what your sessions did, decided and found, even a few hours ago; it is not a live view of
your forge. It hands your agent the PR or issue and the agent checks its state live.

**Not yet:** team or admin controls, or one shared store for a team. Each developer installs it with their
own account, and their agent looks up their own sessions.

## Where your data goes

On the hosted service (membral.me) your sessions are stored in a Postgres database with row-level
security, hosted on Supabase and Vercel ([privacy page](https://membral.me/privacy)). What is saved: your
prompts, the agent's replies, which tools it called, which files it touched, and text it wrote to files
(capped). Tool output is not kept; secrets are redacted by pattern, and files such as `.env` keep no text.

Memory extraction is on by default: the server sends your session turns to a language model under the
operator's key (OpenAI, OpenRouter, Anthropic or Gemini, whichever the server is set to). The operator can
technically read stored data. You choose which projects sync during setup (`~/.membral/sync.json`; new
projects sync by default). Deleting means deleting the whole account; single sessions cannot be deleted yet.
The account export covers chats and accepted chat memories, not coding sessions. To keep everything on your
machine, see [Run it locally](#run-it-locally).

## Install in detail

Claude Code plugin instead of the CLI. Create an API key on your Membral server (or, with an existing hosted account, at membral.me) under Settings, Keys, then inside
Claude Code (it asks for the key and masks it):

```
/plugin marketplace add surajtripathy07/membral-plugin
/plugin install membral@membral
```

The plugin imports the last 30 days of Claude Code and opencode sessions in the background on your next
session. Without Node 22.5+ on your PATH, every session shows a hook error. If a session's upload fails, the plugin
catches up once a day.

`membral setup` installs capture for each agent found: Claude Code hooks, an opencode plugin, Copilot CLI hooks, Codex CLI
config, Antigravity hooks, MCP, and a 20-minute backstop sweep (launchd on macOS, a systemd user timer or cron on Linux;
`--no-sweep` skips it).

GitHub Copilot: plain `membral setup` covers it whenever the Copilot CLI or VS Code is installed (the
`~/.copilot` hooks, MCP server and `~/.copilot/instructions/membral.instructions.md`, for every repo).
`membral setup --copilot` inside a repo also commits `.vscode/mcp.json` and `.github/copilot-instructions.md`
for teammates.

Codex CLI: plain `membral setup` writes the Membral MCP server into `~/.codex/config.toml` (no key in the
file), a SessionStart hook for the preamble, and a short marked block in `~/.codex/AGENTS.md` that tells
Codex to call `memory_search` first. Codex asks you to approve the hook once; until then the AGENTS.md rule
still gives recall. Codex inside the ChatGPT app is not yet confirmed (#413).

opencode: the plugin injects the preamble into the system prompt at session start.

## Run it locally

Membral on your machine, in Docker. Nothing leaves the machine unless you set an LLM key or use your Claude
login, and then only model calls go to that provider (with the Claude login, the first start also downloads
Claude Code from npm once).

You need, in this order:

1. Node 22.5 or newer.
2. Docker with Compose 2.23 or newer, and at least 40 GiB of VM disk (a 20 GiB Colima VM ran out during the
   image build).
3. One way to run extraction: a Claude subscription (a token from `claude setup-token`, provider
   `claude-code`), an OpenAI or OpenRouter API key, or Ollama with a 7B or larger model (a 3B model did not
   store decisions durably).
4. Optional: an embedding model (Ollama or an API key). Without one, search is keyword only. The
   `claude-code` provider does not do embeddings.

The image does not include Claude Code: with `claude-code`, the first start downloads it from npm onto your
machine, unmodified, under Anthropic's terms, and it runs only locally with your own login (Claude Code's own
traffic to Anthropic applies). Membral is not affiliated with or endorsed by Anthropic. That first start
downloads about 110 MB (about 235 MB on disk) and gives it 4 minutes; if it does not finish, the app starts
with extraction off, `membral local status` says why, and `docker restart membral-app-1` tries again. Then
start:

```
npm i -g https://membral.me/membral-cli.tgz
mkdir -p ~/.membral/local && echo 'MEMBRAL_LLM_PROVIDER=claude-code' >> ~/.membral/local/.env   # or an API key, or Ollama
membral local up
```

Without any LLM, import, session pages, keyword search and MCP still work, but no memories are extracted.
`up` pulls the app image from `ghcr.io/surajtripathy07/membral-cloud:main`. To run from source instead, clone
the repo, then `docker build -f apps/cloud/Dockerfile -t membral-cloud:dev .` and
`membral local up --image membral-cloud:dev`. If `up` says the database is unhealthy, run
`membral local logs db` first (a full disk shows up there). Ollama setup, the image build, disk size, Linux
notes, embeddings and day-to-day commands: [docs/SELF-HOSTING.md](docs/SELF-HOSTING.md).

The Chrome extension syncs ChatGPT and Claude.ai chats to the hosted membral.me today; pointing it at a local stack is not supported yet.

`up` prints a sign-in URL and password, and an API key (treat that output as a secret). Sign in at that URL with the printed account (`you@membral.local`); to use a different local account, create one from the local server's sign-up page, or pass `--api-url http://localhost:3000` to `membral login`.

## Supported agents

| Agent | Capture | Sync | MCP | Preamble |
|---|---|---|---|---|
| Claude Code | yes | yes | yes | yes |
| opencode | yes | yes | yes | yes |
| GitHub Copilot (CLI + VS Code Copilot Chat) | yes | yes | yes | yes |
| Codex CLI | yes | yes | yes | yes |
| Antigravity | yes | yes | yes | yes |

Capture is the parser; sync is `membral sessions` plus the background sweep; MCP is recall; the
preamble is injected at session start. The lookup that arrives with each prompt is Claude Code only, and only
Claude Code was evaluated.

Each server you sign in to is a profile (`localhost` → `local`, `membral.me` → `prod`; `prod` is for people who already have a hosted account). Switch
with one command, no re-setup; hooks and the sweep follow the active profile:

```bash
membral login --api-url http://localhost:3000   # once
membral use local    # no argument lists profiles; an existing hosted account is `membral use prod`
```

## More

Coding sessions are primary; chats (ChatGPT, Claude.ai) come in through the Chrome extension
(`packages/extension`) or `membral import <export.json>`, ranked second.

- `npm run smoke` imports the Claude Code and opencode fixtures through the built CLI and checks the dashboard renders them
- `membral --help` lists every command; `membral <command> --help` gives its flags
- [docs/SELF-HOSTING.md](docs/SELF-HOSTING.md) — the whole stack on your machine in Docker
- [CONTRIBUTING.md](CONTRIBUTING.md) — clone to green gate to PR, in five commands
- [docs/DEPLOY.md](docs/DEPLOY.md) — hosted deployment walkthrough

## License

MIT — see [LICENSE](LICENSE). Source: [github.com/surajtripathy07/membral](https://github.com/surajtripathy07/membral).
