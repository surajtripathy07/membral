// Replace the NEXT_PUBLIC_* sentinels baked in by `next build` (see
// apps/cloud/Dockerfile) with this container's runtime values. Runs once per
// container: a marker records the values used, and a restart with different
// values fails loudly, because the sentinels are gone by then; recreate the
// container instead.
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const NEXT_DIR = process.env.MEMBRAL_NEXT_DIR ?? "/app/apps/cloud/.next";
const MARKER = join(NEXT_DIR, ".membral-runtime-env.json");

const VARS = [
  { name: "NEXT_PUBLIC_SUPABASE_URL", sentinel: "http://membral-sentinel-supabase-url.invalid", url: true },
  { name: "NEXT_PUBLIC_SUPABASE_ANON_KEY", sentinel: "membral-sentinel-anon-key", url: false },
  { name: "NEXT_PUBLIC_APP_URL", sentinel: "http://membral-sentinel-app-url.invalid", url: true },
];

function fail(message) {
  console.error(`membral-entrypoint: ${message}`);
  process.exit(1);
}

const values = {};
for (const v of VARS) {
  let value = process.env[v.name]?.trim();
  if (!value) fail(`${v.name} is required`);
  // The value lands inside JS string literals and HTML attributes.
  if (/[\s"'`\\<>]/.test(value)) fail(`${v.name} contains a quote, backslash, angle bracket or whitespace`);
  if (v.url) {
    try {
      new URL(value);
    } catch {
      fail(`${v.name} is not an absolute URL (include the scheme): ${value}`);
    }
    value = value.replace(/\/+$/, "");
  }
  values[v.name] = value;
}

if (existsSync(MARKER)) {
  const previous = JSON.parse(readFileSync(MARKER, "utf8"));
  const changed = VARS.filter((v) => previous[v.name] !== values[v.name]).map((v) => v.name);
  if (changed.length === 0) process.exit(0);
  fail(`${changed.join(", ")} changed since this container first started; recreate the container`);
}

function* files(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "cache") yield* files(path);
    } else if (entry.isFile()) {
      yield path;
    }
  }
}

const sentinels = VARS.map((v) => [Buffer.from(v.sentinel), values[v.name]]);
let rewritten = 0;
for (const path of files(NEXT_DIR)) {
  if (statSync(path).size > 50 * 1024 * 1024) continue;
  const buf = readFileSync(path);
  if (!sentinels.some(([s]) => buf.includes(s))) continue;
  let text = buf.toString("utf8");
  for (const v of VARS) text = text.split(v.sentinel).join(values[v.name]);
  writeFileSync(path, text);
  rewritten++;
}

writeFileSync(MARKER, JSON.stringify(values));
console.log(`membral-entrypoint: runtime config applied to ${rewritten} files`);
