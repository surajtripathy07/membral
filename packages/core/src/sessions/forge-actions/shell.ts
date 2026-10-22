// --- shell tokenising ----------------------------------------------------

// Quoting contexts. `(` is a code context (a subshell or `$( … )`) — inside
// it quotes, heredocs and nested `$(` are parsed afresh, also when the `$(`
// itself sits inside a double-quoted string (`"$(cat <<'EOF' … EOF\n)"`).
type ShellCtx = "'" | '"' | "`" | "(";

const HEREDOC_MARKER = /^<<-?[ \t]*(?:'([^'\n]+)'|"([^"\n]+)"|\\?([A-Za-z_][\w-]*))/;

/**
 * Skip the heredoc bodies that start at `from`, one per terminator in order.
 * `after` is the index just past the last terminator line; `bodyEnd` is where
 * that terminator line starts (both the end of input when a terminator never
 * appears).
 */
function skipHeredocBodies(command: string, from: number, terminators: string[]): { after: number; bodyEnd: number } {
  let at = from;
  let bodyEnd = command.length;
  for (const term of terminators) {
    let found = false;
    while (at < command.length) {
      const lineStart = at;
      const nl = command.indexOf("\n", at);
      const line = command.slice(at, nl === -1 ? command.length : nl);
      at = nl === -1 ? command.length : nl + 1;
      if (line.trim() === term) {
        found = true;
        bodyEnd = lineStart;
        break;
      }
    }
    if (!found) return { after: command.length, bodyEnd: command.length };
  }
  return { after: at, bodyEnd };
}

interface ShellScan {
  /** Called for every character that is shell code or quoted text (never a heredoc body), with the context stack depth after it. */
  onChar?: (i: number, ch: string, depthBefore: number, depthAfter: number) => void;
  /** Called at a top-level separator: the segment ends at `end`, the next one starts at `next`. */
  onSeparator?: (end: number, next: number) => void;
  /** Called for each heredoc body span `[start, end)` (terminator line excluded). */
  onHeredoc?: (start: number, end: number) => void;
}

/**
 * One pass over a shell command honouring single/double quotes, backticks,
 * `$( … )` and subshells (their own quoting context, also inside `"…"`) and
 * heredoc bodies (never code). Separators are `&&`, `||`, `|&`, `;`, `|` and
 * newlines at the top level only.
 */
function scanShell(command: string, scan: ShellScan): void {
  const stack: ShellCtx[] = [];
  const pending: string[] = [];
  let i = 0;
  const step = (n: number, depthBefore: number) => {
    for (let k = 0; k < n && i < command.length; k++, i++) scan.onChar?.(i, command[i], depthBefore, stack.length);
  };
  while (i < command.length) {
    const ch = command[i];
    const top = stack[stack.length - 1];
    const d = stack.length;
    if (top === "'") {
      if (ch === "'") stack.pop();
      step(1, d);
      continue;
    }
    if (top === '"' || top === "`") {
      if (ch === "\\") {
        step(2, d);
        continue;
      }
      if (ch === top) {
        stack.pop();
        step(1, d);
        continue;
      }
      if (top === '"' && ch === "$" && command[i + 1] === "(") {
        stack.push("(");
        step(2, d);
        continue;
      }
      if (top === '"' && ch === "`") {
        stack.push("`");
        step(1, d);
        continue;
      }
      step(1, d);
      continue;
    }
    // Code context: the top level or inside `( … )`.
    if (ch === "\\") {
      step(2, d);
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`" || ch === "(") {
      stack.push(ch);
      step(1, d);
      continue;
    }
    if (ch === ")") {
      if (top === "(") stack.pop();
      step(1, d);
      continue;
    }
    if (ch === "<" && command[i + 1] === "<" && command[i + 2] !== "<") {
      const m = HEREDOC_MARKER.exec(command.slice(i));
      if (m) {
        pending.push(m[1] ?? m[2] ?? m[3] ?? "");
        step(m[0].length, d);
        continue;
      }
    }
    if (ch === "\n" && pending.length > 0) {
      const bodyStart = i + 1;
      const { after, bodyEnd } = skipHeredocBodies(command, bodyStart, pending);
      if (bodyEnd > bodyStart) scan.onHeredoc?.(bodyStart, bodyEnd);
      pending.length = 0;
      if (stack.length === 0) scan.onSeparator?.(i, after);
      i = after;
      continue;
    }
    if (stack.length === 0) {
      if (command.startsWith("&&", i) || command.startsWith("||", i) || command.startsWith("|&", i)) {
        scan.onSeparator?.(i, i + 2);
        i += 2;
        continue;
      }
      if (ch === "\n" || ch === ";" || ch === "|") {
        scan.onSeparator?.(i, i + 1);
        i++;
        continue;
      }
    }
    step(1, d);
  }
}

/** Segment spans `[start, end)` of a chain; heredoc body spans are appended to `heredocs` when given. */
export function chainSpans(command: string, heredocs?: Array<[number, number]>): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let segStart = 0;
  const add = (end: number) => {
    const text = command.slice(segStart, end);
    const lead = text.length - text.trimStart().length;
    const trail = text.length - text.trimEnd().length;
    if (text.trim()) spans.push([segStart + lead, end - trail]);
  };
  scanShell(command, {
    onSeparator: (end, next) => {
      add(end);
      segStart = next;
    },
    onHeredoc: (s, e) => heredocs?.push([s, e]),
  });
  add(command.length);
  return spans;
}

/**
 * Split a shell command on `&&`, `||`, `;`, `|` and newlines, outside quotes,
 * `$( … )` groups and heredoc bodies, so `git add -A && git commit -m "a; b"
 * && git push` yields three segments and a heredoc commit message never
 * leaks its lines as commands. A segment that opened a heredoc keeps its
 * header line only.
 */
export function splitShellChain(command: string): string[] {
  const out: string[] = [];
  for (const [s, e] of chainSpans(command)) out.push(command.slice(s, e));
  return out;
}

type ChainOp = "&&" | "||" | "|" | ";";

/** Each chain segment with the operator before and after it (`;` also stands for a newline; null at the ends). */
export function chainSegments(command: string): Array<{ text: string; before: ChainOp | null; after: ChainOp | null }> {
  const spans = chainSpans(command);
  const ops: ChainOp[] = [];
  for (let i = 0; i + 1 < spans.length; i++) {
    const gap = command.slice(spans[i][1], spans[i + 1][0]).replace(/^[ \t]+/, "");
    ops.push(gap.startsWith("&&") ? "&&" : gap.startsWith("||") ? "||" : gap.startsWith("|") ? "|" : ";");
  }
  return spans.map(([s, e], i) => ({
    text: command.slice(s, e),
    before: i > 0 ? ops[i - 1] : null,
    after: i < ops.length ? ops[i] : null,
  }));
}

interface ShellWord {
  /** The word with its outermost quotes removed. */
  text: string;
  start: number;
  end: number;
  /** The word began with a quote (so it is never a flag or a redirection). */
  quoted: boolean;
}

/** Whitespace-split one segment, honouring quotes (outermost dropped) and keeping `$( … )` as one word; heredoc bodies are left out. */
export function shellWordSpans(segment: string): ShellWord[] {
  const words: ShellWord[] = [];
  let cur = "";
  let start = -1;
  let quoted = false;
  let end = 0;
  const flush = () => {
    if (start !== -1) words.push({ text: cur, start, end, quoted });
    cur = "";
    start = -1;
    quoted = false;
  };
  scanShell(segment, {
    onChar: (i, ch, before, after) => {
      if (before === 0 && after === 0 && /\s/.test(ch)) {
        flush();
        return;
      }
      if (start === -1) {
        start = i;
        quoted = before === 0 && (ch === "'" || ch === '"');
      }
      end = i + 1;
      const opensQuote = before === 0 && after === 1 && (ch === "'" || ch === '"');
      const closesQuote = before === 1 && after === 0 && (ch === "'" || ch === '"');
      if (!opensQuote && !closesQuote) cur += ch;
    },
    onSeparator: () => flush(),
  });
  flush();
  return words;
}

export function shellWords(segment: string): string[] {
  return dropRedirections(shellWordSpans(segment));
}

// `2>&1`, `>/dev/null`, `2>/dev/null`, `>file`, `<file`, `&>log`, `>>log`, `<<EOF`.
const REDIRECTION = /^(?:\d*|&)(?:>>?|<<?-?|>&|<&|>\|)/;
// The same operator with its target in the NEXT word (`> out.txt`, `2> err`).
const BARE_REDIRECTION = /^(?:\d*|&)(?:>>?|<<?-?|>&|<&|>\|)$/;

/** Words minus shell redirections, so `git push origin main 2>&1` has positionals `origin main`. */
function dropRedirections(words: ShellWord[]): string[] {
  const out: string[] = [];
  for (let k = 0; k < words.length; k++) {
    const w = words[k];
    if (!w.quoted && REDIRECTION.test(w.text)) {
      if (BARE_REDIRECTION.test(w.text)) k++;
      continue;
    }
    out.push(w.text);
  }
  return out;
}

// Wrappers that precede the real program in a segment.
export const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
export const WRAPPERS = new Set(["env", "time", "sudo", "command", "nice", "exec"]);

export function programAndArgs(words: string[]): { program: string; args: string[] } | null {
  let i = 0;
  while (i < words.length && (ENV_ASSIGNMENT.test(words[i]) || WRAPPERS.has(words[i]))) i++;
  if (i >= words.length) return null;
  const program = words[i].replace(/^.*\//, "");
  return { program, args: words.slice(i + 1) };
}
