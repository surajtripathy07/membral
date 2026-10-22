// Shared interactive-prompt helper (issue #137).
//
// `membral setup` can now ask up to THREE sequential questions in one run
// (machine name, sync selection, agent install) — see setup.ts. node's
// readline.Interface#question() (both node:readline and the promises
// variant) turned out to be unsafe for more than one sequential question
// against piped/non-TTY stdin, confirmed live two ways:
//   - `printf 'a\nb\n' | membral setup` with a SECOND `rl.question()` call
//     issued back-to-back (no intervening async work): the promise never
//     settles — the second buffered line is silently dropped, because
//     question() only wires up a ONE-SHOT 'line' listener and readline
//     drains all currently-buffered input into 'line' events immediately
//     (flowing mode), not lazily on demand.
//   - the same, but with real async work between questions (e.g. the
//     import-sessions call setup.ts's Step 5 does before Step 6's prompt):
//     `Interface#question()` throws ERR_USE_AFTER_CLOSE — readline
//     auto-closes the Interface once the underlying (piped, finite) stdin
//     stream emits 'end', which had already happened by the time the
//     second question() call ran.
//
// Fix: don't use .question() at all. readline.Interface is async-iterable
// (`for await (const line of rl)` / `rl[Symbol.asyncIterator]()`), which
// pulls exactly one line per `.next()` call and correctly waits for more
// input rather than racing a one-shot listener against already-flowing
// data — verified to handle both of the above cases correctly with real
// piped stdin (see __tests__/prompt.test.ts).
import { createInterface } from "node:readline";

export interface Prompter {
  /** Writes `prompt` to output, then resolves with the next line of input ("" once the input stream ends with no more lines). */
  ask(prompt: string): Promise<string>;
  /** Releases the underlying readline Interface — call exactly once, after every ask() this run is done. Safe to call even if ask() was never used. */
  close(): void;
}

export function createPrompter(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): Prompter {
  const rl = createInterface({ input, output });
  const lines = rl[Symbol.asyncIterator]();

  return {
    async ask(prompt: string): Promise<string> {
      output.write(prompt);
      const next = await lines.next();
      return next.done ? "" : next.value;
    },
    close(): void {
      rl.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Raw-mode checklist (goal 2026-09-26 P10 / W11).
//
// `membral setup` step 4 used to ask "Sync all? [Y/n] or list numbers to
// exclude" — fine for a pipe, clumsy on a real terminal with 30 rows. When
// stdin is a TTY, setup now renders the scan as a checkbox list instead and
// keeps the numbered prompt above for piped / non-TTY input (issue #137's
// readline path is untouched). No dependency: raw mode + a handful of ANSI
// sequences is all a checklist needs.
//
// Keys: ↑/↓ or j/k move · space toggles · a toggles all · enter confirms ·
// ctrl-c (or q / esc) cancels. Every redraw rewrites the list in place.
//
// Terminal geometry: every rendered line is cut to `columns - 1` so no line
// ever wraps, which makes "lines drawn" equal "screen rows used" and the
// cursor-up redraw exact. A list longer than `rows - 4` scrolls a window that
// always contains the cursor, so the frame never pushes the top of the list
// into scrollback. Arrow keys arrive as CSI (`ESC [ A`) or, in application
// cursor mode (some tmux / terminal setups), SS3 (`ESC O A`); both work.
// ---------------------------------------------------------------------------

export interface ChecklistOptions {
  /** Indices (0-based) checked when the list first renders. Default: every item. */
  preselected?: Iterable<number>;
  /** Optional line printed above the list (e.g. "Choose what to sync"). */
  header?: string;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  /** Terminal width/height override; default the output's own `columns`/`rows`, else 80x24. */
  columns?: number;
  rows?: number;
}

export interface ChecklistResult {
  /** 0-based indices of the checked items, ascending. */
  selected: number[];
  /** True when the user pressed ctrl-c / q / esc instead of enter — `selected` is then the state at cancel time. */
  cancelled: boolean;
}

const CURSOR_HIDE = "\x1b[?25l";
const CURSOR_SHOW = "\x1b[?25h";
const CLEAR_LINE = "\x1b[2K";
const CLEAR_BELOW = "\x1b[J";
/** Fits in 80 columns (79 usable) on its own; a position prefix is added only when the list scrolls. */
export const KEY_HINT = "  ↑/↓ j/k move · space toggle · a all · enter confirm · ctrl-c cancel";
const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;

export interface ChecklistView {
  columns?: number;
  rows?: number;
  /** First visible item index from the previous frame; the window moves only as far as the cursor needs. */
  top?: number;
}

/** Cut `line` to at most `width` characters (code points), marking a cut with "…". */
function fitLine(line: string, width: number): string {
  const chars = Array.from(line);
  if (chars.length <= width) return line;
  if (width <= 1) return chars.slice(0, Math.max(0, width)).join("");
  return `${chars.slice(0, width - 1).join("")}…`;
}

interface RawModeStream extends NodeJS.ReadableStream {
  isRaw?: boolean;
  setRawMode?: (mode: boolean) => unknown;
}

/** Splits one stdin chunk into logical key presses — a single escape sequence (`\x1b[A`, `\x1bOA`) or one character. Exported for unit testing. */
export function splitKeys(chunk: string): string[] {
  const keys: string[] = [];
  for (let i = 0; i < chunk.length; ) {
    if (chunk[i] === "\x1b" && chunk[i + 1] === "O" && i + 2 < chunk.length) {
      // SS3: ESC O <one final char> (application cursor mode arrows)
      keys.push(chunk.slice(i, i + 3));
      i += 3;
    } else if (chunk[i] === "\x1b" && chunk[i + 1] === "[") {
      // CSI: ESC [ <params> <final byte 0x40–0x7E>
      let j = i + 2;
      while (j < chunk.length && !(chunk.charCodeAt(j) >= 0x40 && chunk.charCodeAt(j) <= 0x7e)) j++;
      keys.push(chunk.slice(i, Math.min(j + 1, chunk.length)));
      i = j + 1;
    } else {
      keys.push(chunk[i]);
      i++;
    }
  }
  return keys;
}

/**
 * Pure render of one checklist frame (no ANSI cursor movement): every line
 * fits `columns - 1`, and at most `rows - 4` items are shown — a window that
 * always contains the cursor. Returns the lines and the window's first index
 * (feed it back as `view.top` so the window scrolls minimally). Exported for
 * unit testing.
 */
export function renderChecklistFrame(
  items: string[],
  checked: boolean[],
  cursor: number,
  header?: string,
  view: ChecklistView = {},
): { lines: string[]; top: number } {
  const width = Math.max(1, (view.columns && view.columns > 0 ? view.columns : DEFAULT_COLUMNS) - 1);
  const rows = view.rows && view.rows > 0 ? view.rows : DEFAULT_ROWS;
  const capacity = Math.max(1, rows - 4);
  let top = Math.max(0, view.top ?? 0);
  if (cursor < top) top = cursor;
  if (cursor >= top + capacity) top = cursor - capacity + 1;
  top = Math.max(0, Math.min(top, Math.max(0, items.length - capacity)));
  const end = Math.min(items.length, top + capacity);

  const lines: string[] = [];
  if (header) lines.push(fitLine(header, width));
  for (let i = top; i < end; i++) {
    const pointer = i === cursor ? ">" : " ";
    const box = checked[i] ? "[x]" : "[ ]";
    lines.push(fitLine(`${pointer} ${box} ${items[i]}`, width));
  }
  const scrolls = items.length > capacity;
  lines.push(fitLine(scrolls ? `  ${cursor + 1}/${items.length}${KEY_HINT.slice(1)}` : KEY_HINT, width));
  return { lines, top };
}

/** `renderChecklistFrame` without the window bookkeeping. */
export function renderChecklist(
  items: string[],
  checked: boolean[],
  cursor: number,
  header?: string,
  view: ChecklistView = {},
): string[] {
  return renderChecklistFrame(items, checked, cursor, header, view).lines;
}

/**
 * Interactive multi-select. Resolves on enter with the checked indices, or
 * with `cancelled: true` on ctrl-c / q / esc. Puts `input` into raw mode when
 * it supports it (a real TTY) and always restores the previous mode; a plain
 * stream (tests, pipes) is read as-is, one key per character.
 */
export function checklist(items: string[], opts: ChecklistOptions = {}): Promise<ChecklistResult> {
  const input = (opts.input ?? process.stdin) as RawModeStream;
  const output = opts.output ?? process.stdout;
  const checked: boolean[] = items.map(() => false);
  for (const i of opts.preselected ?? items.map((_, i) => i)) {
    if (i >= 0 && i < items.length) checked[i] = true;
  }
  let cursor = 0;
  let top = 0;
  let drawnLines = 0;
  const tty = output as NodeJS.WritableStream & { columns?: number; rows?: number };

  function draw(): void {
    const frame = renderChecklistFrame(items, checked, cursor, opts.header, {
      columns: opts.columns ?? tty.columns,
      rows: opts.rows ?? tty.rows,
      top,
    });
    top = frame.top;
    // No rendered line wraps, so lines drawn == screen rows used: move back
    // to the first row of the previous frame, clear everything below, redraw.
    const up = drawnLines > 0 ? `\x1b[${drawnLines}A` : "";
    output.write(`${up}\r${CLEAR_BELOW}${frame.lines.map((l) => `${CLEAR_LINE}${l}`).join("\n")}\n`);
    drawnLines = frame.lines.length;
  }

  return new Promise<ChecklistResult>((resolve) => {
    const wasRaw = input.isRaw === true;
    const canRaw = typeof input.setRawMode === "function";
    if (canRaw) input.setRawMode?.(true);
    input.resume();
    output.write(CURSOR_HIDE);
    draw();

    const finish = (cancelled: boolean): void => {
      input.removeListener("data", onData);
      input.removeListener("end", onEnd);
      if (canRaw) input.setRawMode?.(wasRaw);
      input.pause();
      output.write(CURSOR_SHOW);
      const selected: number[] = [];
      checked.forEach((on, i) => {
        if (on) selected.push(i);
      });
      resolve({ selected, cancelled });
    };

    const onEnd = (): void => finish(true);

    const onData = (chunk: Buffer | string): void => {
      for (const key of splitKeys(chunk.toString())) {
        switch (key) {
          case "\r":
          case "\n":
            finish(false);
            return;
          case "\x03": // ctrl-c
          case "q":
          case "\x1b": // bare escape
            finish(true);
            return;
          case "\x1b[A":
          case "\x1bOA":
          case "k":
            cursor = items.length === 0 ? 0 : (cursor - 1 + items.length) % items.length;
            break;
          case "\x1b[B":
          case "\x1bOB":
          case "j":
            cursor = items.length === 0 ? 0 : (cursor + 1) % items.length;
            break;
          case " ":
            if (items.length > 0) checked[cursor] = !checked[cursor];
            break;
          case "a": {
            const allOn = checked.every(Boolean);
            checked.fill(!allOn);
            break;
          }
          default:
            continue;
        }
        draw();
      }
    };

    input.on("data", onData);
    input.on("end", onEnd);
  });
}
