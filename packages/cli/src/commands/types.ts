// The shape every `commands/<name>.ts` module exports, and what
// `commands/index.ts` assembles into the COMMANDS registry that index.ts
// dispatches through (step 3C-4, rung G3). `run` receives the argv slice
// after the command name (what index.ts used to call `rest`); `help` is
// that command's own help block, unchanged from help.ts's HELP record so
// `membral <name> --help` output stays byte-identical.
export interface Command {
  readonly name: string;
  run(rest: string[]): Promise<void> | void;
  readonly help: string;
}
