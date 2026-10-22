#!/usr/bin/env node
import { createRequire } from "node:module";
import { findCommand } from "./commands/index.js";
import { HELP, HIDDEN_COMMANDS, PUBLIC_COMMANDS, TOP_LEVEL_HELP } from "./help.js";

// ESM has no ambient `require`; createRequire is the documented way to read
// package.json's version without reconfiguring the plain-tsc build for JSON
// modules (ADR 0050 D10).
// The plugin bundle (scripts/plugin/bundle-cli.mjs) has no package.json next
// to it, so esbuild defines __MEMBRAL_CLI_VERSION__ there; tsc builds read
// package.json as before.
declare const __MEMBRAL_CLI_VERSION__: string | undefined;
const VERSION =
  typeof __MEMBRAL_CLI_VERSION__ === "string"
    ? __MEMBRAL_CLI_VERSION__
    : (createRequire(import.meta.url)("../package.json").version as string);

const command = process.argv[2];
const rest = process.argv.slice(3);
const KNOWN = new Set<string>([...PUBLIC_COMMANDS, ...HIDDEN_COMMANDS, "help"]);

// --- The help/version guard (ADR 0050 §2.3) — runs BEFORE the switch body,
// so it can never be reached by a command's own side effects. Order below
// is load-bearing:
//   1. no args, top-level --help/-h/help, and --version/-v are handled here
//      directly (D10, D11).
//   2. unknown-command check, BEFORE per-command help — otherwise
//      `membral nonsense --help` would print HELP[undefined] and exit 0.
//   3. per-command help is recognised ONLY at rest[0] (positional), never
//      by scanning — args.ts has no way to tell a flag from a value that
//      looks like one, so `membral sessions --source "--help"` must not be
//      treated as a help request. See help.ts's ALL_COMMANDS_HELP / HELP
//      for the content; this file only wires the dispatch.
if (!command) {
  console.log(TOP_LEVEL_HELP);
  process.exit(0);
}

if (command === "--help" || command === "-h") {
  console.log(TOP_LEVEL_HELP);
  process.exit(0);
}

if (command === "--version" || command === "-v") {
  console.log(VERSION);
  process.exit(0);
}

if (!KNOWN.has(command)) {
  console.error(`Unknown command: ${command}`);
  console.log(TOP_LEVEL_HELP);
  process.exit(1);
}

if (rest[0] === "--help" || rest[0] === "-h") {
  console.log(HELP[command as keyof typeof HELP]);
  process.exit(0);
}

const cmd = findCommand(command);
if (!cmd) {
  // Unreachable — `command` is checked against KNOWN above. Kept as a
  // safety net rather than a `never` assertion so an editing mistake
  // fails loud instead of falling through silently.
  console.error(`Unknown command: ${command}`);
  console.log(TOP_LEVEL_HELP);
  process.exit(1);
} else {
  await cmd.run(rest);
}
