# Corpus differential run (G0 step 0.10)

`scripts/diff-run.mjs <old-sha> <new-sha>` runs the memory pipeline over one corpus at two commits and
byte-compares the outputs. It exits 0 only when every session's bundle is identical. `run-corpus.ts` is
the runner. It drives the pipeline golden harness (`../pipeline/harness.ts`) through the same stages:
import, tail capture with LLM replay, writes to the fake DB, then the preamble and open threads. It runs
under vitest because the harness relies on `vi.mock` and fake timers.

## Bundle

Each session gets one directory under the output root:

| File | Contents |
| --- | --- |
| `db-oplog.json` | Every write and RPC the fake DB saw, in order |
| `db-final.json` | A sorted snapshot of every table |
| `preamble.txt` | The preamble lines, then the recall token and open blockers |
| `threads.json` | The `listOpenThreads` result |
| `llm.jsonl` | Every chat call that was served |
| `misses.json` | Every LLM call with no recording (see below) |
| `error.txt` | Only when the run threw, for example on a transcript the parser rejects |

All JSON is stable (keys sorted, vectors digested) and comes from the harness's own serialiser.

## Sessions

- **`builtin/<fixture>`.** The three committed golden fixtures, with the golden test's definitions,
  replayed from their own `llm.jsonl`. Their bundles equal the committed golden artefacts.
- **`corpus<i>-<dir>/<relative path>`.** Every Claude Code `.jsonl` that carries a `sessionId`, and every
  opencode `.json` with a `session.id`, found under a corpus dir. The clock is frozen at the session's
  end plus one hour. Ids come from a counter reset per session, so a bundle does not depend on which
  sessions ran before it.

## LLM calls and misses

Corpus sessions are served from `replay-store/`, whose layout is described in `replay-store/README.md`.
Recording is not part of this step. The runner never calls the network and never fails on a miss: an
unrecorded call is appended to `misses.json` as `MISS key=<sha256 of request> n=<call #> user_head=...`
and thrown inside the model call. The pipeline swallows it as it swallows any LLM error. A miss is
deterministic, so old and new still diff meaningfully. A prompt change shows up as a changed
`misses.json`, and every stage that does not depend on the model is still compared.

## Self-test hook

`MEMBRAL_DIFFRUN_SELFTEST_PERTURB=1` appends a marker to every `preamble.txt`.
`node scripts/diff-run.mjs --self-test` sets it on the new side only, to prove that a difference is
detected.
