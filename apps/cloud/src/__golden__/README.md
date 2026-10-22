# Golden snapshots (G0 behaviour lock)

`routes/` holds route contract tests (step 0.4). Each test calls a Next.js route
handler directly (no server) with the four externals mocked by `routes/boundary.ts`
(`@supabase/supabase-js`, `@supabase/ssr`, `next/headers`, `next/server` `after`),
all backed by one `@membral/test-kit` FakeDb per test seeded from
`routes/fixtures/seed.json`. Date is frozen at 2026-01-01T00:00:00Z,
`crypto.randomUUID` is a counter, and `after()` callbacks are recorded, never run.

Files: `<route>.<case>.json` = `{status, headers subset, afterCalls, body text}`;
`<route>.<case>.oplog.json` = every write/rpc the fake saw, in order.

Run (from `apps/cloud`, which owns the `@` alias):

    CI=true npx vitest run src/__golden__/routes

Record after an intended behaviour change, then review the diff:

    npx vitest run src/__golden__/routes -u

With `CI=true`, vitest never writes snapshot files: a changed or missing file
fails the run. A diff in a `.json` here is a contract change and needs a reason.

MCP `tools/call` snapshots use one argument object per tool
(`routes/fixtures/mcp-tool-calls.ts`). Tools backed by an SQL function (RPC) read
the seed through `routes/fixtures/mcp-rpc-handlers.ts`, which re-implements each
function's live migration body over the seed rows, including jsonb key order and
Postgres' JSON timestamp form. The graph-backed functions (`kg_*` tables) are
modelled only for an empty graph, which is what the seed has; a seed with `kg_*`
rows makes those handlers return an error rather than guess.
