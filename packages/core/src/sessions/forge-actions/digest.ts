import { redactCommandSecrets } from "../redact.js";
import { chainSpans, ENV_ASSIGNMENT, shellWordSpans, WRAPPERS } from "./shell.js";
import { FORGE_COMMAND, TEST_COMMAND } from "./types.js";

// --- digest privacy ------------------------------------------------------

/** Placeholder for free-form text (messages, bodies, titles, heredocs) in a stored digest (F9). */
export const TEXT_PLACEHOLDER = "‹text›";

// Flags whose value is free-form prose, per tool and subcommand. Short flags
// mean different things across subcommands (`glab mr create -b` is the
// target branch, `gh pr create -d` is draft, `glab issue update -m` is the
// milestone), so a short flag is scrubbed only where it is the text flag;
// branch, draft and milestone values survive.
const TEXT_LONG_FLAGS = new Set([
  "--message",
  "--body",
  "--title",
  "--description",
  "--notes",
  "--subject",
  "--squash-message",
]);
const TEXT_SHORT_FLAGS: Record<string, string[]> = {
  "git commit": ["-m"],
  "git tag": ["-m"],
  "git merge": ["-m"],
  "git stash": ["-m"],
  "git notes": ["-m"],
  "gh pr create": ["-t", "-b"],
  "gh pr edit": ["-t", "-b"],
  "gh pr comment": ["-b"],
  "gh pr review": ["-b"],
  "gh pr merge": ["-t", "-b"],
  "gh pr close": ["-c", "--comment"],
  "gh issue create": ["-t", "-b"],
  "gh issue edit": ["-t", "-b"],
  "gh issue comment": ["-b"],
  "gh issue close": ["-c", "--comment"],
  "gh release create": ["-t", "-n"],
  "gh release edit": ["-t", "-n"],
  "glab mr create": ["-t", "-d"],
  "glab mr update": ["-t", "-d"],
  "glab mr note": ["-m"],
  "glab mr comment": ["-m"],
  "glab mr merge": ["-m"],
  "glab issue create": ["-t", "-d"],
  "glab issue update": ["-t", "-d"],
  "glab issue note": ["-m"],
  "glab issue comment": ["-m"],
  "glab release create": ["-n"],
};
// `gh api` / `glab api` fields whose value is prose: `-f body=…`, `--raw-field title=…`.
const API_FIELD_FLAGS = new Set(["-f", "-F", "--field", "--raw-field"]);
const API_TEXT_KEY = /^(body|title|description|note|comment|message|notes|subject)=/;
const TEXT_FLAG_WITH_EQ = /^(--message|--body|--title|--description|--notes|--subject|--comment|--squash-message)=/;

/** `git commit`, `gh pr create`, `glab api`, … — the key into TEXT_SHORT_FLAGS. */
function commandKey(program: string, args: string[]): string {
  if (program === "git") {
    let i = 0;
    while (i < args.length && args[i].startsWith("-")) i += args[i] === "-C" || args[i] === "-c" ? 2 : 1;
    return `git ${args[i] ?? ""}`;
  }
  const pos = args.filter((a) => !a.startsWith("-"));
  if (pos[0] === "api") return `${program} api`;
  return `${program} ${pos[0] ?? ""} ${pos[1] ?? ""}`;
}

/**
 * The command with every free-form text value replaced by `‹text›`: the
 * value of a message/body/title/description flag, a prose `gh api` field and
 * every heredoc body. The verb, flags, branches and refs stay, so the digest
 * still reads as the command.
 */
export function scrubFreeText(command: string): string {
  const cuts: Array<[number, number, string]> = [];
  const heredocs: Array<[number, number]> = [];
  for (const [s, e] of chainSpans(command, heredocs)) {
    const words = shellWordSpans(command.slice(s, e));
    let k = 0;
    while (k < words.length && (ENV_ASSIGNMENT.test(words[k].text) || WRAPPERS.has(words[k].text))) k++;
    const program = words[k]?.text.replace(/^.*\//, "");
    if (program !== "git" && program !== "gh" && program !== "glab") continue;
    const key = commandKey(
      program,
      words.slice(k + 1).map((w) => w.text),
    );
    const shortFlags = new Set(TEXT_SHORT_FLAGS[key] ?? []);
    const isApi = key.endsWith(" api");
    const isGitMessage = shortFlags.has("-m") && program === "git";
    for (let j = k + 1; j < words.length; j++) {
      const w = words[j];
      if (w.quoted) continue;
      const next = words[j + 1];
      const valueNext = next !== undefined && (next.quoted || !next.text.startsWith("-"));
      if (isApi && API_FIELD_FLAGS.has(w.text) && next && API_TEXT_KEY.test(next.text)) {
        const raw = command.slice(s + next.start, s + next.end);
        const eqAt = raw.indexOf("=");
        // Keep the key and a quote balanced: `"note=looks wrong"` → `"note=‹text›"`.
        const q = raw[0] === '"' || raw[0] === "'" ? raw[0] : "";
        if (eqAt !== -1) cuts.push([s + next.start + eqAt + 1, s + next.end, `${TEXT_PLACEHOLDER}${q}`]);
        j++;
        continue;
      }
      const takesNext =
        TEXT_LONG_FLAGS.has(w.text) || shortFlags.has(w.text) || (isGitMessage && /^-[a-zA-Z]+m$/.test(w.text));
      if (takesNext && valueNext) {
        cuts.push([s + next.start, s + next.end, TEXT_PLACEHOLDER]);
        j++;
        continue;
      }
      const eq = TEXT_FLAG_WITH_EQ.exec(w.text);
      if (eq) {
        cuts.push([s + w.start + eq[0].length, s + w.end, TEXT_PLACEHOLDER]);
        continue;
      }
      if (isGitMessage && /^-m./.test(w.text)) {
        cuts.push([s + w.start + 2, s + w.end, TEXT_PLACEHOLDER]);
      }
    }
  }
  for (const [bs, be] of heredocs) cuts.push([bs, be, `${TEXT_PLACEHOLDER}\n`]);
  if (cuts.length === 0) return command;
  cuts.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged: Array<[number, number, string]> = [];
  for (const c of cuts) {
    const last = merged[merged.length - 1];
    if (last && c[0] < last[1]) {
      if (c[1] > last[1]) last[1] = c[1];
      continue;
    }
    merged.push([...c]);
  }
  let out = "";
  let at = 0;
  for (const [a, b, rep] of merged) {
    out += command.slice(at, a) + rep;
    at = b;
  }
  return out + command.slice(at);
}

/** Digest cap for forge commands — raised from 400 so a heredoc commit message rarely hides a trailing `&& git push`. */
export const MAX_FORGE_DIGEST_CHARS = 1200;
/** Digest cap for everything else on the allowlist. */
export const MAX_DIGEST_CHARS = 400;

/**
 * Redacted, capped digest of a Bash command, or undefined when the command is
 * not on the allowlist. Shared by both harness parsers so the gate never
 * drifts between them.
 */
export function digestBashCommand(command: unknown): string | undefined {
  const cmd = typeof command === "string" ? command.trim() : "";
  if (!cmd) return undefined;
  const cap = FORGE_COMMAND.test(cmd) ? MAX_FORGE_DIGEST_CHARS : TEST_COMMAND.test(cmd) ? MAX_DIGEST_CHARS : 0;
  if (!cap) return undefined;
  let scrubbed = cmd;
  try {
    scrubbed = scrubFreeText(cmd);
  } catch {
    scrubbed = cmd;
  }
  return redactCommandSecrets(scrubbed).slice(0, cap);
}
