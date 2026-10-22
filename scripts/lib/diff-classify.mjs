// Shared line classifier and unified-diff parser (used by check-pure-move and
// check-move-coverage): blank / comment / import / export-from detection.

export const isBlank = (l) => l.trim() === "";
export const isComment = (l, hash) => /^\s*(\/\/|\/\*|\*)/.test(l) || (hash && /^\s*#(?!!)/.test(l));
// `#` starts a comment only in shell/yaml/toml/text files (in TS it is a private field).
export const hashComments = (p) => /\.(sh|ya?ml|toml|txt|py)$|(^|\/)\.[^/.]+$/.test(p ?? "");
export const isImportExportFrom = (l) =>
  /^\s*import[\s{*"']/.test(l) ||
  /^\s*export\s+(\*|\{[^}]*\}|type\s+\{[^}]*\})\s*from\s/.test(l) ||
  /^\s*\}\s*from\s+["']/.test(l) ||
  /\bvi\.(mock|doMock)\(\s*["'`]/.test(l);

// Tag each line of one side of a hunk block as exempt when it is blank, a
// comment, or part of an import / export-from statement (multi-line braces).
export function exemptFlags(lines, hash = false) {
  const flags = [];
  let inImport = false;
  for (const l of lines) {
    if (inImport) {
      flags.push(true);
      if (/\bfrom\s+["']|^\s*\}\s*;?\s*$/.test(l)) inImport = false;
      continue;
    }
    if (/^\s*(import|export)\s+(type\s+)?\{[^}]*$/.test(l)) {
      inImport = true;
      flags.push(true);
      continue;
    }
    flags.push(isBlank(l) || isComment(l, hash) || isImportExportFrom(l));
  }
  return flags;
}

export function parseDiff(text) {
  const files = [];
  let cur = null;
  let oldLn = 0;
  let newLn = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      cur = { oldPath: null, newPath: null, removed: [], added: [], binary: false };
      files.push(cur);
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("--- ")) cur.oldPath = line === "--- /dev/null" ? null : line.slice(6);
    else if (line.startsWith("+++ ")) cur.newPath = line === "+++ /dev/null" ? null : line.slice(6);
    else if (line.startsWith("rename from ")) cur.oldPath = line.slice(12);
    else if (line.startsWith("rename to ")) cur.newPath = line.slice(10);
    else if (line.startsWith("Binary files ")) cur.binary = true;
    else if (line.startsWith("@@")) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      oldLn = Number(m[1]);
      newLn = Number(m[2]);
    } else if (line.startsWith("-")) cur.removed.push({ ln: oldLn++, text: line.slice(1) });
    else if (line.startsWith("+")) cur.added.push({ ln: newLn++, text: line.slice(1) });
  }
  return files;
}

