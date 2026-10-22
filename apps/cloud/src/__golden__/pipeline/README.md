# Pipeline golden (G0 step 0.3)

This golden runs one session per fixture through the pipeline and compares every artefact byte for byte. The steps are:

1. The core parser reads the transcript.
2. The CLI builds its wire form (`sessionForWire`).
3. `RawCodeSessionSchema` validates it, as the route does.
4. `importCodeSession` writes the session.
5. `runTailCaptureForSession` extracts memories, with the LLM replayed.
6. `buildPreamble` and `listOpenThreads` read back what the next session would be served.

Each fixture directory holds these artefacts:

| File | Contents |
| --- | --- |
| `llm.jsonl` | Every chat call, keyed by sha256 of the full request body |
| `db-oplog.json` | Every write the fake DB saw, in order |
| `db-final.json` | A sorted snapshot of every table |
| `preamble.txt` | The preamble lines, then the recall token and open blockers |
| `threads.json` | The `listOpenThreads` result |
| `llm.jsonl` → `usage` | Prompt and completion token counts per recorded reply. USD is not stored; record-time spend was $0.006 for the two recorded fixtures |

## Determinism

This step is test-only: no production seam is used.

- **Clock.** `vi.useFakeTimers({ toFake: ["Date"] })` with `setSystemTime` freezes it. The fake DB stamps `created_at` from the same instant.
- **Ids.** `node:crypto` `randomUUID` is mocked to a counter. New rows get the fake's counter ids.
- **LLM.** `@membral/test-kit` `LlmReplay` serves the responses. In replay mode a cache miss throws and is also asserted empty, because extract.ts swallows LLM errors. Unused recordings also fail the test.
- **Embeddings.** Embeddings are hash vectors of the text. They are never recorded, and vectors are digested in the artefacts.
- **`windows.ts:125`.** This unordered `.limit()` is kept as it is. Each fixture seeds at most one `code_cross_links` candidate, so the fake's row order cannot matter.

## Reads are not locked

`recordReads` is off, and that is deliberate: the programme allows read-order changes when the output is unchanged. The op log therefore holds writes and RPCs only.

## Fixtures

- **`claude-code-small` and `opencode-small`.** Recorded once against the model in `apps/cloud/.env.local`. The model returned no records for either, so these two lock import, the props and checkpoint writes, the issue rows and the empty-extraction path.
- **`claude-code-rich`.** The fixture seeds a prior session, a live decision and an open blocker. `script.ts` supplies the model: it is hand-written, costs $0, and the production Zod parsers check every reply. The golden locks four effects:
  - an insert of the new decision and the new learning;
  - a supersede link from the new decision to the seeded one;
  - a semantic-duplicate merge that retires the seeded decision;
  - retirement of the seeded blocker as `resolved_later` through the later-session judge.

  `memory_semantic_duplicates` is a port of migration 101's SQL over the fake's rows.

## Commands

- **Replay** (the default; CI forces it):

  ```
  cd apps/cloud && CI=true npx vitest run src/__golden__/pipeline
  ```

- **Re-record.** Set `MEMBRAL_GOLDEN_RECORD=1` for every fixture, or give a comma list of fixture names. A scripted fixture records from `script.ts`; the others make paid calls.
- **Rewrite artefacts from a replay:** set `MEMBRAL_GOLDEN_UPDATE=1`.

## Not locked

- **Postgres semantics.** The golden locks the fake's semantics, not Postgres': row order, `.neq` as `or(...)`, and the projection shim in harness.ts.
- **Budget cuts and the deadline path.** The cap never binds, and Date is frozen, so the deadline never passes.
- **The rederive-only run.**
- **Sub-agent sessions.**
