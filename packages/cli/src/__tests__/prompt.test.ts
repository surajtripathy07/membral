// prompt.ts's createPrompter — issue #137 regression coverage. Uses REAL
// node:readline over an in-process PassThrough stream (not mocked) because
// the bug this fixes is specifically about readline's real behavior against
// non-TTY input: node:readline/promises' Interface#question() either drops
// a second buffered line (no delay between questions) or throws
// ERR_USE_AFTER_CLOSE (with async work between questions, matching what
// `membral setup` actually does between prompts) once the input stream
// ends. See prompt.ts's module doc comment for the confirmed-live repro.
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { checklist, createPrompter, KEY_HINT, renderChecklist, renderChecklistFrame, splitKeys } from "../prompt.js";

function pipedInput(lines: string[]): PassThrough {
  const input = new PassThrough();
  input.end(`${lines.join("\n")}\n`);
  return input;
}

function sink(): { stream: PassThrough; text: () => string } {
  const stream = new PassThrough();
  let text = "";
  stream.on("data", (chunk) => {
    text += chunk.toString();
  });
  return { stream, text: () => text };
}

describe("createPrompter", () => {
  it("answers two sequential asks back-to-back from input piped/ended upfront (no dropped line)", async () => {
    const input = pipedInput(["first-answer", "second-answer"]);
    const out = sink();
    const prompter = createPrompter(input, out.stream);

    const a = await prompter.ask("Q1: ");
    const b = await prompter.ask("Q2: ");

    expect(a).toBe("first-answer");
    expect(b).toBe("second-answer");
    prompter.close();
  });

  it("answers two sequential asks with real async work (a macrotask) between them", async () => {
    const input = pipedInput(["one", "two"]);
    const out = sink();
    const prompter = createPrompter(input, out.stream);

    const a = await prompter.ask("first: ");
    // Simulates the real gap in setup.ts between prompts — Step 3-5's scan/
    // import work — which is exactly what surfaced ERR_USE_AFTER_CLOSE with
    // the old .question()-per-prompt pattern.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const b = await prompter.ask("second: ");

    expect(a).toBe("one");
    expect(b).toBe("two");
    prompter.close();
  });

  it("handles three sequential asks (setup.ts's real worst case: device name, sync, agent install)", async () => {
    const input = pipedInput(["name-answer", "sync-answer", "agent-answer"]);
    const out = sink();
    const prompter = createPrompter(input, out.stream);

    expect(await prompter.ask("q1: ")).toBe("name-answer");
    expect(await prompter.ask("q2: ")).toBe("sync-answer");
    expect(await prompter.ask("q3: ")).toBe("agent-answer");
    prompter.close();
  });

  it("writes the prompt text to output before resolving", async () => {
    const input = pipedInput(["ok"]);
    const out = sink();
    const prompter = createPrompter(input, out.stream);

    await prompter.ask("Name this machine [host]: ");

    expect(out.text()).toContain("Name this machine [host]: ");
    prompter.close();
  });

  it("resolves with '' once the input stream ends with no more lines", async () => {
    const input = pipedInput(["only-one"]);
    const out = sink();
    const prompter = createPrompter(input, out.stream);

    expect(await prompter.ask("q1: ")).toBe("only-one");
    expect(await prompter.ask("q2: ")).toBe("");
    prompter.close();
  });

  it("close() is safe to call without ever asking anything", () => {
    const input = pipedInput([]);
    const out = sink();
    const prompter = createPrompter(input, out.stream);
    expect(() => prompter.close()).not.toThrow();
  });
});

// P10 (goal 2026-09-26): the raw-mode checklist `membral setup` step 4 uses
// on a TTY. Driven end-to-end through a fake stdin/stdout pair — a PassThrough
// has no setRawMode, which is exactly the "plain stream" branch the helper
// must tolerate; keys are written after the list has rendered, the way a
// person types them.

function keys(input: PassThrough, ...presses: string[]): void {
  setTimeout(() => {
    for (const k of presses) input.write(k);
  }, 0);
}

const PROJECTS = ["1. app", "2. other", "3. docs"];

describe("checklist", () => {
  it("renders every project checked with the cursor on the first row", () => {
    const lines = renderChecklist(PROJECTS, [true, true, true], 0, "Pick:");
    expect(lines[0]).toBe("Pick:");
    expect(lines[1]).toBe("> [x] 1. app");
    expect(lines[2]).toBe("  [x] 2. other");
    expect(lines[3]).toBe("  [x] 3. docs");
    expect(lines[4]).toContain("space toggle");
  });

  it("space toggles the highlighted project", async () => {
    const input = new PassThrough();
    const out = sink();
    const pending = checklist(PROJECTS, { input, output: out.stream });

    keys(input, " ", "\r");
    const result = await pending;

    expect(result.cancelled).toBe(false);
    expect(result.selected).toEqual([1, 2]);
    // The redraw shows the first row unchecked while the others stay checked.
    expect(out.text()).toContain("> [ ] 1. app");
    expect(out.text()).toContain("  [x] 2. other");
  });

  it("enter returns exactly the checked projects", async () => {
    const input = new PassThrough();
    const out = sink();
    const pending = checklist(PROJECTS, { input, output: out.stream });

    // down (arrow), toggle 2 off; down (j), toggle 3 off; up (k), toggle 2 back on; enter
    keys(input, "\x1b[B", " ", "j", " ", "k", " ", "\r");
    const result = await pending;

    expect(result).toEqual({ selected: [0, 1], cancelled: false });
  });

  it("handles several keys arriving in one stdin chunk", async () => {
    const input = new PassThrough();
    const out = sink();
    const pending = checklist(PROJECTS, { input, output: out.stream });

    keys(input, "j \x1b[Bj \r");
    const result = await pending;

    // j, space (uncheck 2), down, j (wraps to 1), space (uncheck 1), enter
    expect(result.selected).toEqual([2]);
  });

  it("`a` toggles all off, then all on", async () => {
    const input = new PassThrough();
    const out = sink();
    const pending = checklist(PROJECTS, { input, output: out.stream });

    keys(input, "a", "\r");
    expect((await pending).selected).toEqual([]);

    const input2 = new PassThrough();
    const pending2 = checklist(PROJECTS, { input: input2, output: out.stream, preselected: [0] });
    keys(input2, "a", "a", "\r");
    expect((await pending2).selected).toEqual([]);

    const input3 = new PassThrough();
    const pending3 = checklist(PROJECTS, { input: input3, output: out.stream, preselected: [0] });
    keys(input3, "a", "\r");
    expect((await pending3).selected).toEqual([0, 1, 2]);
  });

  it("preselected controls the initial checked set and the cursor wraps at both ends", async () => {
    const input = new PassThrough();
    const out = sink();
    const pending = checklist(PROJECTS, { input, output: out.stream, preselected: [2] });

    // k from row 1 wraps to the last row; space checks... it was already checked, so unchecks 3
    keys(input, "k", " ", "j", " ", "\r");
    const result = await pending;

    // row 3 toggled off, wrapped down to row 1 and toggled it on
    expect(result.selected).toEqual([0]);
  });

  it("ctrl-c cancels and reports the state at cancel time", async () => {
    const input = new PassThrough();
    const out = sink();
    const pending = checklist(PROJECTS, { input, output: out.stream });

    keys(input, " ", "\x03");
    const result = await pending;

    expect(result.cancelled).toBe(true);
    expect(result.selected).toEqual([1, 2]);
    // Listeners are released and the cursor is shown again.
    expect(input.listenerCount("data")).toBe(0);
    expect(out.text().endsWith("\x1b[?25h")).toBe(true);
  });

  it("stdin ending before enter counts as a cancel (no hang)", async () => {
    const input = new PassThrough();
    const out = sink();
    const pending = checklist(PROJECTS, { input, output: out.stream });

    setTimeout(() => input.end(), 0);
    expect((await pending).cancelled).toBe(true);
  });

  it("redraws in place: the second frame moves the cursor back up over the first", async () => {
    const input = new PassThrough();
    const out = sink();
    const pending = checklist(PROJECTS, { input, output: out.stream, header: "Pick:" });

    keys(input, "j", "\r");
    await pending;

    // 5 lines drawn (header + 3 rows + hint) → the redraw starts with ESC[5A.
    expect(out.text()).toContain("\x1b[5A");
    expect(out.text()).toContain("> [x] 2. other");
  });

  it("splitKeys separates escape sequences from plain characters", () => {
    expect(splitKeys("j\x1b[A \x1b[B\r")).toEqual(["j", "\x1b[A", " ", "\x1b[B", "\r"]);
    expect(splitKeys("\x1b")).toEqual(["\x1b"]);
    // SS3 arrows (application cursor mode) are one key each, not a bare escape.
    expect(splitKeys("\x1bOA\x1bOBj")).toEqual(["\x1bOA", "\x1bOB", "j"]);
  });

  it("SS3 arrows move the cursor instead of cancelling", async () => {
    const input = new PassThrough();
    const out = sink();
    const pending = checklist(PROJECTS, { input, output: out.stream, preselected: [] });
    keys(input, "\x1bOB", " ", "\x1bOB", "\x1bOA", "\x1bOB", "\x1bOB", " ", "\r");
    expect(await pending).toEqual({ selected: [0, 1], cancelled: false }); // last ↓ wraps to row 0
  });

  it("fits an 80x24 terminal with 60 items: no line wraps, the window fits rows-4, the cursor is always visible", () => {
    const items = Array.from(
      { length: 60 },
      (_, i) =>
        `${i + 1}. /Users/dev/src/some/deeply/nested/project-${i} (claude-code, 42 sessions) codehub.example/acme/p${i}`,
    );
    const checked = items.map((_, i) => i % 2 === 0);
    expect(Array.from(KEY_HINT).length).toBeLessThanOrEqual(79);
    let top = 0;
    for (const cursor of [0, 1, 19, 20, 21, 40, 59, 58, 30, 0]) {
      const frame = renderChecklistFrame(items, checked, cursor, "Choose what to sync:", {
        columns: 80,
        rows: 24,
        top,
      });
      top = frame.top;
      for (const l of frame.lines) expect(Array.from(l).length, l).toBeLessThanOrEqual(79);
      expect(frame.lines.length).toBeLessThanOrEqual(24 - 2); // header + (rows-4) items + hint
      const visible = frame.lines.slice(1, -1);
      expect(visible.length).toBe(20);
      const pointerRow = visible.findIndex((l) => l.startsWith(">"));
      expect(pointerRow, `cursor ${cursor}`).toBeGreaterThanOrEqual(0);
      expect(visible[pointerRow]).toContain(`${cursor + 1}. `);
      expect(frame.lines.at(-1)).toContain(`${cursor + 1}/60`);
    }
    // Minimal scroll: moving from 21 back to 20 keeps the same window (top 2).
    const a = renderChecklistFrame(items, checked, 21, undefined, { columns: 80, rows: 24, top: 0 });
    expect(a.top).toBe(2);
    expect(renderChecklistFrame(items, checked, 20, undefined, { columns: 80, rows: 24, top: a.top }).top).toBe(2);
  });

  it("redraw moves up by exactly the rows the previous frame used, even with long labels on a narrow terminal", async () => {
    const input = new PassThrough();
    const out = sink();
    const long = Array.from({ length: 30 }, (_, i) => `${i}. ${"x".repeat(200)}`);
    const pending = checklist(long, { input, output: out.stream, header: "Pick:", columns: 60, rows: 12 });
    keys(input, "j", "\r");
    await pending;
    // header + 8 items (12-4) + hint = 10 rows; nothing wraps at 60 columns.
    expect(out.text()).toContain("\x1b[10A");
    const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "g");
    for (const frameLine of out.text().split("\n")) {
      const visible = frameLine.replace(ansi, "").replace(/\r/g, "");
      expect(Array.from(visible).length).toBeLessThanOrEqual(59);
    }
  });
});
