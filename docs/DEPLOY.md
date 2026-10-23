> Sign-ups at membral.me are closed. This file is the maintainer's runbook for the hosted deployment, not an install path for users; to run Membral, see [SELF-HOSTING.md](SELF-HOSTING.md).

# Deploying Membral Cloud (Vercel + hosted Supabase)

Issue #12. Cross-links: #31 (membral.me domain/landing — depends on this guide). Only the
local dev flow (`npx supabase start` + `npm run dev`) has ever been verified before this guide;
follow it in order and you should have a working hosted instance at `https://membral.me` (or
whatever domain you point it at) in under an hour.

This is the ONLY public domain this product has ever targeted — do not substitute `membral.com`
or anything else without a deliberate new decision.

---

## 0. Before you start

- A Vercel account with access to your own team (whatever Vercel team/org you're deploying under).
- A Supabase account (free tier is enough to start — see the pause-behaviour note in step 1).
- Registrar access for `membral.me` (GoDaddy, per step 3) — only needed for the DNS step.
- `.vercel/project.json` is NOT committed (it's gitignored — Vercel writes it locally the moment
  you run `vercel link`). If you're the maintainer working from the machine that already ran
  `vercel link`, it's sitting in your own checkout; anyone else (a fresh clone, a CI runner, an
  agent) must run `vercel link` themselves before `vercel --prod` will work — see step 2.
- `apps/cloud/vercel.json` (this repo) configures the build command; you DO still need to set
  **Root Directory = `apps/cloud`** in the Vercel dashboard once — see step 2.

---

## 1. Hosted Supabase project

1. Create a new project at <https://supabase.com/dashboard> (any region close to your users;
   Postgres major version doesn't matter here — migrations target 17 but Supabase hosted stays
   current).
2. Install/update the Supabase CLI locally if you haven't: `npm install -g supabase` (or use
   `npx supabase` — this repo already has it as a dev dependency of `apps/cloud`). If you don't
   already have `apps/cloud/supabase/.env` locally (it's gitignored — see issue #126 verification
   finding 9), copy the committed template first: `cp apps/cloud/supabase/.env.example
   apps/cloud/supabase/.env` — needed for any `npx supabase ...` command run from that directory,
   local or hosted-linked.
3. Log in and link the hosted project to this repo's `apps/cloud/supabase` directory:
   ```bash
   cd apps/cloud
   npx supabase login
   npx supabase link --project-ref <your-project-ref>   # from Project Settings -> General
   ```
4. Push every migration:
   ```bash
   npx supabase db push
   ```
   This applies `apps/cloud/supabase/migrations/001_conversations.sql` through the latest
   (`081_app_mode.sql` as of this writing — round-3 review MED 29: this used to say `077`,
   which predates the conversation-limit trigger (078), the signup kill-switch (079), budgets
   (080), and the open/hosted mode switch (081) — always applies whatever is newest, regardless
   of what's written here) in order.

   **Migration caveats to expect** (checked against every migration in this repo; nothing here
   requires editing a migration, just awareness of what `db push` will do):
   - `001_conversations.sql` runs `create extension if not exists vector with schema extensions;`
     — pgvector is officially supported and available by default on hosted Supabase, so this
     applies cleanly. It's the only `create extension` in the whole migration set.
   - `076_move_srf_to_internal_schema.sql` creates a schema named `internal` that is
     **deliberately not exposed over PostgREST** (issue #115 — some set-returning functions
     segfault the Postgres backend when called by a role that lacks `EXECUTE`, a Postgres bug,
     not fixable by granting `anon`; moving them to a schema outside `[api].schemas` removes the
     PostgREST route entirely rather than trying to out-ACL the bug). This matches the default
     hosted PostgREST config (`schemas = ["public", "graphql_public"]`, same as local — see step
     1b below), so it works with zero extra hosted configuration. Do not add `internal` to any
     exposed-schemas list.
   - Several migrations (070, 074, 076) use `current_user in ('service_role', 'postgres')` checks
     — both roles exist on every Supabase project, hosted or local, so this needs no changes.
   - `pg_cron` is mentioned only in a comment in `028_rate_limits.sql` as an optional future
     cleanup job (reaping abandoned rate-limit buckets) — nothing in the committed migrations
     actually creates a `pg_cron` job, so there is no hosted `pg_cron` extension dependency today.
   - No migration references `supabase_admin` or grants anything to a role that wouldn't exist on
     a hosted project.

   > **⚠️ 1a. Set hosted mode — do this immediately after `db push`, before anyone can reach the
   > app.** Migration 081 (issue #127 self-hosting decision) makes a fresh database default to
   > `open` mode — NO product constraints: `llm`/`embeddings` unlimited for every signup, no
   > 100-conversation cap. That default is correct for the local-run audience (README.md#run-it-locally); it is almost certainly NOT what you want on a public deployment sitting on your own
   > `OPENAI_API_KEY`. Set it to `hosted` once, right after the migration push:
   > ```bash
   > NEXT_PUBLIC_SUPABASE_URL=<hosted-project-url> \
   > SUPABASE_SERVICE_ROLE_KEY=<hosted-service-role-key> \
   > npm run flags --workspace=@membral/cloud -- mode hosted
   > ```
   > **Without this step, the public deployment runs fully unconstrained** — any stranger who
   > signs up gets unlimited `llm`/`embeddings` spend against your key and no conversation cap,
   > exactly as if you'd granted every account by hand. `npm run flags --workspace=@membral/cloud
   > -- mode show` (or `list`, which prints the mode first) confirms it stuck — it also now prints
   > how many `profiles` rows currently have a NULL `conversation_limit`, so you can SEE the size of
   > the exposure instead of having to go query it yourself. The monthly spend ceiling, rate limits and body-size caps stay on
   > regardless of mode.
   >
   > **The honest sequence, in order, every time you run `db push` against a project that's already
   > live (not just the very first deploy):** `npx supabase db push` -> `flags mode hosted` (above)
   > -> only THEN deploy/redeploy the app code (step 2). On an already-reachable site (e.g.
   > membral.me today, mid-redeploy) `db push` alone changes `handle_new_user()`'s behavior the
   > instant it runs — any account created between `db push` landing and `flags mode hosted`
   > landing gets `conversation_limit = NULL` (unlimited), and **migration 081 does not touch
   > existing rows**, so that account keeps unlimited conversations permanently unless you fix it by
   > hand. If that window wasn't zero (someone could sign up between the two commands), backfill it
   > afterward:
   > ```sql
   > -- Every profile with no explicit limit gets the normal hosted-mode default (100).
   > -- Exclude the operator's account(s) first if they should stay unlimited.
   > update public.profiles set conversation_limit = 100
   > where conversation_limit is null
   >   and id not in ('<your-own-user-id>'); -- replace with your own auth.users.id, or drop this line entirely
   > ```
   > `flags mode show` (above) tells you whether this backfill is even necessary — a NULL-limit
   > count of 0 (besides the excluded maintainer) means nobody signed up in the window.

   **1b. PostgREST exposed schemas / row cap** — `apps/cloud/supabase/config.toml`'s `[api]`
   section (`schemas = ["public", "graphql_public"]`, `max_rows = 1000`) only governs the LOCAL
   CLI stack. For the hosted project, confirm (Dashboard -> Project Settings -> API -> Exposed
   schemas / Max rows) that these match — `public` + `graphql_public` and `1000` are also the
   hosted defaults, so a fresh project should already agree; this is a "verify, don't assume" step
   if you've customized an existing project.

5. **Auth URL configuration** (Dashboard -> Authentication -> URL Configuration) — this is
   dashboard-only for a hosted project; `apps/cloud/supabase/config.toml`'s `site_url` /
   `additional_redirect_urls` fields only drive the LOCAL CLI stack (see the comment above those
   fields):
   - **Site URL**: `https://membral.me` (or your domain).
   - **Redirect URLs**: add `https://membral.me/**` (or your domain's equivalent) so both
     `/login` (email-confirmation and password-reset links) and any deep link work.
6. **Enable email confirmations for the hosted project — MUST be on, not optional** (Dashboard ->
   Authentication -> Providers -> Email -> "Confirm email"). Local dev leaves this OFF
   (`enable_confirmations = false` in config.toml, unchanged) so every local account keeps
   logging in immediately after signup — do not flip that local value. For hosted, turning it ON
   is required, not a nice-to-have: without it, this codebase's signup form
   (`apps/cloud/src/app/(auth)/actions.ts`) has **no signup allowlist or invite gate** — a public
   `https://membral.me/signup` with confirmations OFF lets anyone self-register with an email
   they don't own and be logged in immediately, AND (issue #126 finding 1) lets them squat any
   address later listed in `MEMBRAL_FEATURE_ALLOWLIST` before its real owner ever signs up —
   `hasFeature`'s allowlist-by-email path only honours a CONFIRMED email for exactly this reason.
   Turning confirmations ON requires outbound email to actually work — Supabase's built-in email
   sender has a low hourly rate limit (`[auth.rate_limit] email_sent = 2`/hour in config.toml, a
   LOCAL-only setting but a good proxy for hosted's own default); configure your own SMTP provider
   (Dashboard -> Authentication -> Email Templates / SMTP Settings) before relying on this for real
   signups. Do this BEFORE step 2's deploy goes live, not after.
7. **Free-tier pause behaviour**: Supabase's free tier pauses a project after 7 days with no API
   requests. A paused project 401s/times out on every request (including this app's `/api/health`
   probe — see step 4d) until you manually unpause it from the dashboard. If you're deploying for
   a low-traffic personal instance, either accept occasional manual unpausing, or upgrade to a paid
   plan before relying on always-on availability.
8. Copy the three keys you'll need for Vercel (Project Settings -> API): `Project URL`,
   `anon public` key, `service_role` key (server-only — never expose to the client).

---

## 2. Vercel

`apps/cloud/vercel.json` (issue #12) configures the build; it lives inside `apps/cloud` because
Root Directory MUST be set to `apps/cloud` in the dashboard for this monorepo (see below —
leaving Root Directory unset resolves the Next.js version from the REPO ROOT's `package.json`,
which has no `next` dependency at all and fails the build with "No Next.js version detected"):

```json
{
  "framework": "nextjs",
  "installCommand": "cd ../.. && npm install",
  "buildCommand": "cd ../.. && npx turbo build --filter=@membral/cloud",
  "functions": { "...": "maxDuration overrides for KG/import/sync/embed/code-sessions routes, globs relative to apps/cloud" }
}
```

**Required dashboard settings** (Project Settings -> General):
- **Root Directory**: `apps/cloud`.
- **"Include source files outside of the Root Directory"**: ON — this is what lets the build
  reach `packages/core` (`@membral/core`, imported by `apps/cloud` via `transpilePackages`) and
  the repo-root `turbo.json`/`package.json` workspaces config; without it, Vercel only uploads
  `apps/cloud` and the build can't resolve the workspace dependency at all.
- **Build Command / Install Command**: overridden by `apps/cloud/vercel.json` above (`cd ../..`
  steps back up to the true repo root so `npm install` links workspaces correctly and
  `turbo build --filter=@membral/cloud` builds `@membral/core`'s gitignored `dist/` before
  `@membral/cloud` needs it — `turbo.json`'s `build` task already depends on `^build` for this).
  Leave these at "Override" with the values from `vercel.json`; don't hand-type different ones in
  the dashboard.
- **Output Directory**: leave at the framework default (do NOT set `outputDirectory` — Vercel's
  Next.js builder ignores that setting for Next.js projects entirely; it locates `.next` itself
  relative to Root Directory).

**Setting Root Directory non-interactively** (for a driver/agent doing this without dashboard
access): the ids are in the LOCAL `.vercel/project.json` (gitignored, written by `vercel link` —
see step 0's note) —

```bash
PATCH https://api.vercel.com/v9/projects/<projectId>?teamId=<orgId>
Authorization: Bearer <a Vercel personal access token>
Content-Type: application/json

{"rootDirectory":"apps/cloud"}
```

Also enable "Include source files outside of the Root Directory" the same way — that flag is
named `rootDirectory` + a separate boolean; check the current
[Vercel Projects API docs](https://vercel.com/docs/rest-api/reference/endpoints/projects/update-an-existing-project)
for its exact field name before scripting this, since API field names do shift across versions.

**Environment variables** — Vercel Project Settings -> Environment Variables. Exact names, and
which are required (the app fails fast at boot in production if a required one is missing — see
`apps/cloud/src/lib/env.ts`'s `validateEnvAtBoot`, wired from `apps/cloud/src/instrumentation.ts`):

| Variable | Required? | Value for a hosted deploy |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | **Required** | from step 1.8 |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | **Required** | from step 1.8 |
| `SUPABASE_SERVICE_ROLE_KEY` | **Required** | from step 1.8 — server-only |
| `NEXT_PUBLIC_APP_URL` | **Required** | `https://membral.me` — include the scheme (`https://`); a bare hostname or a value with trailing whitespace fails `new URL()` at first render (see `layout.tsx`'s `metadataBase`) |
| `MEMBRAL_KG_MONTHLY_CEILING_USD` | **Required before your first real user** | a real USD figure (e.g. `25`) — if left unset in production the app now applies a conservative built-in default ($25/user/30-day) rather than running with no ceiling at all (see `.env.example`), but an explicit value you chose is always better than the fallback |
| `MEMBRAL_CONTEXT_ID_SECRET` | optional (recommended) | any long random string — falls back to a value derived from `SUPABASE_SERVICE_ROLE_KEY` if unset, which is safe but not independently rotatable |
| `OPENAI_API_KEY` | optional | unset => LLM/KG features (pass-1 extraction, embeddings, `kg:bootstrap`) are unusable, nothing else breaks |
| `MEMBRAL_MODEL` / `MEMBRAL_MODEL_BASE_URL` / `MEMBRAL_EMBEDDING_MODEL` / `MEMBRAL_EMBEDDINGS_BASE_URL` | optional | LLM pipeline tuning — see `.env.example` |
| `MEMBRAL_KG_ENABLED` | optional | `1` to auto-run pass-1 on sync/import |
| `MEMBRAL_KG_COST_CAP_USD` | optional | per-run spend guard — see `.env.example` |
| `MEMBRAL_FEATURE_ALLOWLIST` | **bootstrap-only fallback — not a standing config var** | `llm:<your-user-id>` (prefer your Supabase auth user id over an email — see step 2a below) — a maintainer self-enable path for BEFORE `scripts/flags.ts` has ever been run against this project. Remove it once you've granted your own row (step 2a); leaving it set is a bootstrap door left open longer than it needs to be. The `feature_flags` table (migration 077), granted via `npm run flags`, is the real, permanent gate — see issue #126. |
| `MEMBRAL_EMBED_DEFAULT_BUDGET_USD` / `MEMBRAL_EMBED_DEFAULT_DAILY_USD` | optional | issue #128 — default lifetime/daily USD budget applied to the `embeddings` feature for every account with no explicit `feature_flags` row (defaults `0.50`/`0.01` if unset). Embeddings are on-by-default at these budgets; `llm` is not (see next row). |
| `MEMBRAL_LLM_DEFAULT_BUDGET_USD` | optional | issue #128 — default lifetime USD budget applied to the `llm` feature (KG/portraits/bridge) for every account with no explicit grant. `0` (the default if unset) keeps `llm` off by default; a per-user teaser/full grant is `scripts/flags.ts grant` (see 2a below), never this var. |
| `MEMBRAL_LLM_DEFAULT_DAILY_USD` | optional | in `hosted` mode ONLY, bounds a "full" `llm` grant (an unlimited grant with no `--budget-usd`/`--daily-usd` of its own) to this much per day. Default `2` if unset. `open` mode and `grant --daily-usd none` are both unaffected — see `scripts/flags.ts grant`'s own help text. |
| `MEMBRAL_CONTACT_EMAIL` | optional | issue #128 — support address rendered in every "not enabled"/"allowance used up" message across the app and the API's own 403 body. Falls back to `support@membral.me` if unset. |
| `MEMBRAL_SIGNUPS_DISABLED` | optional | `1`/`true` = emergency kill-switch, refuses every new signup app-level ("Signups are currently closed."); unset/blank = signups open (default). **Only gates this app's form** — see §6 below for the authoritative hosted switch and the DB-level backstop. |
| `CRON_SECRET` | **required for the daily extraction cron on Vercel** | any long random string. Vercel sends it as `Authorization: Bearer $CRON_SECRET` on every cron-triggered request once this var exists in the project's environment — see §6's "Daily extraction cron" paragraph below. Unset => `GET /api/internal/cron/advance` 503s on every invocation (a safe "the cron simply doesn't run", not an open endpoint) — but the cron is meant to be the safety net for a granted user who stops syncing, so an operator who skips this loses that net silently unless they check the Vercel function logs. |
| `NEXT_PUBLIC_MCP_URL` | optional | only if MCP is served from a different host than the main app |

### 2a. Bootstrap your own access — do this BEFORE pointing DNS (step 3)

`MEMBRAL_FEATURE_ALLOWLIST` exists so the very first deploy isn't a chicken-and-egg problem (you
can't run `npm run flags` against a project with no signed-up users yet), but the window where
it's the ONLY thing standing between a stranger and your `OPENAI_API_KEY`/`OPENROUTER_API_KEY`
should be as short as possible — step 1.6 (confirmations ON) plus the allowlist's own
confirmed-email requirement (issue #126 finding 1) closes the unverified-signup version of that
window, but doesn't remove the exposure entirely while the app is reachable by anyone. So:

1. Deploy first (the steps above) — Vercel gives you a working URL immediately, either the
   `*.vercel.app` preview domain or `https://membral.me` if DNS (step 3) is already live. Prefer
   doing this BEFORE step 3, so the only people who can find the app at all are people you've
   given the preview URL to.
2. Sign up at `/signup` on that URL, with the SAME email you intend to allowlist (or skip the
   email path entirely — see below).
3. If confirmations are on (step 1.6 — required), confirm the email.
4. Grant yourself the flag for real: `npm run flags --workspace=@membral/cloud -- grant --feature
   llm --email you@example.com` (run with `NEXT_PUBLIC_SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`
   set to the HOSTED project's values in your shell — see step 4g). This writes the durable
   `feature_flags` row; you no longer need the allowlist at all.
5. Remove `MEMBRAL_FEATURE_ALLOWLIST` from Vercel's env vars (or never set it) and redeploy.

Prefer a user-id entry (`llm:<uuid>`, from `auth.users` or `scripts/flags.ts list` after your
first signup) over an email entry if you're setting `MEMBRAL_FEATURE_ALLOWLIST` at all — a user id
can't be squatted the way an email address can, and needs no confirmation wait.

**Teaser grant (issue #128)** — instead of a full, unlimited `llm` enable, give a
new account a small trial budget (roughly the cost of pass-1 extraction over their latest ~20
chats, at ~$0.0068/conversation measured on a sample corpus):

```bash
npm run flags --workspace=@membral/cloud -- grant --feature llm --email x@y.com --budget-usd 0.15
```

Omit `--budget-usd` for the full, unlimited enable shown in step 4 above. `embeddings` needs no
such grant — it's on by default for every account (`MEMBRAL_EMBED_DEFAULT_BUDGET_USD`/
`MEMBRAL_EMBED_DEFAULT_DAILY_USD` above); use `scripts/flags.ts grant --feature embeddings
--budget-usd N` only to override an individual account's default.

**Deploy**:
```bash
# from the repo root, with the project already linked (.vercel/project.json)
# --archive=tgz: Vercel's free-tier plan caps the number of files a single
# deploy may upload; bundling the whole payload into one tarball first sends
# ONE file instead of the monorepo's full (many-thousand) file count, which
# is what actually trips that cap on a Turborepo checkout this size.
vercel --prod --archive=tgz
```
(Or push to the branch Vercel is configured to auto-deploy from, typically `main`.)

**Function timeouts**: `vercel.json`'s `functions` block sets `maxDuration` (in seconds) for the
KG/import/sync/embed/code-sessions API routes, which run longer than Vercel's 10s Hobby-plan
default. Check your current plan's actual max (`maxDuration` is capped by plan tier — Hobby and
Pro have different ceilings, and these change over time; consult
<https://vercel.com/docs/functions/configuring-functions/duration> for the current limit before
assuming 300s applies) and lower the values in `vercel.json` if your plan's ceiling is smaller.
**Important**: raising `maxDuration` does NOT make the full corpus `kg:bootstrap` run
serverless-safe on its own — a bootstrap over a large corpus can still run far longer than any
function timeout, and a frozen/recycled serverless function loses all in-flight work. Real job
visibility (issue #21) is the actual fix; until then, run `npm run kg:bootstrap` from a normal
long-lived process (a local machine, or a VM), not as a Vercel function invocation, for any corpus
large enough to matter.

---

> **Native binaries on Vercel.** `package-lock.json` only records the optional native packages for the platform that ran `npm install` (a macOS ARM machine). Vercel builds on Linux x64, so every `*-darwin-arm64` native package in the lockfile has its `*-linux-x64(-gnu)` counterpart pinned in the root `package.json` `optionalDependencies` (lightningcss, Tailwind oxide, rolldown, rollup, esbuild, sharp, Next SWC, Biome). When you upgrade any of those, bump the pin to the same version or the Vercel build fails with "Cannot find module … linux-x64-gnu". Also: the Supabase anon key must be saved with `vercel env add NEXT_PUBLIC_SUPABASE_ANON_KEY production --type config` (it is public by design; the CLI refuses a credential-looking `NEXT_PUBLIC_` value otherwise), and the hosted auth URL settings can be set non-interactively with the Management API: `PATCH https://api.supabase.com/v1/projects/<ref>/config/auth` with `site_url`, `uri_allow_list`, `mailer_autoconfirm:false`.

## 3. DNS (membral.me, registered at GoDaddy)

Vercel-side: `vercel domains add membral.me` (or Project Settings -> Domains -> Add in the
dashboard) — Vercel will show you the exact records it wants; as of this writing that's:

| Type | Host | Value |
|---|---|---|
| A | `@` (apex) | `76.76.21.21` |
| CNAME | `www` | `cname.vercel-dns.com` |

GoDaddy-side: DNS Management for `membral.me` -> add/edit those two records (GoDaddy calls the
apex host `@`). Propagation is usually minutes, occasionally up to ~48h for a fresh domain. Verify
with `dig membral.me` / `dig www.membral.me` and in the Vercel dashboard's Domains tab (it flags
misconfigured records directly).

---

## 4. Post-deploy smoke checklist

Do these against the real `https://membral.me` (or your domain), not `localhost`:

- (a) **Health probe**: `curl https://membral.me/api/health` -> `{"status":"ok","checks":{"supabase":"ok"}}` with HTTP 200. A 503 here means Supabase isn't reachable — check the three required Supabase vars first.
- (b) **Signup**: visit `/signup`, create an account. If you enabled email confirmations (step 1.6), check that the confirmation email arrives and its link lands back on `/login` (not `localhost`) — this is `NEXT_PUBLIC_APP_URL` and the emailRedirectTo wiring in `actions.ts` doing their job.
- (c) **Login**: sign in with that account.
- (d) **Extension pointed at prod**: build the extension for production (`npm run build --workspace=@membral/extension`, no `VITE_CLOUD_URL` override needed — it now defaults to `https://membral.me` in a production build), load `packages/extension/dist/` unpacked, sign in with the same account, confirm "Cloud sync active".
- (e) **Sync**: trigger a sync from the extension popup, confirm conversations appear at `/conversations`.
- (f) **MCP config**: Settings -> API Key -> Generate API Key, then Settings -> MCP -> copy a client config and confirm the URL shown is `https://membral.me/api/mcp` (not localhost) — `NEXT_PUBLIC_MCP_URL` unset falls back to the browser's own origin, so this should already be correct.
- (g) **Feature-flag grant**: if you followed step 2a, you already did this before DNS went live — this is just the "confirm it stuck" re-check. `npm run flags --workspace=@membral/cloud -- list --feature llm` (run against the hosted DB — set `NEXT_PUBLIC_SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` in your shell to the hosted project's values first) should show your row as `ENABLED`. If you skipped 2a, grant now: `npm run flags --workspace=@membral/cloud -- grant --feature llm --email you@example.com`.
- (h) **Deliberately break boot**: temporarily unset one required var in Vercel (e.g. `NEXT_PUBLIC_APP_URL`), redeploy, confirm the function logs show `Membral cloud cannot start: missing required environment variable(s): NEXT_PUBLIC_APP_URL` — then restore it and redeploy again.

---

## 5. What stays local

This deploy does not replace a local setup you may run — the two can coexist:

- A **local instance** (your own launch script running `next start -p 3000` against a local Supabase
  Docker stack) keeps running independently. It has nothing to do with the hosted deploy above — different
  Supabase project (local vs. hosted), different URL (`localhost:3000` vs. `https://membral.me`).
- There is no migration or data sync between the local Supabase project and the hosted one.

---

## 6. Abuse hardening / onboarding self-sufficiency (issue #127)

- **Daily extraction cron** (issue #132) — `apps/cloud/vercel.json`'s `crons` entry hits
  `GET /api/internal/cron/advance` once a day (`0 3 * * *`), which runs one bounded claims-advance
  cycle for every pending/granted user — the safety net for an account whose extraction would
  otherwise only advance on sync/import/self-advance (e.g. a granted user who stopped syncing).
  **This does nothing until you set `CRON_SECRET` in Vercel's project env vars** (see the table
  above and step 2's env var list) — Vercel only attaches the `Authorization: Bearer $CRON_SECRET`
  header once that var exists, and the route 503s on every request (including Vercel's own
  cron-triggered ones) while it's unset. Verify it's actually wired up after deploy with one manual
  call using the same secret: `curl -H "Authorization: Bearer $CRON_SECRET"
  https://membral.me/api/internal/cron/advance` should return `200` with a JSON summary
  (`candidates`/`processed`/`refused`/`errored`/`totalCostUsd`), not `503` (secret unset) or `403`
  (wrong secret).
- **Rate limits added**: `/api/sync` (60/min/user), `/api/import` (10/min/user),
  `/api/code-sessions` (30/min/user), signup (5/10min/IP), login (20/10min/IP) — all tunable via
  `RATE_LIMIT_<NAME>` / `RATE_LIMIT_<NAME>_WINDOW` env vars per `lib/rate-limit.ts`'s existing
  convention (e.g. `RATE_LIMIT_SYNC=120`).
- **Request caps added**: `/api/sync` and `/api/import` now reject a body over 25MB (413) and a
  `conversations[]` array over 500 entries (400, clear message) — the extension already chunks its
  own pushes to 500-conversation batches (`MAX_SYNC_BATCH_SIZE`, `cloud-push.ts`) so a well-behaved
  client never trips this.
- **`profiles.conversation_limit` is now enforced ATOMICALLY at the DB layer** (round-2 review
  HIGH 3/4/6) — migration 078 adds a `before insert` trigger on `public.conversations` that counts
  ALL sources for the user (including `claude-code` — mirrored code sessions now share the same
  quota as chat conversations) and rejects a brand-new row
  past the limit inside one atomic, per-user-locked check-and-count, closing the two bypasses the
  old app-only check had: the bulk `/api/import/upload` path (never called the app-level
  pre-partition) and a TOCTOU race between two concurrent requests. **Round-3 review HIGH 13,
  corrected**: only `/api/sync` and `/api/import` do an app-level pre-partition FIRST for a
  friendly response (existing rows/updates always go through; brand-new rows accepted only up to
  remaining headroom, overflow reported as `skipped`/`atLimit` in a 200, or a full
  `402 {"error":"conversation_limit","limit":N,"count":N}` if nothing fit) — matching migration
  078's own header, which states the trigger "only fires when that pre-check was skipped (the
  `/api/import/upload` path...)". `/api/import/upload` deliberately calls `ingestConversations`
  WITHOUT `enforceQuota` (see that route's own comment) and relies entirely on the DB trigger as
  its only enforcement — the trigger is still the backstop for whatever the other two routes'
  pre-partition missed or raced, translated back into the same `skipped`/`atLimit` shape by each
  route (`lib/billing.ts`'s `parseConversationLimitError`), `/api/import/upload` included via its
  `quotaSkippedKeys` plumbing. The
  code-sessions mirror path (`lib/code-sessions/mirror-conversations.ts`) skips-and-logs a
  quota-rejected session (`skippedQuota`) rather than ever failing the code-session upload.
  **Before this goes live on any account that already has more conversations than its
  `conversation_limit`** (100 for a NEW signup once you've set `hosted` mode per step 1a above —
  migration 081; NULL/unlimited by default if you skipped that step), raise that account's limit
  first or every future sync/import from it will be rejected as a full/partial 402. Example SQL shape used
  to raise a local demo/dev account past its existing corpus size during this build (placeholder
  ids — round-3 review HIGH 15/F6: a real production user UUID used to be committed verbatim here,
  which the scrub guard would have caught had it been wired to anything — see
  `.githooks/pre-commit`):
  ```sql
  UPDATE profiles SET conversation_limit = 10000 WHERE id IN (
    '<your-user-id-1>', -- replace with your own auth.users.id
    '<your-user-id-2>', -- replace with your own auth.users.id
    '<your-user-id-3>'  -- replace with your own auth.users.id
  );
  ```
  Run the equivalent against the hosted DB (with each account's real `auth.users.id`) before this
  enforcement goes live for any account with a real corpus larger than 100 conversations.
- **`MEMBRAL_SIGNUPS_DISABLED` — the app-level half only.** It refuses a signup submitted through
  this app's own `/signup` form, no redeploy needed to flip (read at request time, not cached). It
  does **NOT** reach Supabase's GoTrue endpoint directly (`POST /auth/v1/signup`, callable with the
  public anon key) — an incident that actually needs the kill-switch needs BOTH of the following,
  not just this env var:
  1. **Authoritative switch (do this first)**: Supabase Dashboard -> Authentication -> Providers ->
     Email -> **"Allow new users to sign up" = off**. This is what actually stops GoTrue from
     creating a user, on every path, immediately.
  2. **DB-level backstop (belt and braces)**: `npx tsx scripts/flags.ts signups off` (run with
     `NEXT_PUBLIC_SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` set to the hosted project) writes
     `app_settings.signups_disabled = true`, which migration 079's `before insert` trigger on
     `auth.users` enforces for EVERY path that creates a user — the app's signup action, a direct
     GoTrue call, anything — even when step 1 above wasn't (or, in local dev, can't be) flipped in
     time. `npx tsx scripts/flags.ts signups status` checks current state; `signups on` re-opens.
  Also flip **Supabase Dashboard -> Authentication -> Rate Limits** during an incident — this repo's
  own per-IP throttles (`RATE_LIMIT_SIGNUP_IP`/`RATE_LIMIT_LOGIN_IP`) only see traffic through this
  app's server actions, never a direct GoTrue call, so Supabase's own auth rate limits (and email
  confirmation being ON — step 1.6 above) are what actually bound that traffic. See
  `.env.example`'s `MEMBRAL_SIGNUPS_DISABLED` block for the same summary.
- **`/setup` self-serve onboarding page** — public, no auth required, links the Chrome extension
  zip, the CLI's `git clone` + `npm link` steps (not on npm yet — issue #118), and Settings -> API
  key for MCP. Linked from the landing page, the sidebar footer, and every empty state that used to
  dead-end on `npx @membral/cli setup`.
  - **Extension zip** (`public/downloads/membral-extension.zip`, `npm run build`'s `prebuild` step
    — `apps/cloud/scripts/package-extension.mjs`, round-2 review BLOCKER 1 fix): built by this
    script itself with an explicit, deployment-derived env contract
    (`VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY`/`VITE_CLOUD_URL` <- this deploy's
    `NEXT_PUBLIC_SUPABASE_URL`/`NEXT_PUBLIC_SUPABASE_ANON_KEY`/`NEXT_PUBLIC_APP_URL`), into a scratch
    dir it controls — `packages/extension/dist` (a developer's local build) and
    `packages/extension/.env.local` (a developer's local Supabase config) are NEVER read for this.
    If those three `NEXT_PUBLIC_*` vars aren't all set at build time (a plain `next build` with no
    Supabase env configured, or a Vercel project that hasn't set them), the script skips the zip
    with a warning rather than shipping a broken one, and `/setup` shows "download not available on
    this deployment" (checked at request time) instead of a dead link.
- **membral.me DNS/domain execution** (step 3 above) is prepared here but the actual
  `vercel domains add` / GoDaddy record changes are irreversible, credentialed steps — see issue
  #31, which explicitly routes those to the maintainer rather than an agent.

---

## 7. Auth email (Resend)

Issue #135. Step 1.6 above says "configure your own SMTP provider" — this is the concrete
runbook for that, using **Resend** (project decision) as the SMTP relay, sending
from `membral.me`. The repo side (branded HTML templates, local `config.toml` stanzas) is already
done — everything below is a human/dashboard gate an agent cannot do for you (account creation,
DNS, pasting a secret into a dashboard).

**From-address**: the sender local part is `hello@membral.me` — it appears in exactly one place
below (the Supabase SMTP settings step) and in the commented `[auth.email.smtp]` stanza in
`apps/cloud/supabase/config.toml`, so it's a one-line change if that ever needs to move. Reply-to
can be `support@membral.me`, which has a **pending MX record** (see step 3 below) — don't wire it
as the reply-to until that MX resolves, or replies to it will bounce.

1. **Create a Resend account** at <https://resend.com> and add `membral.me` as a sending domain
   (Resend dashboard -> Domains -> Add Domain).
2. **Add the DNS records Resend gives you** on GoDaddy (same registrar as the rest of
   `membral.me`'s DNS — see step 3 above): a DKIM `TXT` record, an `SPF` `TXT` record (or a merge
   into an existing one — a domain can only have one SPF record), and a `Return-Path`/`MAIL FROM`
   `CNAME` (Resend's dashboard names the exact records and values; add them verbatim). While you're
   in GoDaddy's DNS for `membral.me`, note that **`support@membral.me`'s `MX` record is still
   pending** as of this writing — that's a separate, not-yet-done step; it doesn't block Resend's
   DKIM/SPF (those are for *sending* as `hello@membral.me`, not receiving at `support@membral.me`),
   but don't point any reply-to at `support@membral.me` until that MX resolves.
3. **Verify the domain** in Resend once DNS propagates (can take minutes to hours) — Resend's
   dashboard shows each record's status; don't move on until all show verified.
4. **Create a Resend API key** (Resend dashboard -> API Keys -> Create API Key). Resend's SMTP
   integration uses this API key as the SMTP password with a fixed username of `resend` — treat the
   key like any other production secret (don't commit it; it only ever lives in the Supabase
   dashboard for this flow, not in this repo or Vercel).
5. **Supabase dashboard -> Authentication -> SMTP Settings** (for the **hosted** project — this is
   dashboard-only, same as email confirmations in step 1.6; nothing in this repo's `config.toml`
   reaches a hosted project on its own):
   - Enable custom SMTP.
   - Host: `smtp.resend.com`
   - Port: `465`
   - Username: `resend`
   - Password: the Resend API key from step 4.
   - Sender email: `hello@membral.me`
   - Sender name: `Membral`
6. **Supabase dashboard -> Authentication -> Email Templates**: for each of Confirm signup, Reset
   password, and Magic Link (and Change Email / Invite user if you use those flows), paste the
   subject and HTML body from the matching file under `apps/cloud/supabase/templates/` in this
   repo (`confirmation.html`, `recovery.html`, `magic-link.html`, `email-change.html`,
   `invite.html`) — the same content the local `config.toml` `[auth.email.template.*]` stanzas
   point at, so local (Mailpit-captured) and hosted mail match. Subjects: "Confirm your email for
   Membral", "Reset your Membral password", "Your Membral sign-in link" (see each file / the
   `config.toml` stanza for the others).
7. **Send a test signup** against the hosted URL and confirm the email arrives from
   `hello@membral.me` (not Supabase's default sender) with the branded template — check the raw
   headers if your mail client hides the from-address.
8. **Why this matters beyond branding**: Supabase's built-in mailer (no custom SMTP configured)
   enforces a strict per-address send cooldown that's the direct cause of issue #133 (a second
   signup attempt for the same address looks like a failure even though the first email is still
   in flight / already landed) — custom SMTP through Resend removes that specific constraint
   (Resend has its own rate limits, but they're not the tight per-address cooldown GoTrue's
   built-in mailer applies). Landing this doesn't fix #133 by itself, but it removes one of its
   contributing causes.

**Local dev stays on Mailpit** — nothing above touches local `supabase start`; the commented
`[auth.email.smtp]` Resend stanza in `config.toml` is there for reference only (a future
`supabase config push` to a linked project), and every local auth email keeps landing in Mailpit
(`http://127.0.0.1:54324`) unmodified. The `[auth.email.template.*]` stanzas (uncommented, active
locally) DO apply to Mailpit-delivered mail, but only from the next `supabase start` after this
guide's config.toml change lands — restarting the currently-running local stack is intentionally
left to whoever is driving that stack, not done automatically by this change, since other work may
be relying on the local instance staying up mid-session.

---

## 8. Google sign-in

Issue #134 (adversarial review round 1, MAJOR M5 — this section didn't exist before that review;
the feature shipped with no runbook, so the button was live-but-dead on a hosted deploy). Like
step 7, everything below is a human/dashboard gate an agent cannot do for you — the repo side
(`signInWithGoogle()` server action, `/auth/callback` route handler, the disabled-locally
`[auth.external.google]` stanza in `apps/cloud/supabase/config.toml`) is already done.

1. **Create a Google Cloud OAuth client** (<https://console.cloud.google.com> -> APIs & Services ->
   Credentials -> Create Credentials -> OAuth client ID -> Application type "Web application"):
   - **Authorized JavaScript origin**: `https://membral.me` (or your domain).
   - **Authorized redirect URI**: `https://<project-ref>.supabase.co/auth/v1/callback` — this is
     Supabase's OWN callback endpoint (GoTrue owns the Google round trip, not this app directly;
     see `app/auth/callback/route.ts`'s header comment), not `https://membral.me/auth/callback`.
     For the hosted `membral` project this is
     `https://<project-ref>.supabase.co/auth/v1/callback` — confirm your own project's ref
     (Dashboard -> Project Settings -> General -> Reference ID) rather than assuming this one still
     matches if the project has ever been recreated.
   - If the OAuth consent screen isn't already configured for this Google Cloud project, you'll be
     walked through that first (app name, support email, scopes — the default `email`/`profile`
     scopes are all this integration needs).
2. **Supabase dashboard -> Authentication -> Providers -> Google** (dashboard-only for the hosted
   project — same as every other provider in this guide; `config.toml`'s `[auth.external.google]`
   block only drives the LOCAL CLI stack, and ships `enabled = false` there on purpose, see its own
   comment):
   - Toggle the provider on.
   - **Client ID** / **Client Secret**: paste the values from step 1's Google Cloud OAuth client.
3. **Confirm the redirect allow-list already covers this** (Dashboard -> Authentication -> URL
   Configuration -> Redirect URLs) — step 1's `https://membral.me/**` wildcard (added for the
   email-confirmation/password-reset links) already matches `https://membral.me/auth/callback`, so
   there is nothing new to add here UNLESS that wildcard was ever narrowed to specific paths. This
   matters more than it looks: without `/auth/callback` in the allow-list, GoTrue silently falls
   back to the Site URL and drops the `next` query param instead of erroring, so a broken
   allow-list reads as "Google sign-in always lands on the homepage instead of where the user was
   headed" rather than an obvious failure.
4. **Self-hosting / local dev**: to actually turn this on against a LOCAL `supabase start` (it
   ships disabled there — see the block's own comment in `config.toml` on why flipping it to `true`
   needs verifying first), set `SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID` and
   `SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET` in `apps/cloud/supabase/.env` (or your shell env before
   `supabase start` — the CLI resolves `config.toml`'s `env(...)` substitutions from the process
   environment, the same mechanism the Resend SMTP stanza above uses), flip `enabled = true` in
   `config.toml`, and use a Google Cloud OAuth client whose authorized redirect URI points at your
   local GoTrue instead (`http://127.0.0.1:54321/auth/v1/callback` by default — see
   `supabase status -o env` for your actual local API URL/port). A self-hoster's
   `SUPABASE_ADDITIONAL_REDIRECT_URL` (`apps/cloud/supabase/.env.example`, currently
   `http://127.0.0.1:3000`) needs the same `/**`-style widening as step 3 above once they're past
   local dev.
5. **Send a test sign-in** against the hosted URL from both `/login` and `/signup` — confirm it
   lands on the same page email/password sign-in does (not a 404 — see BLOCKER B1 in the
   adversarial review this section responds to) and that a `?next=...` destination survives the
   round trip.
6. **MEMBRAL_SIGNUPS_DISABLED and Google sign-in during an incident** (round-3/4 adversarial
   review): because that env var has no DB backing, this app can only refuse a brand-new Google
   account *after* GoTrue has already created it, using a durable `signups_disabled_at` marker
   (`app_settings`, same table as the sibling `signups_disabled` DB switch) that every
   signup()/`signInWithGoogle()`/callback request eagerly stamps the moment it reads the switch as
   on, so each incident refuses accounts created from that point forward. The app never clears
   this marker itself — `MEMBRAL_SIGNUPS_DISABLED` is read per-deployment on Vercel, so a stale
   deployment still carrying the old value could otherwise delete shared state out from under
   every other deployment — so run `npx tsx scripts/flags.ts signups off` at the start of an
   incident and `signups on` at the end (from `apps/cloud`) to manage that same marker
   deterministically alongside the DB switch, every time, rather than relying on app traffic. If
   the marker ever needs a manual reset outside that tool, delete the `app_settings` row with
   `key='signups_disabled_at'` (service-role only, same access class as every other row in that
   table).
