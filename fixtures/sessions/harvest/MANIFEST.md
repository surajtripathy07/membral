# Step 0.8 harvest — redacted session fixtures

14 redacted Claude Code e2e session transcripts, harvested from a local backup of e2e sessions in three batches: A fake
"CodeHub"-branded forge, C non-coding/edge cases incl. Hindi-language, R re-run.
Decision M3 (see `docs/design/architecture-refactor-programme.md`) called for a maintainer
sample review; on 2026-09-28 an automated privacy review replaced it, and its findings were
fixed by the rule changes listed under "Redaction" below.

Each `<dir>/` holds `transcript.jsonl` (the session), `meta.json` (batch/harness/turn_count/why),
and — for the two sessions that have one — a `subagents/` sidecar directory copied verbatim from
the source session. Redaction was applied by `redact.mjs` to fresh copies of the source
transcripts (see that file's header for the exact rule order); see counts below.

**Deviation from the brief:** the brief asked for 2 opencode sessions. The e2e harness that
produced this corpus only ran headless **Claude Code**; no opencode transcripts exist in it
(confirmed: no `*opencode*` session files under the batch homes). The two opencode-sized slots
were reallocated to two extra Claude Code picks for size variety instead (`r-large-billing-1`,
`a-large-billing-1`). Existing opencode fixtures already live at `fixtures/sessions/opencode/`
(unrelated, pre-existing, out of this harvest's scope).

## Sessions

| dir | batch | harness | turns | size | why selected |
|---|---|---|---|---|---|
| a-forge-ref-commit-1 | A | claude-code | 67 | 231K | commit/push naming an issue or PR ref (`Closes`/`Fixes #N`) |
| a-gh-pr-merge-1 | A | claude-code | 83 | 250K | `gh pr merge` output present |
| c-non-coding-notes-1 | C | claude-code | 35 | 178K | non-coding chat session (notes cwd, zero tool_use) |
| c-non-coding-tiny-1 | C | claude-code | 22 | 163K | non-coding, smallest real session in the corpus |
| c-hindi-sprachbox-1 | C | claude-code | 73 | 233K | Hindi-language session content |
| r-hindi-sprachbox-1 | R | claude-code | 103 | 275K | Hindi-language session, re-run batch |
| a-subagent-sidecar-1 | A | claude-code | 41 | 456K* | has sub-agent sidecar transcript dir |
| c-subagent-sidecar-1 | C | claude-code | 35 | 484K* | has sub-agent sidecar transcript dir |
| a-checkout-branch-1 | A | claude-code | 42 | 204K | checkout/branch switch present |
| c-large-longhaul-1 | C | claude-code | 764 | 992K | size variety: large, long-running edge case |
| a-nohook-medium-1 | A | claude-code | 66 | 228K | size variety: medium, no-hook persona variant |
| r-large-billing-1 | R | claude-code | 141 | 360K | size variety: large, re-run batch |
| r-nohook-medium-1 | R | claude-code | 120 | 308K | size variety: medium, re-run no-hook persona |
| a-large-billing-1 | A | claude-code | 262 | 532K | size variety: large |

\* size includes the `subagents/` sidecar.

Batch coverage: A ×6, C ×5, R ×3. Total on-disk size: 6.3 MB (well under the 25 MB / 2 MB-
per-session caps).

## Redaction

`redact.mjs` reads the real person name, account handle and repository name from the
gitignored `.claude/redact-private.json` and refuses to run without it, so no private literal
sits in this directory. Rule additions from the 2026-09-28 privacy review:

- the secret rule now needs a whole-word `sk-` key with at least 20 key characters (the old
  rule also rewrote ordinary words containing `sk-`, such as `<task-id>` markers);
- the real person name, whole word, case-insensitive -> `Dev Example`;
- the bare account handle (not only inside `owner/repo`) -> `codehub-org`;
- the repository name and its short variants -> `audiobooks`;
- `meta.json` no longer carries a hash of the source path.

Counts (run of 2026-09-28, from the source transcripts):

| rule | replacements |
|---|---|
| secret-shaped tokens (`lls_`/`sk-`/`ghp_`/`eyJ…`) -> `<redacted>` | 186 |
| macOS per-user home paths -> `/home/dev/` | 0 (corpus paths are dash-encoded, not slash-form; caught by the scrub-list step below instead) |
| real forge repo slug -> `codehub-org/audiobooks` | 112 |
| email addresses -> `user@example.com` | 137 |
| scrub-list terms (case-insensitive) -> `CodeHub` | 3260 |
| real person name -> `Dev Example` | 23 |
| bare account handle -> `codehub-org` | 14 |
| repository name and short variants -> `audiobooks` | 657 |
| `meta.json` source-path hash removed | 20 files |

Verification: the brief's three checks — a case-insensitive scan of every session and meta file
against the non-comment lines of `.claude/scrub-list.txt`, a scan for absolute per-user macOS home
paths, and a scan for personal-Gmail-style addresses — all print nothing against
`transcript.jsonl`, `meta.json` and the `subagents/` sidecars. (Not reproduced verbatim here: the
literal search patterns would otherwise flag this sentence too.)
