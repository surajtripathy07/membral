#!/usr/bin/env node
// Vercel functions glob check (architecture refactor programme step 0.7).
//
// apps/cloud/vercel.json gives some routes a longer maxDuration through
// `functions` globs such as "src/app/api/kg/**/route.ts". Vercel does not
// fail a deploy when a glob matches nothing: a route that moves (programme
// phase 1) silently falls back to the default timeout. This script asserts
// every glob matches at least one file under apps/cloud, so a move that
// orphans a glob fails CI instead of production.
//
// usage:  npm run check:vercel-functions
//
// Exit 0 when every glob matches; exit 1 listing each glob that matches none.
// No dependency: the glob subset Vercel uses here (`**`, `*`, `?`, literal
// segments) is translated to a RegExp and tested against a recursive listing.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const APP_DIR = resolve(REPO_ROOT, "apps/cloud");
const SKIP_DIRS = new Set(["node_modules", ".next", ".turbo", "dist", ".git"]);

export function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      // "**/" matches zero or more whole directories; a trailing "**" matches anything.
      if (glob[i + 2] === "/") {
        re += "(?:[^/]+/)*";
        i += 2;
      } else {
        re += ".*";
        i += 1;
      }
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

function listFiles(dir, prefix = "") {
  const out = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) continue;
      out.push(...listFiles(resolve(dir, ent.name), `${prefix}${ent.name}/`));
    } else out.push(`${prefix}${ent.name}`);
  }
  return out;
}

const config = JSON.parse(readFileSync(resolve(APP_DIR, "vercel.json"), "utf8"));
const globs = Object.keys(config.functions ?? {});
const files = listFiles(resolve(APP_DIR, "src")).map((f) => `src/${f}`);
const missing = [];
for (const glob of globs) {
  const re = globToRegExp(glob);
  const n = files.filter((f) => re.test(f)).length;
  if (n === 0) missing.push(glob);
  else console.log(`ok   ${glob} (${n} file${n === 1 ? "" : "s"})`);
}
for (const glob of missing) console.error(`FAIL apps/cloud/vercel.json functions["${glob}"] matches no file`);
console.log(`check-vercel-functions: ${globs.length} glob(s), ${missing.length} unmatched`);
process.exit(missing.length ? 1 : 0);
