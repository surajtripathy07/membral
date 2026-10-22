// Spawn helper for the golden CLI tests (step 0.5 of the behaviour lock,
// docs/design/architecture-refactor-programme.md row 0.5). Unlike
// help.test.ts's own `run()` (which compares against the source constants,
// locking nothing — see the behaviour-lock review, finding F8), this one
// only ever feeds committed golden text files: see cli-golden.test.ts.
import { execFile as execFileCb } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);
const __dirname = dirname(fileURLToPath(import.meta.url));

/** The BUILT CLI — never the TypeScript source. See README note in cli-golden.test.ts. */
export const CLI_BIN = resolve(__dirname, "../../../dist/index.js");

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Runs the built CLI as a real child process and captures stdout, stderr
 * and exit code together — the same three fields the golden files pin.
 */
export async function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFile(process.execPath, [CLI_BIN, ...args], { env, timeout: 10_000 });
    return { stdout, stderr, exitCode: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number | string };
    return {
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
      exitCode: typeof e.code === "number" ? e.code : 1,
    };
  }
}

/**
 * A child env isolated from both the outer shell and the developer's real
 * ~/.membral: HOME pinned at a temp dir the test owns, every MEMBRAL_ and
 * CLAUDE_CODE_ prefixed var scrubbed (the stale-env-key gotcha this repo has
 * hit before — see credentials.ts's precedence tests), and a fixed terminal
 * shape (no color codes, no width-dependent wrapping) so the golden text
 * doesn't vary by the terminal that happens to run the suite.
 */
export function goldenEnv(home: string, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, NO_COLOR: "1", TERM: "dumb", COLUMNS: "100" };
  for (const key of Object.keys(env)) {
    if (key.startsWith("MEMBRAL_") || key.startsWith("CLAUDE_CODE_")) delete env[key];
  }
  Object.assign(env, overrides);
  return env;
}

/**
 * Formats a run into the single block a golden .txt file pins — exit code,
 * then stdout, then stderr, each clearly delimited so a diff shows which
 * field moved. `home`, when given, is replaced everywhere it appears
 * (credentials.json/device.json/sync.json/sweep-state.json paths, and any
 * --root fixture path placed under it) so the golden text never embeds a
 * mkdtemp path. The CLI's version string (read from package.json at
 * index.ts:29) is likewise replaced so a version bump doesn't churn every
 * golden file.
 */
export function normalize(result: RunResult, home: string, version: string): string {
  const scrub = (s: string) => s.split(home).join("<HOME>").split(version).join("<version>");
  return [
    `EXIT: ${result.exitCode}`,
    "--- STDOUT ---",
    scrub(result.stdout),
    "--- STDERR ---",
    scrub(result.stderr),
  ].join("\n");
}
