# Install, clean machine: `npx membral up` on a fresh Linux VM with no Docker

Date: 2026-10-25. Box 1.6 of `docs/goals/2026-10-25_beyond-claude-mem_goal.md` (Lever 1), V1.
Subject: commit `42febcd2` (branch `l1-npx`, `npx membral up` from a separate server package, with the pack and
server-dir fixes). Compare with `2026-10-25-npx.md` (macOS), `2026-10-25-rung2.md` and `2026-10-25-baseline.md`
(the Docker path). This is the second run; the first (commit `5df5de58`) is summarised at the end.

**Still not the published package.** The two tarballs were built in the VM and handed to npx as local files with
`-p ... -p ...`. Nothing was published; the registry was used only for the build's `npm ci` and by npx itself.

## Machine

- Lima 2.1.1 VM `membral-l1-clean`: Ubuntu 24.04 LTS, aarch64, 4 CPUs, 6 GiB, 30 GiB, no host mounts, no container
  runtime. Host: Apple M1 Max. A separate OS, not a scratch HOME.
- Reset before the run: user `dev` and its HOME, `/tmp/release` and every Membral process removed; Node kept (official
  `node-v22.23.4-linux-arm64` in `/opt/node`, symlinked into `/usr/local/bin`; this is the Node prerequisite, engines
  `>=22.5.0`).
- No-Docker proof, run as the fresh `dev` user before anything else: `command -v docker nerdctl podman claude` printed
  nothing (exit 1); `~/.membral` and `~/.claude` did not exist.

## Build step (the maintainer's release build, not the user's commands)

Source from `git archive 42febcd2`, piped in.

| Step | Wall |
|---|---|
| Copy source in | 1 s |
| `npx -y npm@11.19.0 ci` | 30 s |
| `node scripts/local/build-server.mjs --pack --pack-dest /tmp/release`, first try | 34 s, failed (below) |
| Same, after the workaround | 88 s |
| CLI pack | 2 s |
| Total | about 2 min 35 s |

Outputs: `membral-server-0.2.1-linux-arm64.tgz` (58.1 MB packed, 169.3 MB unpacked, 3,056 files, 24 bundled deps, 6 native
files) and `membral-cli.tgz` (0.17 MB). Generated server `package.json` fields: `"os": ["linux"]`, `"cpu": ["arm64"]`,
`"libc": ["glibc"]`; the build log says "os/cpu pinned to linux/arm64/glibc". The new libc pin therefore generated
correctly on Linux, and npx accepted it on this glibc machine (the user part ran); a musl machine was not tried. Source,
`node_modules` and the npm cache were then deleted.

Build problem still present (#584): the lockfile has no `@tailwindcss/oxide-linux-arm64-gnu` entry, so a clean `npm ci`
plus `next build` fails with "Cannot find native binding". Same workaround as the first run: `npm pack
@tailwindcss/oxide-linux-arm64-gnu@4.2.2`, unpack into `node_modules/@tailwindcss/`. Build-time only; not in the packed
server.

## User part

User `dev` (new account, empty HOME), `PATH=/usr/local/bin:/usr/bin:/bin`, stdin `/dev/null`, Docker and Claude Code
absent. Port **43117**, not 3000: Lima forwards guest loopback ports to the host and the host's 3000 was taken.

| # | Command | Wall s | Result |
|---|---|---|---|
| 1 | `mkdir ~/.claude` | 0.1 | **Stand-in for an installed Claude Code** (no login in the VM) |
| 2 | `npx -y -p /tmp/release/membral-server-*.tgz -p /tmp/release/membral-cli.tgz membral up --port 43117 </dev/null` | 22.6 | exit 0. `Server: ready`, user `you@membral.local (created)`, profile `local` saved and active, all six setup steps ran |
| 3 | `membral sessions --source claude-code --root <dir>` (4 CodeHub-style fixture sessions) | 21.9 | 4 of 4 imported (see the note on 4 errors below) |
| 4 | `membral import claude-mem --db claude-mem.db` | 14.7 | 10 inserted, 0 unmatched |
| 5 | MCP `tools/list` and `memory_search` over `POST /api/mcp`, key in a variable | not timed | 10 tools; non-empty records |
| 6 | `membral down` | 13.9 | `Stopped. Data kept`; port 43117 closed (guest `ss` empty, host `curl` exit 7) |

- **The line that matters for the fix:** the "Server dir:" line read `.../node_modules/@membral/server (from the
  @membral/server package next to this CLI)`. No version warning appeared anywhere in the `up` output.
- Each `membral` call through `npx -p <tarball>` pays about 13 s of npx overhead even when warm (`down` 13.9 s). A global
  install would not.
- **Commands typed:** 2 to a ready server (row 1 stand-in, row 2); 4 to a first non-empty search (rows 3-4 exist only
  because the VM had no sessions of its own). **Wall time to ready: 22.6 s. To a first non-empty search, command time
  only: about 59 s** (22.6 + 21.9 + 14.7), plus typing.
- Note on row 3: the fixture directory was copied from macOS with `tar`, which left AppleDouble `._*.jsonl` files beside
  the real ones; the CLI tried to import those too and 4 of them failed with `invalid input syntax for type timestamp
  with time zone: ""`. That is an artefact of my copy (deleted afterwards), not of a clean user's data, though it shows
  empty-timestamp transcripts are rejected rather than skipped. The 4 real sessions imported.

## What setup did on Linux

- No `launchctl`: setup installed a cron entry, `*/20 * * * *` running `membral sweep`, marked `# membral-sweep`
  ("Backstop sweep: installed (cron), every 20 min"). It points at the npx cache copy of the CLI, which lives only as long
  as npx keeps that folder; setup prints the "run `npm install -g @membral/cli`" warning for this. The cron firing was not
  waited for.
- Under `~/.claude`: `settings.json` with the SessionStart, SessionEnd and UserPromptSubmit hooks, command `"membral" ...`
  resolved from PATH. No `claude` on PATH, so setup printed the `claude mcp add-json` command and still said "MCP Claude
  Code: configured" (#583). `up` prints the generated key and password in clear (a throwaway for this VM).
- Under `~/.membral`: `credentials.json` (active profile `local`), `device.json`, `local/{.env,server.pid,logs,pgdata}`,
  `models/`.

## Health body

`GET /api/health` (from the host, through the forwarded port) returned `{"status":"ok","checks":{"supabase":"ok"},
"llm":{"configured":false,"provider":null,"model":null,"extraction":"off","embeddings":{"configured":true,
"model":"nomic-embed-text-v1.5-onnx-q8"}},"store":"ready"}`.

## Claude Code session (V1's last clause)

The VM has no Claude Code login, so this ran **on the host Mac against the VM's store**: Lima forwarded guest port
43117, host `curl http://127.0.0.1:43117/api/health` returned the body above. An MCP config (HTTP type, `Authorization:
Bearer <key>`, the route and header `membral setup` itself prints) was written with mode 600 from the VM's credentials
file via a pipe, then deleted afterwards. From an empty scratch directory, stdin closed:

`claude -p "Use the membral memory_search tool to search for 'queue' and quote the first result's text." --model haiku
--strict-mcp-config --mcp-config <file> --setting-sources "" --allowedTools mcp__membral__memory_search --output-format
stream-json --verbose`

No flag needed adjusting. Evidence in the stream-json: one `tool_use` of `mcp__membral__memory_search` and its
`tool_result` (1,191 characters, two records); before it Claude Code issued a `ToolSearch` to load the deferred MCP tool
(one extra `tool_use` and a `tool_reference` result, not counted as the search). The model quoted the first record: "Ack
before dequeue: Switched the worker to write the ack row before removing the job from the queue." (kind `decision`,
source `claude-mem`, repo `dev/acme-webapp`). Exit 0.

## memory_search over HTTP

`tools/list`: 10 tools. `memory_search` for `queue` returned the same fictional records as the Claude Code call. Extraction
was off (no `claude` or key in the VM), so the records come from the no-LLM claude-mem import path, as in rung two. The
embedding model (`nomic-embed-text-v1.5`, ONNX, 132 MB) downloads on first use and needs network then; it is already
on disk after command 3, and was not timed separately this run (the first run measured about 19 s).

## Footprint

- Server RSS 1,194,548 KB (about 1.14 GiB) after the model loaded and the searches.
- `local/pgdata` 63 MB; `models/` 132 MB; npx cache 347 MB (unpacked server and CLI).

## Against V1's target and the baseline

| | Target (V1 / P1) | Baseline (Docker path) | This run |
|---|---|---|---|
| Commands | at most 3 | about 12-14 | 1 (`npx ... membral up`), plus the `~/.claude` stand-in |
| Wall time excluding model downloads | at most 10 min | about 3.1 min, a lower bound | 22.6 s to ready; about 59 s to first non-empty search |
| Node | 22.5 or newer | n/a | 22.23.4 |
| Docker | absent | required | absent (`command -v docker nerdctl podman claude` printed nothing) |
| First non-empty `memory_search` | reached | not reached | reached over HTTP and from a real Claude Code session |
| Followed by one Claude Code session | yes | no | yes, but on the host against the VM's store (no login in the VM) |

## Not covered

- Claude Code running **inside** the VM, and a Claude Code that setup configured itself (the MCP entry was added by hand
  to a config file; `claude mcp add-json` never ran in the VM).
- A published package: no `npx membral up` without `-p`, no registry resolution of `@membral/server`.
- Other platforms (Intel Linux, musl, macOS Intel, Windows) and the wrong-platform refusal.
- The cron sweep firing, extraction, `--foreground`, `membral logs`, a 10k-row store, a multi-user machine.
- The Linux arm64 build needs the #584 workaround.

## First run (5df5de58)

Same VM, same flow with the first packing. Wall time to ready 29.5 s; the first non-empty search reached (about 77 s of
command time); RSS 1.08 GiB. It found the problems filed as #583-#587 (of which this file references #583, the "MCP configured" message when `claude` is
missing, and #584, the lockfile gap) and the packing and server-dir faults fixed in `42febcd2`. The Claude Code session
clause was not run then.
