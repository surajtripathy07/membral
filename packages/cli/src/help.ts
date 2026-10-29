// The CLI's help surface — everything `membral --help`, `membral help --all`,
// and `membral <cmd> --help` print. Kept out of index.ts so it can be
// imported by tests without importing index.ts itself (index.ts is a
// top-level-await script whose import *is* its execution).
//
// Visibility model (see packages/cli/INTERNALS.md for the hidden ones):
//   - PUBLIC_COMMANDS: listed in TOP_LEVEL_HELP and in `membral help --all`.
//   - HIDDEN_COMMANDS: omitted from TOP_LEVEL_HELP, still dispatched,
//     still listed in `membral help --all`, documented in INTERNALS.md.
// Every name in both lists must have a matching `case` in index.ts, and
// every name in both lists must have an entry in HELP below so the
// before-any-side-effect help guard (index.ts) never prints `undefined`.

export const PUBLIC_COMMANDS = [
  "setup",
  "login",
  "logout",
  "use",
  "status",
  "import",
  "sessions",
  "local",
  "up",
  "down",
  "logs",
  "help",
] as const;

export const HIDDEN_COMMANDS = [
  "whoami",
  "import-session",
  "session-end-hook",
  "preamble",
  "prompt-hook",
  "mcp-headers",
  "mcp",
  "install-session-hook",
  "sweep",
  "dogfood",
] as const;

export type PublicCommand = (typeof PUBLIC_COMMANDS)[number];
export type HiddenCommand = (typeof HIDDEN_COMMANDS)[number];

// 2026-09-12 refocus goal, W4/D1/D5: the tagline (docs/PRODUCT.md's
// `Tagline: ` line, checked verbatim by scripts/check-thesis.sh) is the
// literal first line of this string — no leading blank line — so it is
// also the literal first line `membral --help` prints. Exactly the nine
// public commands below, one line each, from PRODUCT.md's Commands table.
export const TOP_LEVEL_HELP = `Your coding agent can answer from what your past sessions found, including what nobody wrote down.
Start: membral setup
Membral remembers what your sessions did, decided and found; it is not a live view of your forge.
Your agent checks a PR or issue's current state live.

Usage
  membral <command> [flags]

Commands
  setup      Sign in, scan harnesses, choose syncs, and run the first import
  login      Sign in through your browser
  logout     Sign out and forget the saved credentials
  use        List profiles, or switch between servers
  status     Show your account, this device, and what synced last
  import     Import a ChatGPT or Claude.ai export, or a claude-mem store
  sessions   Upload this machine's coding-session transcripts
  local      Run the whole server on this machine with Docker
  up         Run the whole server on this machine, no Docker (down, logs)
  help       Print this help, a command's help, or --all for hook internals

Flags
  --help, -h      Show this help, or a command's own help
  --version, -v   Show the version

Run \`membral <command> --help\` for that command's flags.
Run \`membral help --all\` for hook internals.
Docs: https://github.com/surajtripathy07/membral
`;

// `membral help --all` — the escape hatch for the hook internals only
// (HIDDEN_COMMANDS). The nine public commands already have their own
// listing in TOP_LEVEL_HELP; repeating them here would just be a second
// copy of the same nine lines to keep in sync, so this block names only
// the commands TOP_LEVEL_HELP omits.
export const ALL_COMMANDS_HELP = `Membral — hook internals.

These run automatically (installed by \`membral setup\`) or are for
maintainer use — see \`membral --help\` for the nine everyday commands.

  whoami                 Print who you're signed in as — status covers this
  import-session         Upload one session transcript — hook-invoked only
  session-end-hook       Upload the session named by SessionEnd hook input
  preamble               Print the memory preamble for a SessionStart hook
  prompt-hook            Print past work related to a prompt (UserPromptSubmit)
  mcp-headers            Print the MCP auth header for Codex (http_headers_helper)
  mcp                    Run a stdio MCP server (offline tool list)
  install-session-hook   Install or remove the Claude Code session and prompt hooks
  sweep                  Upload sessions ended since the last sweep (scheduled)
  dogfood                Weekly Membral-on-Membral digest and candidates

Run \`membral <command> --help\` for a command's own flags.
`;

export const HELP: Record<PublicCommand | HiddenCommand, string> = {
  setup: `Usage
  membral setup [--api-url <url>] [--api-key <key>] [--yes] [--exclude 1,3]
                [--device-name <name>] [--dry-run] [--copilot] [--copilot-cli] [--agy]

Set up this machine — sign in, choose what syncs, run the first import.

  1. Sign in through the browser (skipped if already signed in or --api-key
     is given).
  2. Confirm this machine's device name — prompts unless --device-name,
     MEMBRAL_DEVICE_NAME, or --yes is given.
  3. Scan for coding harnesses (Claude Code, Codex, opencode, Copilot CLI,
     Antigravity) on this
     machine.
  4. Choose what syncs — in a terminal, a checklist of the scanned
     projects (checked unless sync.json already excludes them; space
     toggles, a toggles all, enter confirms, arrows or j/k move). With piped stdin, a "[Y/n] or numbers to
     exclude" line instead. Skipped with --yes (sync everything) or
     --exclude (comma-separated numbers from the printed table).
     Written to ~/.membral/sync.json.
  5. Run the first import.
  6. Configure MCP for any detected AI tools.

Flags
  --api-url <url>       Server URL (default http://localhost:3000)
  --api-key <key>       Skips interactive sign-in
  --yes                 Accept every default without prompting
  --exclude <1,3,...>   Numbers from the scan table to exclude from sync
  --device-name <name>  Name this machine (also MEMBRAL_DEVICE_NAME)
  --dry-run             Preview every step, write nothing
  --no-sweep            Don't schedule the backstop sweep (launchd/systemd/cron)
  --no-prompt-recall    Don't send prompts for related past work (removes the
                        Claude Code UserPromptSubmit hook; remembered)
  --prompt-recall       Turn prompt recall back on
  --copilot             Also commit Copilot config into this repo for teammates
                        (.vscode/mcp.json, .github/copilot-instructions.md)
  --copilot-cli         Install the Copilot CLI hooks + MCP even if Copilot is not detected
  --agy                 Install the Antigravity hooks + MCP even if Antigravity is not detected

Also installs the Claude Code hooks, the opencode capture plugin
(~/.config/opencode/plugin/membral.js) and MCP for Claude Code/opencode. When the
Copilot CLI or VS Code is installed, it sets up Copilot for every repo: the
~/.copilot hooks + MCP and ~/.copilot/instructions/membral.instructions.md.
When Codex is installed, it writes [mcp_servers.membral] to
~/.codex/config.toml, a SessionStart preamble hook to ~/.codex/hooks.json
and a Membral block in ~/.codex/AGENTS.md (all under $CODEX_HOME if set).

Idempotent — running it again mostly just prints current status.`,

  login: `Usage
  membral login [--api-url <url>]

Sign in through your browser (device-authorization flow): prints a URL and
a confirmation code, tries to open your browser, polls until you confirm,
then saves ~/.membral/credentials.json (mode 0600). Ctrl-C cancels cleanly.

Flags
  --api-url <url>   Server URL (default http://localhost:3000)`,

  use: `Usage
  membral use [<profile>]

Switch which Membral server this machine talks to. Each \`membral login
--api-url <url>\` saves a profile named for its server (localhost ->
"local"; any other host keeps its hostname). No argument lists profiles
(* = active); a name makes it active and re-points Claude Code's and
opencode's MCP entry. Hooks, the opencode plugin and the sweep follow the
active profile — no re-setup.

  membral login --api-url http://localhost:3000   # once, creates "local"
  membral use local                                # talk to the local server`,

  logout: `Usage
  membral logout

Sign out and forget the saved credentials — deletes
~/.membral/credentials.json. Takes no flags.`,

  status: `Usage
  membral status [--api-url <url>] [--api-key <key>] [--rename <name>]
  membral status --server

Show your account, this device, and what synced last: signed-in account and
user id, device identity, the ~/.membral/sync.json allowlist, and the last
successful sweep. When a \`membral up\` server is running, its process, port,
health, store and data size come first; --server shows only that.

Flags
  --api-url <url>   Overrides the default API URL
  --api-key <key>   Overrides the saved/env credentials for this run
  --rename <name>   Persist a new name to this machine's device.json
  --server          Show only the \`membral up\` server's state`,

  import: `Usage
  membral import <file.json> [--api-url <url>] [--api-key <key>]
  membral import claude-mem [--db <path>] [--api-url <url>] [--api-key <key>]

Import a ChatGPT or Claude.ai export file — a conversations.json export
(detected automatically), uploaded in batches of 100 with a progress line.
A .zip export isn't unzipped automatically; extract conversations.json
first (the command prints the exact steps if it sees one).

\`import claude-mem\` reads a claude-mem SQLite store (default
~/.claude-mem/claude-mem.db; needs Node >= 22.5) and stores its observations
as Membral records labelled source claude-mem. Each links to the Membral
session with the same session id, so upload those transcripts first
(\`membral sessions\`); observations with no matching session are skipped and
counted. A record carries a quote only when its text appears verbatim in that
session's transcript. Re-running imports nothing twice.

Flags
  --db <path>       claude-mem database (import claude-mem only)
  --api-url <url>   Overrides the default API URL
  --api-key <key>   Overrides the saved/env credentials for this run`,

  sessions: `Usage
  membral sessions [--root <dir>] [--since <date|7d>] [--all]
                   [--dry-run] [--source <name>] [--force] [--full] [--api-url <url>]
                   [--api-key <key>]

Upload this machine's coding-agent session transcripts — walks
~/.claude/projects/**/*.jsonl (default root) and pushes them in batches.
Honors ~/.membral/sync.json: a project marked enabled:false there is
skipped, same as the always-on agent's sweep and the SessionEnd hook.

Only the last 30 days are uploaded by default (older sessions yield no
memories and cost storage); pass --all or --since <date> for older history (--since also takes 12h, 7d, 2w).

Resumes automatically: before uploading, asks the server which sessions it
already has unchanged (same turn count and end time) and skips them, so a
run interrupted by a crash or Ctrl-C, or run again on a new machine, only
sends what the server is missing.

Flags
  --root <dir>      Overrides the source's default root (requires --source)
  --since <date>    Only sessions active since this ISO date or relative
                     value (12h, 7d, 2w); overrides the 30-day default window
  --all             Upload all history, not just the last 30 days
  --dry-run         Preview without uploading
  --source <name>   claude-code, opencode, copilot-cli, codex or agy (default: all)
  --force           Re-parse and re-upload every session in scope, even
                     unchanged ones (implies --full; server overwrites and
                     re-queues memory extraction)
  --full            Skip the already-uploaded check and re-send every
                     session in scope, even ones already uploaded
                     (unlike --force, does not force a server-side
                     re-parse of sessions it already has unchanged)
  --api-url <url>   Overrides the default API URL
  --api-key <key>   Overrides the saved/env credentials for this run`,

  // Hidden commands still get a real block — the before-any-side-effect
  // guard in index.ts looks these up unconditionally, so every dispatched
  // name needs an entry even though none of these appear in TOP_LEVEL_HELP.
  whoami: `Usage
  membral whoami [--api-url <url>] [--api-key <key>]

Prints who you're signed in as (email + API URL + user id). Hidden — see
'membral status' for the listed equivalent, which prints the same plus
device state.`,

  "import-session": `Usage
  membral import-session --transcript <path> [--source claude-code]
                         [--api-url <url>] [--api-key <key>]

Upload one session transcript. Not for interactive use — this is what the
SessionEnd hook (installed by install-session-hook) shells out to after
every Claude Code session. Never exits non-zero and never blocks.`,

  "session-end-hook": `Usage
  membral session-end-hook [--stop] [--source copilot-cli|agy] [--api-url <url>] [--api-key <key>]

Not for interactive use — this is the command install-session-hook wires
into Claude Code's SessionEnd and Stop hooks. Reads the hook's JSON off stdin
and uploads the session it names. Never exits non-zero, never blocks.

Flags
  --stop                 Read Claude Code's Stop input (session still open):
                         upload the transcript so far in a detached child,
                         at most once a minute, without queueing extraction
  --source copilot-cli   Read Copilot CLI's sessionEnd input (setup --copilot-cli)
  --source agy           Read Antigravity's Stop input (setup --agy)`,

  preamble: `Usage
  membral preamble --hook [--format copilot|text|agy] [--api-url <url>] [--api-key <key>]

Not for interactive use — this is the command install-session-hook wires
into Claude Code's SessionStart hook. Reads the hook's JSON off stdin,
fetches the memory preamble for the session's repo/branch, and prints it as
SessionStart additionalContext. Never exits non-zero, never blocks, never
prints anything on any failure (no credentials, network error, bad
response).

Flags
  --format copilot   Read Copilot CLI's sessionStart input and print
                     {"additionalContext": ...} (setup --copilot-cli)
  --format text      Print the plain preamble body (the opencode plugin)
  --format agy       Read Antigravity's PreInvocation input and print injectSteps`,

  "prompt-hook": `Usage
  membral prompt-hook [--api-url <url>] [--api-key <key>]

Not for interactive use — this is the command setup wires into Claude
Code's UserPromptSubmit hook. Reads the hook's JSON off stdin, sends the
prompt to your Membral server, and prints up to three past records about
what the prompt names as UserPromptSubmit additionalContext. Skips slash
commands and prompts under four words. Never exits non-zero, never takes
more than about 2 seconds, never prints anything on any failure.`,

  mcp: `Usage
  membral mcp [--api-url <url>] [--api-key <key>]

A stdio MCP server for clients that cannot speak HTTP MCP. Reads
newline-delimited JSON-RPC on stdin, writes only protocol messages on stdout
(logs go to stderr). With a saved profile or --api-key it forwards each
request to <api-url>/api/mcp. With no key, or when the stack is unreachable,
it still answers initialize, ping and tools/list from a built-in tool list;
tools/call then returns an error saying to run \`membral local up\`.`,

  "mcp-headers": `Usage
  membral mcp-headers --api-url <url>

Not for interactive use — Codex runs this as the http_headers_helper of
[mcp_servers.membral] in ~/.codex/config.toml (written by setup). Prints
{"Authorization": "Bearer <key>"} using the saved key for <url> from
~/.membral/credentials.json, so the key never sits in config.toml. Exits 1
and prints nothing when no saved profile matches <url>.`,

  "install-session-hook": `Usage
  membral install-session-hook [--api-url <url>] [--settings <path>] [--remove]

Install (or --remove to uninstall) the Claude Code SessionEnd hook (uploads
each session), SessionStart hook (injects the memory preamble) and
UserPromptSubmit hook (injects past work related to each prompt) in
~/.claude/settings.json. Idempotent — safe to run more than once. 'membral
setup' calls this itself for every machine with Claude Code detected; run
it directly only to reinstall by hand or to --remove all three hooks.`,

  sweep: `Usage
  membral sweep [--remove]

Not for interactive use — setup schedules it every 20 minutes: the launchd
agent me.membral.sweep on macOS, the systemd user timer membral-sweep.timer
on Linux, or a marked crontab entry when user systemd is not available.
--remove unschedules it.

Uploads every harness's sessions that ended since the last successful
sweep, nudges memory extraction, then answers the server's ref-keyed questions about your own
commits and branches with read-only git (cat-file, merge-base, show-ref;
never a time range) so the dashboard can tell a merged thread from an open
one. Records the time in ~/.membral/sweep-state.json. Logs to
~/.membral/logs/sweep.log.

MEMBRAL_SWEEP_FETCH=1 opts into network: the sweep then runs
\`git fetch --prune origin\` in your checkout (updates and prunes your
remote-tracking refs) and \`git ls-remote\` to learn which branches are gone.`,

  dogfood: `Usage
  membral dogfood digest [--post] [--issue <n>] [--repo owner/name]
  membral dogfood candidates --out <path> [--days <n>]

"Membral on Membral": how recall did on your own sessions.

digest prints this week's markdown digest (served, used, contradicted,
empty searches, prompt-hook budget hits, feedback counts and the latest ten
feedback quotes with session links). --post adds it as a comment on the
rolling issue with \`gh issue comment\` (gh must be on PATH).

candidates appends served records your sessions contradicted (id, text,
quote, session link, contradicted-at) to a JSON array file, deduped by id.
It refuses a path that looks like a frozen bench or hold-out set.

The sweep runs both at most once per ISO week when ~/.membral/config.json
sets "dogfood": {"issue": <n>, "repo": "owner/name"} and/or
"dogfood": {"candidatesPath": "<path>"}. Off when unset.`,

  local: `Usage
  membral local up [--port <n>] [--gateway-port <n>] [--image <ref>] [--email <addr>]
                   [--embeddings ollama|none] [--embedding-model <name>] [--yes] [--no-sweep]
                   [--project <name>]
  membral local status [--show-password] [--project <name>]
  membral local down [--wipe [--yes]] [--project <name>]
  membral local logs [db|rest|app] [-f] [--project <name>]
  membral local reembed [--batch <n>] [--dry-run] [--project <name>]

Run Membral entirely on this machine with Docker. \`up\` writes a compose
stack to ~/.membral/local (Postgres, the data API and the Membral app,
which also serves sign-in and runs extraction), applies migrations, creates your one local user and an API
key, saves the "local" profile, makes it active, and points hooks and MCP
at it. Running it again changes nothing. Ports bind 127.0.0.1 only.

Nothing leaves the machine unless you add an LLM key to
~/.membral/local/.env; without one, extraction is off.

Flags
  --port <n>          App port (default 3000)
  --gateway-port <n>  Ignored (there is no gateway); kept so old commands run
  --image <ref>       App image (also MEMBRAL_IMAGE)
  --email <addr>      Local user's email (default you@membral.local)
  --embeddings ollama Local embeddings through the Ollama on this machine:
                      checks it answers (OLLAMA_HOST, default 127.0.0.1:11434)
                      and has the model, then writes
                      MEMBRAL_EMBEDDINGS_BASE_URL=http://host.docker.internal:11434/v1
                      and MEMBRAL_EMBEDDING_MODEL to ~/.membral/local/.env.
                      Kept by later plain \`up\` runs. The app container must
                      reach the host's Ollama through host.docker.internal.
  --embeddings none   Remove those two lines (back to the bundled model)
  --embedding-model <name>
                      Pulled Ollama model to use (default nomic-embed-text)
  --project <name>    Run a second stack beside the default one (also
                      MEMBRAL_LOCAL_PROJECT): compose project <name>, files in
                      ~/.membral/local-<name>, volumes suffixed -<name>. Pass
                      a --port that is free; give every command the same
                      name.
  --show-password     status: print the local user's password
  --wipe              down: also delete the database volume and the downloaded
                      Claude Code volume (asks first)
  --yes               up: accept setup defaults; down --wipe: skip the question
  --no-sweep          up: don't schedule the backstop sweep
  --batch <n>         reembed: rows per request (1-256, default 64)
  --dry-run           reembed: print counts per table and model; write nothing

reembed moves every stored vector to the embedding model the stack is now
configured with, after \`up --embeddings ollama --embedding-model <name>\`.
It runs one batch at a time against the app, prints progress, and can be
stopped with Ctrl-C and rerun: finished rows are never redone.`,

  up: `Usage
  membral up [--port <n>] [--server-dir <dir>] [--foreground] [--email <addr>] [--yes] [--no-sweep]

Runs the whole server on this machine as one process, with no Docker: the
Membral app on an embedded Postgres (PGlite) keeping its data in
~/.membral/local/pgdata. Starts it detached (log: ~/.membral/local/logs/server.log,
rotated at 10 MB, 3 kept), waits until its store is ready, creates your one
local user and an API key, saves the "local" profile, makes it active, and
points hooks and MCP at it. A second \`up\` while it runs just prints status.

The server build is looked up in --server-dir, then MEMBRAL_SERVER_DIR, then
apps/cloud/.next/standalone of the checkout you run this from.
Extraction uses \`claude\` when it is on PATH; otherwise put an API key in
~/.membral/local/.env (it stays off without one).

Flags
  --port <n>          Port on 127.0.0.1 (default 3000, then the saved one)
  --server-dir <dir>  Directory holding apps/cloud/server.js
  --foreground        Stay attached; Ctrl-C stops the server
  --email <addr>      Local user's email (default you@membral.local)
  --yes               Accept setup defaults (implied when stdin is not a terminal)
  --no-sweep          Don't schedule the backstop sweep`,

  down: `Usage
  membral down [--wipe [--yes]]

Stops the server started by \`membral up\` (SIGTERM, then waits up to 30 s for
it to exit and release the database lock). The data stays.

Flags
  --wipe   Also delete ~/.membral/local/pgdata (asks first; needs --yes when
           stdin is not a terminal)
  --yes    Skip the --wipe question`,

  logs: `Usage
  membral logs [-f]

Prints the last 50 lines of ~/.membral/local/logs/server.log. -f keeps
following it until Ctrl-C. For the Docker stack use \`membral local logs\`.`,

  help: `Usage
  membral help [<command>] [--all]

Prints the top-level help, a given command's help, or (--all) the hook
internals that the top-level help leaves out.`,
};
