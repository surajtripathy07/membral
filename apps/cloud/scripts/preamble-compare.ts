/**
 * Preamble before/after comparison (READ-ONLY).
 *
 * Renders the SessionStart preamble for one user/repo/branch twice -- with
 * `origin/main`'s lib/memory/preamble.ts ("before") and with this checkout's
 * ("after") -- and prints both blocks with line counts and char totals.
 *
 *   PREAMBLE_SUPABASE_URL=… PREAMBLE_SUPABASE_KEY=… \
 *     npx tsx scripts/preamble-compare.ts --user <uuid> --repo <repo> [--branch <b>] [--session <id>] [--base origin/main]
 *
 * Or, with no database credentials, from a read-only dump (`--fixture <dir>`
 * holding dump-{projects,sessions,branch,forge,mem,turns}.json, each the
 * `supabase db query --output-format json` of a SELECT): both renders then read
 * the dump through @membral/test-kit's in-memory fake.
 *
 * "before" runs from a `git archive <base> apps/cloud/src` copy under
 * node_modules/.cache/preamble-compare/<sha> (its `@/` imports rewritten to
 * absolute paths into that copy), in a child tsx process; "after" runs this
 * checkout's code in another child.
 *
 * Write safety: buildPreamble only reads (the route, not buildPreamble, logs
 * the recall event). Both children still get a client whose
 * insert/update/upsert/delete and rpc throw, so a write anywhere in the call
 * path fails loudly instead of landing.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLOUD = resolve(HERE, "..");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const WRITE_METHODS = new Set(["insert", "update", "upsert", "delete"]);

/** A Supabase client whose writes (and rpc calls) throw. */
// biome-ignore lint/suspicious/noExplicitAny: wraps the untyped client for a one-off script
function readOnly(client: any): any {
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === "rpc")
        return (fn: string) => {
          throw new Error(`preamble-compare: rpc(${fn}) refused (read-only)`);
        };
      if (prop === "from")
        return (table: string) => {
          const builder = target.from(table);
          return new Proxy(builder, {
            get(b, p, r) {
              if (typeof p === "string" && WRITE_METHODS.has(p))
                return () => {
                  throw new Error(`preamble-compare: ${p} on ${table} refused (read-only)`);
                };
              const v = Reflect.get(b, p, r);
              return typeof v === "function" ? v.bind(b) : v;
            },
          });
        };
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

/** Child mode: render with the preamble module under `srcRoot`, print `{lines}` as JSON. */
/** Fixture tables: `<dir>/dump-<name>.json`, each `{rows: [...]}` (supabase db query --output-format json). */
const FIXTURE_TABLES: Record<string, string> = {
  code_projects: "projects",
  code_sessions: "sessions",
  memory_branch_state: "branch",
  code_session_forge_refs: "forge",
  session_memories: "mem",
  code_session_turns: "turns",
};

/** Postgres text timestamps (`2026-09-22 10:25:52.802+00`) as ISO `…Z`, so string comparisons match PostgREST's. */
function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row))
    out[k] = typeof v === "string" && k.endsWith("_at") && /^\d{4}-\d\d-\d\d[ T]\d/.test(v) ? new Date(v).toISOString() : v;
  return out;
}

// biome-ignore lint/suspicious/noExplicitAny: test-kit's fake client is untyped
async function fixtureClient(dir: string): Promise<any> {
  const { makeMemoryFakeSupabase } = await import("@membral/test-kit");
  const tables: Record<string, Record<string, unknown>[]> = { conversations: [] };
  for (const [table, name] of Object.entries(FIXTURE_TABLES)) {
    const file = join(dir, `dump-${name}.json`);
    const parsed = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { rows: [] };
    tables[table] = ((parsed.rows ?? parsed) as Record<string, unknown>[]).map(normalizeRow);
  }
  return makeMemoryFakeSupabase(tables as never);
}

async function render(srcRoot: string): Promise<void> {
  const fixture = arg("fixture");
  let db: unknown;
  if (fixture) db = readOnly(await fixtureClient(fixture));
  else {
    const { createClient } = await import("@supabase/supabase-js");
    db = readOnly(
      createClient(process.env.PREAMBLE_SUPABASE_URL as string, process.env.PREAMBLE_SUPABASE_KEY as string, {
        auth: { persistSession: false, autoRefreshToken: false },
      }),
    );
  }
  const mod = await import(pathToFileURL(join(srcRoot, "lib/memory/preamble.ts")).href);
  const t0 = performance.now();
  const result = await mod.buildPreamble(db, arg("user") as string, {
    repo: arg("repo") as string,
    branch: arg("branch") || undefined,
    session: arg("session") || undefined,
  });
  const ms = Math.round(performance.now() - t0);
  process.stdout.write(`${JSON.stringify({ lines: result.lines, ms })}\n`);
}

function baseTree(base: string): string {
  const sha = execFileSync("git", ["rev-parse", "--short", base], { cwd: CLOUD, encoding: "utf8" }).trim();
  const root = join(CLOUD, "node_modules/.cache/preamble-compare", sha);
  // The marker is written last: a copy interrupted mid-extract is rebuilt, never half-used.
  const done = join(root, ".done");
  if (!existsSync(done)) {
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: CLOUD, encoding: "utf8" }).trim();
    const tar = execFileSync("git", ["archive", base, "apps/cloud/src"], { cwd: top, maxBuffer: 1 << 30 });
    execFileSync("tar", ["-x", "--strip-components=2", "-C", root], { input: tar });
    // ESM, like apps/cloud: workspace packages export an `import` condition only.
    writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module", private: true }));
    // tsx applies no tsconfig `paths` under node_modules, so `@/x` becomes an absolute path to this copy.
    const src = join(root, "src");
    for (const file of readdirSync(src, { recursive: true }) as string[]) {
      if (!/\.tsx?$/.test(file)) continue;
      const path = join(src, file);
      const text = readFileSync(path, "utf8");
      const next = text.replace(/(from\s+|import\(\s*)(["'])@\//g, `$1$2${src}/`);
      if (next !== text) writeFileSync(path, next);
    }
    writeFileSync(done, new Date().toISOString());
  }
  return root;
}

function runChild(srcRoot: string, tsconfig: string): { lines: string[]; ms: number } {
  const forward = ["user", "repo", "branch", "session", "fixture"].flatMap((n) => (arg(n) ? [`--${n}`, arg(n) as string] : []));
  const out = spawnSync("npx", ["tsx", fileURLToPath(import.meta.url), "--render", srcRoot, ...forward], {
    cwd: CLOUD,
    encoding: "utf8",
    maxBuffer: 1 << 26,
    env: {
      ...process.env,
      TSX_TSCONFIG_PATH: tsconfig,
      // mintRecallToken signs with the service key (a dummy in fixture mode); never printed.
      SUPABASE_SERVICE_ROLE_KEY: process.env.PREAMBLE_SUPABASE_KEY ?? "fixture-only",
    },
  });
  const line = (out.stdout ?? "").split("\n").find((l) => l.startsWith('{"lines"'));
  if (out.status !== 0 || !line) throw new Error(`render failed (${srcRoot}): ${(out.stderr ?? "").slice(-2000)}`);
  return JSON.parse(line) as { lines: string[]; ms: number };
}

function block(title: string, { lines, ms }: { lines: string[]; ms: number }): string {
  // The token is opaque and long; it is the same idea in both renders.
  const shown = lines.map((l) => (l.startsWith("recall_token: ") ? "recall_token: …" : l));
  const chars = lines.reduce((n, l) => n + l.length, 0);
  return `**${title}** — ${lines.length} lines, ${chars} chars, buildPreamble ${ms} ms\n\n\`\`\`\n${shown.join("\n")}\n\`\`\`\n`;
}

async function main(): Promise<void> {
  const renderRoot = arg("render");
  if (!arg("fixture") && (!process.env.PREAMBLE_SUPABASE_URL || !process.env.PREAMBLE_SUPABASE_KEY))
    throw new Error("set PREAMBLE_SUPABASE_URL and PREAMBLE_SUPABASE_KEY, or pass --fixture <dump dir>");
  if (renderRoot) return render(renderRoot);
  if (!arg("user") || !arg("repo")) throw new Error("--user and --repo are required");
  const base = baseTree(arg("base") ?? "origin/main");
  const before = runChild(join(base, "src"), join(CLOUD, "tsconfig.json"));
  const after = runChild(join(CLOUD, "src"), join(CLOUD, "tsconfig.json"));
  const label = arg("label") ?? `${arg("repo")} @ ${arg("branch") ?? "(no branch)"}`;
  process.stdout.write(`### ${label}\n\n${block("before (main)", before)}\n${block("after (redesign)", after)}\n`);
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
