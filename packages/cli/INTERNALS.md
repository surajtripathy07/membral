# Internals — commands hidden from `membral --help`

`membral --help` lists 8 public commands. This file documents the other
6 that `packages/cli/src/index.ts` still dispatches — they're just not in
that top-level listing. Every one of them still has a real
`membral <cmd> --help` block (`packages/cli/src/help.ts`'s `HELP` record),
and every one appears in `membral help --all`, which lists everything.

(`start`, `continue`, `agent`, and `context` — along with the bridge daemon
they queued work to — and the repo-only `render-membral-md`/`draft-handoff`
pair were removed outright in the 2026-09-12 refocus goal (W2 kill list,
W3 docs collapse): `MEMBRAL.md` has no reader now that `CLAUDE.md` imports
`docs/HANDOFF.md` directly, so the render step was deleted rather than
moved, and the launchd sweep no longer calls it.)

They're hidden for the same reason across the board: no stranger following
the public setup flow (clone → `npm link` → `membral setup`) ever needs to
type one of these names. Hiding them is free — `packages/cli/src/__tests__/
help.test.ts`'s case-label test asserts each name below still has a live
`case` in `index.ts` and dispatches, so hiding never means "removed."

## `whoami`

Prints who you're signed in as (email, API URL, user id). Superseded on
the public surface by `status`, which prints the same information plus
device state — `whoami` is kept callable purely so a returning
`vercel`/`npm`/`railway` user's reflex (`membral whoami`) still works.
Invoked interactively, by a human, from a shell. Nothing bakes this name
into a file on disk.

## `import-session`

`membral import-session --transcript <path> [--source claude-code]`.
Uploads exactly one session transcript. Invoked by Claude Code's SessionEnd
hook (see `session-end-hook` below) — never typed by a human. **Name is
frozen from the first `npm publish` of this package (issue #118).** Not
frozen yet, because the maintainer is the only install today, but do not
rename it opportunistically: once frozen, a rename here breaks the same
way a `session-end-hook` rename would (see below), just one layer removed.

## `session-end-hook`

`membral session-end-hook [--api-url <url>] [--api-key <key>]`. Reads a
Claude Code SessionEnd hook payload off stdin, checks that `transcript_path`
is absolute, and hands the upload to a detached child of the same CLI
(`session-end-hook --deferred-path <transcript>`, API key via env
`MEMBRAL_API_KEY`, never argv), logging `{outcome:"deferred"}` to
`~/.membral/hook.log` and returning with no network I/O (#334: Claude Code
cancels SessionEnd hooks after 1.5 s unless the entry sets `"timeout"`, which
setup writes as 10). The child takes `~/.membral/deferred/<sessionId>.lock`
(waiting for a resumed session's earlier child), uploads, and logs the
outcome line. **Argv is baked into `~/.claude/settings.json`** by
`install-session-hook` (`packages/cli/src/configure.ts`,
`SESSION_HOOK_MARKER = "session-end-hook"`, L45). Claude Code invokes it
directly — no human ever types it. `hasMarker()` (`configure.ts` L217)
matches installed hooks by that same literal string, so a rename would break two
things at once: the already-installed hook silently stops uploading
anything, and `install-session-hook --remove` / a re-install would stop
recognizing the existing entry and leave an orphan hook behind. **Name is
frozen from the first `npm publish` (#118)** — do not rename before then
either; there is no reason to and every reason not to practice on it.

## `preamble`

`membral preamble --hook [--api-url <url>] [--api-key <key>]`. Reads a
Claude Code SessionStart hook payload off stdin, resolves repo/branch the
same way `session-end-hook`'s upload path does (`resolveGitRemote`, plus
the new `resolveGitBranch`, both in `packages/cli/src/git-remote.ts`), and
fetches `GET /api/memory/preamble`. On success it prints
`{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":
"..."}}` (capped at `MAX_INJECTED_LINES` = 12 lines) so Claude Code injects
that text at session start. **Argv is baked into `~/.claude/settings.json`**
by `install-session-hook` (`packages/cli/src/configure.ts`,
`PREAMBLE_HOOK_MARKER = "@membral/cli preamble --hook"`), the same way
`session-end-hook`'s marker is — a rename here breaks an already-installed
hook the same way. On ANY failure (no credentials, network error, non-2xx,
invalid JSON) it prints nothing and exits 0 — never blocks session start.

## `prompt-hook`

`membral prompt-hook [--api-url <url>] [--api-key <key>]`. Reads a Claude
Code UserPromptSubmit hook payload (`session_id`, `cwd`, `prompt`) off stdin,
skips slash commands and prompts under four words, resolves the repo the same
way `preamble` does, and sends `POST /api/memory/prompt-recall`
(`{prompt, repo, session}`) inside one 4 s budget. On a non-empty answer it
prints `{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit",
"additionalContext":"..."}}` (at most 4 lines, each cut at `MAX_LINE_CHARS`).
**Argv is baked into `~/.claude/settings.json`** by `install-session-hook`
(`PROMPT_HOOK_MARKER = "prompt-hook"`). On ANY failure it prints nothing and
exits 0 — never blocks or slows the prompt past its budget. Design:
`docs/design/prompt-time-recall.md`.

## `mcp-headers`

`membral mcp-headers --api-url <url>`. Codex's `http_headers_helper` for
`[mcp_servers.membral]` in `${CODEX_HOME:-~/.codex}/config.toml`, written by
`membral setup` (`packages/cli/src/codex-setup.ts`). Codex runs it through
`sh -c` with a cleared environment and reads one JSON object of headers from
stdout; this prints `{"Authorization":"Bearer <key>"}` with the key of the
saved profile whose server is `<url>`, so config.toml never holds the key.
No matching profile: prints nothing, exits 1. **Argv is baked into
config.toml** — a rename breaks Codex's MCP connection until setup re-runs.

## `install-session-hook`

`membral install-session-hook [--api-url <url>] [--settings <path>]
[--remove]`. Installs (or, with `--remove`, uninstalls) the SessionEnd
hook (`session-end-hook`, above), the SessionStart hook (`preamble`,
above) and the UserPromptSubmit hook (`prompt-hook`, above) into
`~/.claude/settings.json`, via `configure.ts`'s shared
`configureCommandHook` helper. Idempotent for each hook independently —
`membral setup` calls this itself (Step 6) for every machine with Claude
Code detected (2026-09-12 refocus goal, W4/D5, so PRODUCT.md's "sessions
are captured at session end" is actually true after setup runs; the
SessionStart half is P4 of the memory-on-prod-new-user goal); run it
directly only to reinstall by hand or to `--remove` both hooks. Argv is
not baked anywhere; it's typed directly by whoever runs it.

The hook commands carry no `--api-url`: the URL resolves at run time
(flag > env > the active profile in `~/.membral/credentials.json`), so
`membral use <profile>` re-points them. An older entry with `--api-url` is
rewritten on the next install.

## `sweep`

`membral sweep`. Run every 20 minutes by the launchd agent
`~/Library/LaunchAgents/me.membral.sweep.plist` that `membral setup`
installs on macOS (`--no-sweep` skips it). Imports every harness's
sessions that ended since the last successful sweep minus 5 minutes (the
last 24 hours on a first run; every 12th run is a full walk bounded to the
last 30 days, `import-window.ts`), then writes `~/.membral/sweep-state.json`.
Logs to `~/.membral/logs/sweep.log`. Code: `packages/cli/src/sweep-command.ts`.

## `dogfood`

`membral dogfood digest [--post] [--issue <n>] [--repo owner/name]` and
`membral dogfood candidates --out <path>` (recall-precision W3b, "Membral on
Membral"). Reads `GET /api/memory/dogfood`; `digest` prints the week's
markdown digest and with `--post` adds it to the rolling issue via
`gh issue comment`; `candidates` appends contradicted served records to a
JSON array, deduped by id, never to a bench/hold-out path. The sweep runs both
at most once per ISO week when `~/.membral/config.json` sets `dogfood.issue`
+ `dogfood.repo` and/or `dogfood.candidatesPath` (last week stored as
`dogfood_last_week` in `sweep-state.json`). Code: `packages/cli/src/dogfood.ts`.

---

## The one rename this package has made: `import-sessions` → `sessions`

Not a hidden command — `sessions` is public. Noted here because the old
name, `import-sessions`, is fully **removed**, not aliased: there is no
`case "import-sessions"` left in `index.ts`, and running it prints the
same "Unknown command" error as any other typo. This is a deliberate
departure from the "never remove a name" posture above — it was judged
safe specifically because `import-sessions` was never baked into a file on
disk (unlike every command in this document): every call site was a
typed-out invocation in a script or a doc, and all of them were updated in
the same change that removed the old name (the launchd sweep script, this
package's own comments, and the relevant `apps/cloud` code comments).
