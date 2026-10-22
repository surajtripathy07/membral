# Architecture

The one-page map for a builder who has never opened this repo. Product thesis: see the README.

## Layers

```
packages/core        types, normalizer, session parsers, harness registry   (no runtime deps)
   ^        ^
packages/cli   packages/extension                                            (import core only)
   |  HTTP (bearer key)
   v
apps/cloud           Next.js 15 App Router + Supabase                        (imports core)
```

- **core** (`packages/core/src`): everything shared; public surface is `packages/core/src/index.ts` only.
- **cli** (`packages/cli/src`): `membral` commands; reads transcripts through core's `PARSERS`, uploads to cloud.
- **extension** (`packages/extension/src`): Chrome MV3 service worker, no DOM APIs, CSS inline in HTML.
- **cloud**: `apps/cloud/src/lib` → `apps/cloud/src/app`, one direction only; lib never imports app (G5).

Cloud layering:

```
app/api/**/route.ts          one withRoute(...) call per HTTP method
app/(dashboard)/**/page.tsx  server components; data fetching in a sibling load.ts
        |
        v
lib/api/route.ts   withRoute: auth -> rate limit -> handler (+ CORS on every exit)
lib/api/{auth,errors,cors}.ts
        |
        v
lib/<aggregate>/   repositories + domain logic
   code-sessions/queries.ts  conversations/queries.ts  memory/queries.ts
   threads/queries.ts        api-keys.ts
   domain/  attribution/  memory/write/  memory/tail-capture.ts  llm/  util/
        |
        v
lib/db/types.ts (Db, TypedDb)   lib/db/clients.ts (service role)   lib/supabase/{server,client}.ts
```

## Where things go (cloud)

- **Clients.** `apps/cloud/src/lib/db/types.ts`: `Db` (untyped `SupabaseClient`) and `TypedDb` (typed on
  `apps/cloud/src/lib/database.generated.ts`). Service role only via `getServiceClient` / `tryServiceClient`
  (`apps/cloud/src/lib/db/clients.ts`); cookie-bound via `createClient` (`apps/cloud/src/lib/supabase/server.ts`).
  Construct clients nowhere else (G1, G2).
- **Repositories, one module per aggregate**, holding every Supabase query chain:
  `apps/cloud/src/lib/code-sessions/queries.ts` (typed on `TypedDb`), `apps/cloud/src/lib/conversations/queries.ts`,
  `apps/cloud/src/lib/memory/queries.ts`, `apps/cloud/src/lib/threads/queries.ts` (`listOpenThreads`),
  `apps/cloud/src/lib/api-keys.ts` (`revokeApiKey`). Signature `fn(db: Db | TypedDb, userId, ...)`: client first.
  User-scoped reads also filter `.eq("user_id", userId)` on top of RLS.
- **Routes.** `withRoute` (`apps/cloud/src/lib/api/route.ts`): auth `bearer` | `session` | `cron` | `none`
  (`apps/cloud/src/lib/api/auth.ts`), optional `rateLimit` and `cors`; handler errors are not caught. `apiError`
  in `apps/cloud/src/lib/api/errors.ts`; `corsPreflight` in `apps/cloud/src/lib/api/cors.ts` stays the route's own
  `OPTIONS` export. Shapes `withRoute` cannot express stay hand-written; its header comment lists them.
- **Pure domain rules** (one definition each; import, never copy): `apps/cloud/src/lib/domain/ladder.ts`
  (`REVIEW_RANK`, `BUILD_RANK`, `ROLE_RANK`), `apps/cloud/src/lib/domain/retire-reasons.ts`,
  `apps/cloud/src/lib/domain/recurrence.ts`, `apps/cloud/src/lib/domain/similarity.ts`,
  `apps/cloud/src/lib/domain/ref-identity.ts` (`issueMatchKey`).
- **Issue attribution.** `apps/cloud/src/lib/attribution/grounding.ts` (`qualifyIssueRef`,
  `GroundedSessionIssue`): grounds the issue/PR refs a session touched. No LLM calls.
- **Memory writes.** Import the barrel (@/lib/memory/write = `apps/cloud/src/lib/memory/write/index.ts`), never a
  sub-module. Pure planners decide (`planInsert` in `apps/cloud/src/lib/memory/write/insert.ts`, `planSupersede`
  in `apps/cloud/src/lib/memory/write/supersede.ts`, plus retire, blockers, recurrence, issues, lock);
  `apps/cloud/src/lib/memory/write/io.ts` does every read and write, in order.
- **Tail capture** (memory extraction after a session): `apps/cloud/src/lib/memory/tail-capture.ts`.
  `runTailCaptureForSession` → `runTailCaptureInner` runs `loadPhase` → `leasePhase` → `mainPassPhase` →
  `userPassPhase` → `blockerChecksPhase` → `persistPhase` → `issuesPhase` → `finalizePhase`. A phase that ends the
  run early returns `{ kind: "skip", result }`, which the orchestrator returns unchanged; new logic goes inside a
  phase or in a new phase using the same sentinel. Checkpoint maths: `apps/cloud/src/lib/memory/tail-capture/checkpoint.ts`.
- **Open-threads rule.** Add one pure detector to `CLOSURE_DETECTORS` in `apps/cloud/src/lib/threads/closure.ts`
  (ordered, strongest evidence first); `computeThreads` (`apps/cloud/src/lib/threads/open-threads.ts`) takes the
  first non-null answer.
- **Helpers.** `apps/cloud/src/lib/llm/` (LLM client, passes, spend ledger), `apps/cloud/src/lib/util/` (`runPool`,
  `selectAllRows`); server env in `apps/cloud/src/lib/env.ts` (G4). The chat knowledge graph is
  gone; `session_memories` is the memory store, and chats are still imported, stored and searched.

## Two search stores (decision #307, option B: document and connect)

`memory_search` and `search_conversations` read different stores on purpose.

| tool | store | what a hit is | window |
|---|---|---|---|
| `memory_search` | `session_memories` via `memory_search_scored` | an extracted, quote-verified, versioned record (decision, learning, outcome, blocker, preference) | extraction runs on sessions within about 30 days of upload; older extracted records stay searchable |
| `search_conversations` | `mcp_search_unified` over raw chat messages and code-session turns | what was said, unchecked and unversioned: true when said, not current | everything uploaded |

A fact that was said but never extracted (older than the extraction window, or not a record kind) answers only
from the second. The link between them: an empty `memory_search` answer carries a reason that names
`search_conversations` (`RAW_TEXT_POINTER` in `apps/cloud/src/lib/memory/search.ts`), both tool descriptions state their coverage,
and a code hit from `search_conversations` returns `session_id` (and `turn_idx`) for `get_code_session`. They are not
unified because raw turns carry no receipt or supersession (D-021, D-074). Meta-commentary about Membral is the
`feedback` kind, stored in `session_feedback`, which no search path reads.

## How to add

### A harness
1. Parser: packages/core/src/sessions/*id*.ts implementing `CodeSessionParser` (`source`, `detect`, `parse`;
   `packages/core/src/sessions/types.ts`). Model: `packages/core/src/sessions/opencode.ts`.
2. Fixture under `fixtures/sessions/` (one directory per harness, like `fixtures/sessions/opencode`) and a golden
   beside `packages/core/src/sessions/__tests__/golden/opencode.golden.test.ts`.
3. One registry row in `packages/core/src/sessions/registry.ts`: append the id to `HARNESS_IDS` and the parser to
   `PARSERS` (key order = default import order; `claude-code` stays first); update the pinned keys in
   `packages/core/src/__tests__/sessions/registry.test.ts` (`packages/cli/src/__tests__/sweep-command.test.ts`
   derives its expected import list from `PARSERS`, so it needs no update). Check:
   `npx turbo test --filter=@membral/core --filter=@membral/cli`.
4. The CLI picks it up via `Object.keys(PARSERS)` in `packages/cli/src/import-sessions.ts` (extend
   `defaultRootFor` there for a new default root). Cloud needs nothing: `RawCodeSessionSchema`
   (`apps/cloud/src/lib/code-sessions/payload.ts`) accepts any non-empty `source`.

### A route
1. One file apps/cloud/src/app/api/*path*/route.ts: `export const GET = withRoute({ auth: {...} }, handler)`, data
   through a repository function. Model: `apps/cloud/src/app/api/memory/branch-state/route.ts`.
2. A golden in `apps/cloud/src/__golden__/routes/` (model: `apps/cloud/src/__golden__/routes/agent-stats.test.ts`):
   externals mocked via `apps/cloud/src/__golden__/routes/boundary.ts`; `callRoute` + `expectContract` for no-auth,
   happy and malformed input; add `expectOplog` on a write path, `expectReadLog` on a read path (all in
   `apps/cloud/src/__golden__/routes/harness.ts`; seed: `apps/cloud/src/__golden__/routes/fixtures/seed.json`).
   Record once with `-u`, review the JSON diff, commit the snapshots with the test.

### A repository function
Lock the reads first (`expectReadLog` route golden, or a loader read-log test); then move the query chain verbatim
into the aggregate's module with `Db` (or `TypedDb`) as the first parameter. Read log and contract stay byte-identical.

### A memory write
A pure planner in `apps/cloud/src/lib/memory/write/` (rows in, plan out) with a unit test in
`apps/cloud/src/lib/memory/write/__tests__/`; `apps/cloud/src/lib/memory/write/io.ts` applies it; export via the
barrel. The pipeline goldens record every write: a changed db-oplog.json is a behaviour change needing a reason.

## The locks

- **Goldens**: routes `apps/cloud/src/__golden__/routes/` (route.case.json, .oplog.json, .readlog.json);
  pipeline `apps/cloud/src/__golden__/pipeline/` (three fixtures, LLM replayed; its `README.md`); parsers
  `packages/core/src/sessions/__tests__/golden/`; CLI `packages/cli/src/__tests__/golden/`. Run cloud ones with
  `CI=true npx vitest run --root apps/cloud src/__golden__` (with `CI=true` a changed snapshot fails, never writes);
  a fresh worktree needs `npx turbo build --filter=@membral/test-kit` first (the route harness imports `packages/test-kit/dist/`).
- **Corpus diff**: `node scripts/diff-run.mjs <old-sha> <new-sha>` byte-compares pipeline output at two commits.
- **Core surface**: diff the built dist/index.d.ts (`npx turbo build --filter=@membral/core`) before and after;
  a refactor's diff is empty. **DB types drift**: `npm run db:types:check --workspace=@membral/cloud`. **Mock paths**:
  `npm run check:mock-paths` (every `vi.mock` resolves and never targets a shim in `shims.txt`).
- **Ratchets** (may only fall): `npm run check:ratchets` runs `scripts/check-ratchets.mjs` against the baselines in
  `scripts/ratchets.json` (`--explain` lists files). At `PRE_G4` (851d9c9): G1 14 service-role key readers outside
  `apps/cloud/src/lib/db`, `apps/cloud/src/lib/supabase`, `apps/cloud/src/lib/env.ts`; G2 2 private
  `getServiceClient` factories; G3 a frozen 17-file set importing the since-deleted chat knowledge graph; G4 14 files with
  server-only `process.env` reads outside `apps/cloud/src/lib/env.ts`; G5 0 lib files importing app.
  After R5 (2026-10-06): G1 1; G2 1
  (`apps/cloud/src/lib/db/clients.ts`); G3 1; G4 0 (`apps/cloud/src/__golden__` excluded, as for G1); G5 0.
  After the KG deletion: G1 0, G3 0 (the graph code is gone).

## Rules that bite

1. Never `turbo build` the cloud package while `next dev` runs: they share `.next` and corrupt each other.
2. No scrub-list terms or real names in code, docs, commits or examples (hooks check a local, gitignored deny-list); use a fictional name such as CodeHub.
3. Validate every LLM JSON reply with a Zod schema; on malformed or empty output fall back to a heuristic, never throw.
4. Never retry a 429 immediately: back off proportionally, decay by 0.9x on success, never reset.
5. Cloud styling is tokens only: `apps/cloud/src/app/globals.css`; no raw `gray-*`.

## The gate

- The local gate is the merge gate: `npm run ci:local` runs `scripts/ci-local.sh`, the `gate` job of
  `.github/workflows/ci.yml` verbatim (synced by `scripts/check-ci-local-sync.mjs`); flags `--quick`,
  `--pure-move <base-sha>`, `--smoke`; receipt in .ci-local/ (gitignored). A merge to `main` needs a `--smoke` receipt.
- Hooks (`npm run hooks:install` once per clone): `.githooks/pre-push` runs the gate (`CI_LOCAL_SKIP=1` bypasses);
  `.githooks/pre-commit` runs the local scrub guard (a no-op without a deny-list);
  `.githooks/commit-msg` refuses a subject over 72 characters
  (`COMMIT_SUBJECT_OK=1` bypasses).
- Fresh worktree: plain `npm ci` works under npm 10.9.2 or npm 11 (the lock carries every
  optional-platform entry both require; `packageManager` pins npm@11.19.0, the version that wrote it).

## Programme rules

- Refactor commits change zero behaviour: pure moves (re-export shims listed in `shims.txt`) or compile-time
  guarantees; every lock stays byte-identical.
- A defect found while refactoring is filed as an `arch-review` issue, not fixed in the refactor commit.
- One PR per step, merged on a green gate plus an independent verification.

## Behaviour changes after the programme

A behaviour change is allowed when it is (1) the fix an issue asks for, (2) locked by an updated golden, readlog or
snapshot in the same PR (the diff is the evidence: `CI=true` goldens fail before the update, pass after), (3) covered by
the gate (`npm run ci:local`; pre-push hook), and (4) reviewed by a fresh ADV agent when it touches a write path, auth,
billing math, migrations or data retention. Defects found while fixing are filed as `arch-review` issues, not folded
in. One PR per issue into the phase branch; the phase merges to `main` on its attestation (a `--smoke` receipt for its
head).
