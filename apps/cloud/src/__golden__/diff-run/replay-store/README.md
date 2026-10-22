# Replay store (G0 step 0.10)

`run-corpus.ts` answers a corpus session's LLM calls from this directory. `scripts/diff-run.mjs`
points both SHAs at the store in the live checkout, so old and new are served the same recordings.

## Layout

```
replay-store/
  <session-id>/llm.jsonl
```

- `<session-id>` is the session's bundle path in the diff-run output: `corpus<i>-<corpus dir name>/<path of
  the transcript relative to that dir>`, for example `corpus1-harvest/a1b2.jsonl/llm.jsonl`.
- `llm.jsonl` is the `@membral/test-kit` format (`toLlmJsonl`): one `LlmRecording` per line, keyed by
  `llmRequestKey`, the sha256 of the full request body. The body includes `model`, and corpus sessions run
  under the harness's scripted model id (`gpt-4o-mini`), so a recording only hits when it was made with that
  model id in the body.
- The built-in golden fixtures do not use this store; they replay their own
  `../pipeline/<fixture>/llm.jsonl`.

## Misses

Recording is not part of step 0.10, so the store starts empty. A call with no recording is a miss. The
runner appends `MISS key=<sha256> n=<call #> user_head=<first 120 chars>` to the bundle's `misses.json` and
throws inside the model call. The pipeline swallows the error the same way it swallows any LLM failure. It
never calls the network. A miss is therefore deterministic, and a request that changes between the SHAs
shows up as a changed `misses.json`.
