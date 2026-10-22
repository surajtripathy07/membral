#!/usr/bin/env node
// Mechanical redaction for harvested e2e session-transcript fixtures (step 0.8, M3).
//
// Usage: node redact.mjs <dir> [<dir> ...]
// Rewrites every .jsonl / .json / .md file found under each dir, in place.
// Run it over fresh copies of the SOURCE transcripts: several rules are not idempotent
// over already-redacted text.
//
// Private literals (the real person name, account handle and repository name) live in the
// gitignored .claude/redact-private.json:
//   { "fullName": [...], "handle": [...], "repo": [...] }
// The script refuses to run without it, so no literal ever sits in this committed file.
//
// Rules (applied in this order per file):
//   1. Secret-shaped tokens (key prefix + >= 20 key chars, whole word) -> <redacted>
//   2. Absolute macOS-home-style paths (per-user home directory prefix) -> /home/dev/...
//   3. The real e2e forge repo slug (<handle>/<repo>) -> codehub-org/audiobooks
//   4. Email addresses -> user@example.com
//   5. Every non-comment line of .claude/scrub-list.txt, matched case-insensitively
//      as a literal string -> CodeHub
//   6. Real person name (whole word, case-insensitive) -> Dev Example
//   7. Bare account handle (whole word, case-insensitive) -> codehub-org
//   8. Repository name and its short variants (whole word, case-insensitive) -> audiobooks
// meta.json files additionally lose any `original_relpath_hash` key (an unsalted hash of
// the source path is guessable).
//
// Never reads or writes anything outside the paths given on the command line, apart from
// reading the two gitignored inputs above.

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const SCRUB_LIST_PATH = join(REPO_ROOT, ".claude", "scrub-list.txt");
const PRIVATE_PATH = join(REPO_ROOT, ".claude", "redact-private.json");

const SECRET_PATTERNS = [
  /lls_[A-Za-z0-9]+/g,
  /\bsk-(proj-|or-|ant-)?[A-Za-z0-9_-]{20,}\b/g,
  /ghp_[A-Za-z0-9]+/g,
  /eyJ[A-Za-z0-9_-]{20,}/g,
];

const FAKE_OWNER = "codehub-org";
const FAKE_REPO = "audiobooks";
const FAKE_REPO_SLUG = `${FAKE_OWNER}/${FAKE_REPO}`;
const FAKE_NAME = "Dev Example";

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function loadPrivate() {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(PRIVATE_PATH, "utf8"));
  } catch (err) {
    console.error(`FATAL: cannot load ${PRIVATE_PATH} (${err.message}); refusing to redact.`);
    process.exit(2);
  }
  for (const key of ["fullName", "handle", "repo"]) {
    const v = parsed[key];
    if (!Array.isArray(v) || v.length === 0 || v.some((s) => typeof s !== "string" || s === "")) {
      console.error(`FATAL: ${PRIVATE_PATH} needs a non-empty string array "${key}".`);
      process.exit(2);
    }
  }
  // Longest first, so a full literal wins over its own prefix or suffix.
  const byLength = (a, b) => b.length - a.length;
  return {
    fullName: [...parsed.fullName].sort(byLength),
    handle: [...parsed.handle].sort(byLength),
    repo: [...parsed.repo].sort(byLength),
  };
}

// Whole word: not preceded or followed by a word character. A JSON escape such as \n or \t
// directly before the literal still counts as a boundary (its letter is not part of the word).
function wholeWord(literal) {
  return new RegExp(
    `(?:(?<=\\\\[nrt])|(?<![A-Za-z0-9_]))${escapeRegExp(literal)}(?![A-Za-z0-9_])`,
    "gi"
  );
}

function loadScrubTerms() {
  let raw;
  try {
    raw = readFileSync(SCRUB_LIST_PATH, "utf8");
  } catch {
    console.error(`WARNING: could not read ${SCRUB_LIST_PATH}; scrub-list step skipped.`);
    return [];
  }
  return raw
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => {
      const trimmed = l.trim();
      if (trimmed === "") return false;
      if (trimmed.startsWith("#")) return false;
      if (trimmed.startsWith("!")) return false;
      return true;
    });
}

function redactContent(content, scrubTerms, priv) {
  let out = content;
  let counts = {
    secrets: 0,
    usersPaths: 0,
    repoSlug: 0,
    emails: 0,
    scrubTerms: 0,
    names: 0,
    handles: 0,
    repoNames: 0,
  };

  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, () => {
      counts.secrets++;
      return "<redacted>";
    });
  }

  // macOS per-user home prefix (any username, next path segment) -> /home/dev/
  out = out.replace(new RegExp("/" + "Users" + "/[^/\"'\\s]+/", "g"), () => {
    counts.usersPaths++;
    return "/home/dev/";
  });

  // github.com/<owner>/<repo> form, then bare owner/repo form.
  for (const owner of priv.handle) {
    for (const repo of priv.repo) {
      const ownerRepoUrl = new RegExp(
        `github\\.com/${escapeRegExp(owner)}/${escapeRegExp(repo)}\\b`,
        "gi"
      );
      out = out.replace(ownerRepoUrl, () => {
        counts.repoSlug++;
        return `github.com/${FAKE_REPO_SLUG}`;
      });
      const ownerRepoBare = new RegExp(`\\b${escapeRegExp(owner)}/${escapeRegExp(repo)}\\b`, "gi");
      out = out.replace(ownerRepoBare, () => {
        counts.repoSlug++;
        return FAKE_REPO_SLUG;
      });
    }
  }

  // Emails.
  out = out.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, () => {
    counts.emails++;
    return "user@example.com";
  });

  // Scrub-list terms, case-insensitive literal match.
  for (const term of scrubTerms) {
    const re = new RegExp(escapeRegExp(term), "gi");
    out = out.replace(re, () => {
      counts.scrubTerms++;
      return "CodeHub";
    });
  }

  // Private literals, whole word, case-insensitive.
  for (const [list, key, fake] of [
    [priv.fullName, "names", FAKE_NAME],
    [priv.handle, "handles", FAKE_OWNER],
    [priv.repo, "repoNames", FAKE_REPO],
  ]) {
    for (const literal of list) {
      out = out.replace(wholeWord(literal), () => {
        counts[key]++;
        return fake;
      });
    }
  }

  return { out, counts };
}

function walk(dir, files) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full, files);
    } else if (/\.(jsonl|json|md)$/i.test(entry)) {
      files.push(full);
    }
  }
}

function main() {
  const dirs = process.argv.slice(2);
  if (dirs.length === 0) {
    console.error("Usage: node redact.mjs <dir> [<dir> ...]");
    process.exit(1);
  }
  const priv = loadPrivate();
  const scrubTerms = loadScrubTerms();
  const totals = {
    secrets: 0,
    usersPaths: 0,
    repoSlug: 0,
    emails: 0,
    scrubTerms: 0,
    names: 0,
    handles: 0,
    repoNames: 0,
    metaHashesDropped: 0,
    files: 0,
  };

  for (const dir of dirs) {
    const files = [];
    walk(dir, files);
    for (const file of files) {
      let content = readFileSync(file, "utf8");
      const original = content;
      if (basename(file) === "meta.json") {
        const meta = JSON.parse(content);
        if ("original_relpath_hash" in meta) {
          delete meta.original_relpath_hash;
          totals.metaHashesDropped++;
          content = `${JSON.stringify(meta, null, 2)}\n`;
        }
      }
      const { out, counts } = redactContent(content, scrubTerms, priv);
      if (out !== original) {
        writeFileSync(file, out, "utf8");
      }
      totals.files++;
      totals.secrets += counts.secrets;
      totals.usersPaths += counts.usersPaths;
      totals.repoSlug += counts.repoSlug;
      totals.emails += counts.emails;
      totals.scrubTerms += counts.scrubTerms;
      totals.names += counts.names;
      totals.handles += counts.handles;
      totals.repoNames += counts.repoNames;
    }
  }

  console.log(JSON.stringify(totals, null, 2));
}

main();
