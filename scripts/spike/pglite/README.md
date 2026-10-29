# PGlite spike

Spike, not shipped code. It answers: can the cloud data layer run on an embedded Postgres (PGlite, in WASM)
with no Docker? See `docs/design/2026-10-25_docker-free-store.md`.

How: all 133 migrations apply to PGlite after an auth prelude (`prelude.sql`: roles, `auth.uid()` and friends).
`shim.mjs` is a fetch shim that answers supabase-js (PostgREST) calls against PGlite, so cloud code runs
unchanged. `tests/callsites.test.ts` drives real cloud call sites (search, stats, extraction queue) through it.

The prelude mirrors Supabase's role setup and default privileges; the shim verifies an HS256 JWT, runs each request
in a transaction under `set local role anon|authenticated|service_role` with `request.jwt.claims` set, and binds
values as `$n` parameters. Shortcuts, so do not copy into product code: PostgREST subset only, a test JWT secret,
no statement timeouts per role, `search_path` comes from the connection rather than per-role settings.

Re-run, from the worktree root:

    npm i --prefix scripts/spike/pglite
    node scripts/spike/pglite/migrate.mjs              # migrations apply, cold start, RSS
    node scripts/spike/pglite/ablate.mjs               # which prelude parts the migrations need
    node scripts/spike/pglite/measure.mjs              # disk size, query timings
    node scripts/spike/pglite/socket.mjs               # pg clients over PGLiteSocketServer
    node scripts/spike/pglite/twoproc.mjs              # second process on the same dataDir
    cd apps/cloud && npx vitest run --dir ../../scripts/spike/pglite/tests                         # callsites as service_role + rls.test.ts
    cd apps/cloud && SPIKE_ROLE=authenticated npx vitest run --dir ../../scripts/spike/pglite/tests  # same call sites as user A's JWT
    node scripts/spike/pglite/mem.mjs '{}'                    # RSS/footprint: empty, 1k, 10k vectors (~1 min); pass PGlite options as JSON
    node scripts/spike/pglite/mem.mjs '{"postgresqlconf":"shared_buffers=8MB\nmax_connections=5"}' --onnx   # plus nomic q8 ONNX (first run downloads 137 MB)
    node scripts/spike/pglite/onnx.mjs                        # ONNX alone

Needs `npm ci` at the root first (the vitest run uses the cloud app's dependencies and `@/` alias).
Data dirs are created in the OS temp dir; the ONNX model caches under `node_modules/@huggingface/transformers/.cache`. The spike dir has its own `.gitignore` and `package.json`; it is
not a workspace and no gate (biome, turbo, tsc, vitest, coverage) includes it.

## Rung-two gate probes (2026-10-25)

Brief B0, no product code. Machine: this Mac (darwin arm64, Node 26.8.1, Next 15.5.14, PGlite 0.5.11 + pglite-pgvector), worktree at
`f1424fc3`. One native `MEMBRAL_STANDALONE=1 next build` of `apps/cloud` with a throwaway route (`probe/route.ts`, copied to
`apps/cloud/src/app/api/probe/route.ts`, removed afterwards), served with `node server.js` from `.next/standalone/apps/cloud`.
Data: `probe/seed.mjs` (134 migrations, 10,000 random 1536-d vectors in `session_memories`, HNSW built, NOT analyzed).
Driver: `probe/drive.mjs` runs every op against one server process. Raw output of the final run is in the session scratchpad only.

Reproduce (from the worktree root, after `npm ci` and `npm i --prefix scripts/spike/pglite`):

    node scripts/spike/pglite/probe/make-onnx.mjs $T/stand-in.onnx          # stand-in model, see caveat below
    node scripts/spike/pglite/probe/seed.mjs $T/seed                         # ~2 min
    cp scripts/spike/pglite/probe/route.ts apps/cloud/src/app/api/probe/route.ts
    git apply scripts/spike/pglite/probe/next.config.throwaway.diff           # serverExternalPackages, see result 5
    (build packages once: npm run build -w @membral/core -w @membral/test-kit -w @membral/cli)
    cd apps/cloud && MEMBRAL_STANDALONE=1 NEXT_PUBLIC_SUPABASE_URL=http://s.invalid NEXT_PUBLIC_SUPABASE_ANON_KEY=s NEXT_PUBLIC_APP_URL=http://s.invalid npx next build
    node scripts/spike/pglite/probe/drive.mjs apps/cloud/.next/standalone $T/seed $T/stand-in.onnx 3917
    node scripts/spike/pglite/probe/timeout.mjs ; node scripts/spike/pglite/probe/crash.mjs $T/crash 20
    # then revert: git checkout -- apps/cloud/next.config.ts && rm -rf apps/cloud/src/app/api/probe

**Caveat on the model.** The nomic q8 file (137 MB) is not cached on this machine and the brief forbids network calls, so the embedder
step loads `onnxruntime-node` (the real darwin arm64 binary the standalone trace shipped), imports `@huggingface/transformers`, and runs one
inference on a hand-built ONNX Gather model with a 135 MB initializer (`probe/make-onnx.mjs`). It stands in for the model's resident weights;
real nomic activation memory is not included. The earlier spike measured nomic alone at 244 MB footprint, and the stand-in added 231 MB
(420 to 651 MB), so the two agree to within about 10%. Re-run with the real model before the bar is treated as final.

### 1. Footprint of one Next process with PGlite (10k vectors) and the embedder: PASS (bar 1.2 GB)

| step (one process, in order) | RSS | physical footprint |
|---|---|---|
| Next standalone booted, nothing opened | 216 MB | 165 MB |
| PGlite opened on the 10k-vector dir (+pgvector, pg_trgm, unaccent), one count query | 531 MB | 420 MB |
| + onnxruntime-node + transformers imported, one embed call | 973 MB | 651 MB |
| after 5 + 40 + 20 searches, ANALYZE, HNSW rebuild | 1,028 MB | 560 MB |

Peak physical footprint of the process (`vmmap --summary <pid>`, "Physical footprint (peak)"): **780 MB**. PGlite alone is about 255 MB over the
Next baseline (420 minus 165); the embedder adds about 231 MB; the Next server itself is 165 MB. The whole process stays about 420 MB under the bar at its peak. RSS crosses 1.0 GB
(973 to 1,028 MB) because macOS counts the WASM heap's reserved pages; the design's bar is the footprint, which is what is quoted here.
Commands: `probe/drive.mjs` (reads `footprint <pid> --noCategories` and `vmmap --summary <pid>` per step). The earlier plain-Node figure
(PGlite 631 MB at 10k after migrating and seeding in the same process) is higher than the 255 MB here because that process also held the
seed/migration working set; opening an existing directory is cheaper.

### 2. Event-loop delay during `memory_search_scored` at 10k rows: the stall is the whole query, and a missing ANALYZE is a cliff

PGlite runs in the main thread, so a query blocks the loop for its full duration. Measured with a 5 ms `setInterval` (lateness per tick),
because `perf_hooks.monitorEventLoopDelay` under-reports here on Node 26 (6 ms over a 228 ms stall, `probe/eld-check.mjs`; the histogram value is
in the raw output as `histogramMaxMs_unreliable`). Query shape: `select count(*) from memory_search_scored(... p_query_embedding => <random 1536-d>)`.

| phase | n | query p50 | loop delay p50 / p99 / max |
|---|---|---|---|
| before ANALYZE (fresh bulk-loaded dir, no stats) | 5 | **108,433 ms** | stalled 108 s per query (max 109,406 ms) |
| `ANALYZE` itself | 1 | 192 ms | 187 ms |
| after ANALYZE | 40 | 121 ms (max 156) | 1.3 / **129** / 151 ms |
| `REINDEX` of the HNSW index (10k x 1536) | 1 | 44,667 ms | one 44.7 s stall |
| after the rebuild | 20 | 121 ms (max 131) | 1.3 / 128 / 128 ms |

Reading: with statistics, p99 loop delay is 129 ms, under the plan's 250 ms trigger for a worker thread. Without statistics the same query takes
108 s, so any dataDir built by bulk load or migration must run `ANALYZE` before serving (a scheduled ANALYZE alone is not enough: run it at boot
when the table has never been analyzed and after large imports). An HNSW build at 10k is a 45 s freeze of the whole server, so index builds
must be avoided at runtime (build once at migration, before listening). Concurrency was not measured (sequential requests only).

### 3. `set statement_timeout = 100; select pg_sleep(1)`: does NOT abort

`aborted: false, tookMs: 1001` inside the standalone server, and the same in plain Node (`probe/timeout.mjs`). `show statement_timeout` returns
`100ms`, so the setting is stored but never enforced. A CPU-bound query (`generate_series` cross join, 1.6 s) also ran to completion under the
100 ms setting. Risk R3 stands: no server-side timeout; rely on ANALYZE plus a latency log.

### 4. kill -9 durability: 20 of 20 rounds reopened clean, no corruption

`probe/crash.mjs`: each round spawns a writer (one row per transaction, 2 KB payload, prints after each commit returns), SIGKILLs it after a random
1.5 to 4 s, reopens the same dataDir, and checks the row set is a gapless 1..N prefix, N >= the last acknowledged write, and that an insert works.
Result: opens ok 20/20, prefix 20/20, every acknowledged write present 20/20 (the table grew to 234,900 rows over the rounds; N exceeded the last
ack by 0 or 1 each round, i.e. the one in-flight commit). No corruption, no recovery errors. Limit: this kills the process, not the machine; the OS page cache
survives a process kill, so power loss and fsync behaviour are untested.

### 5. Standalone trace on macOS

With the repo's config unchanged the build succeeds but **PGlite does not work from the standalone**: webpack bundles `@electric-sql/pglite` into the
route chunk, `new URL(..., import.meta.url)` then yields a URL object where a path is expected (`TypeError: The "path" argument must be of type string
or an instance of Buffer or URL. Received an instance of URL`), and the extensions fail with `Extension bundle not found:
/_next/static/media/pg_trgm.tar.<hash>.gz` (also `unaccent`). Only the `.data` file reached `.next/server/chunks/static/media/`.

Fix, the only change needed (`probe/next.config.throwaway.diff`, reverted after the probe): add both packages to `serverExternalPackages`:

    serverExternalPackages: ["@huggingface/transformers", "onnxruntime-node", "@electric-sql/pglite", "@electric-sql/pglite-pgvector"],

(I did not test each package alone.) The trace then copies the packages' files into `.next/standalone/node_modules/@electric-sql/`: pglite `dist/`
`pglite.wasm`, `pglite.data`, `initdb.wasm`, `pg_trgm.tar.gz`, `unaccent.tar.gz` plus the JS chunks (19 files); pglite-pgvector `dist/vector.tar.gz` plus
index.js/cjs (4 files). Compared with the installed packages, only contrib extensions the route does not import are absent (e.g. `citext.tar.gz`, `hstore`,
`ltree`): the trace follows static imports of `@electric-sql/pglite/contrib/*`, so any contrib extension the product adds must be statically imported
or named in `outputFileTracingIncludes`. No `outputFileTracingIncludes` entry was needed for the files used here.

ONNX on macOS: the standalone also contained `onnxruntime-node/bin/napi-v6/{darwin/arm64,linux/*,win32/*}` even though `STANDALONE_EMBEDDER_INCLUDES`
names only `linux/**`, and the native binding loaded and ran an inference on darwin arm64. So no ONNX include is missing for a native macOS run of
this build (the plan's note that darwin binaries would be absent did not hold; the includes list is not what puts them there, so do not rely on
it for other platforms or Next versions).

### Other findings

- After reopening an existing dataDir the session's `search_path` is `public` only (the prelude's `alter role ... set search_path` does not apply to
  the already-open session), so `::vector` fails with `type "vector" does not exist` until `set search_path = public, extensions` runs. The boot code must
  set it on open.
- Migrations: 134/134 applied (the spike README's 133 predates migration 134).
- Throwaway diffs: `apps/cloud/next.config.ts` (the line above, reverted) and `apps/cloud/src/app/api/probe/route.ts` (removed); `git diff --stat -- apps` is empty.
