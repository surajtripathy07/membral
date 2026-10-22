// ~/.membral/config.json — machine-wide CLI choices that later commands must
// honour, in the same per-file style as sync.json. Today one key:
//   prompt_recall: false — `membral setup --no-prompt-recall` turned the
//   Claude Code UserPromptSubmit recall hook off; every later `membral setup`
//   and `membral install-session-hook` keeps it off until `--prompt-recall`
//   turns it back on (docs/design/prompt-time-recall.md §4).
// A missing key means the default (on). Unknown keys are kept on write.
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface CliConfig {
  prompt_recall?: boolean;
  [key: string]: unknown;
}

export function defaultCliConfigPath(): string {
  return join(homedir(), ".membral", "config.json");
}

/** Missing, unreadable or corrupt file -> {} (defaults). Never throws. */
export function loadCliConfig(path: string = defaultCliConfigPath()): CliConfig {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as CliConfig) : {};
  } catch {
    return {};
  }
}

export function saveCliConfig(config: CliConfig, path: string = defaultCliConfigPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  // Atomic (tmp file in the same directory + rename), same convention as sweep.ts's writeSweepState.
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmpPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(tmpPath, path);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // nothing to clean up
    }
    throw err;
  }
}

/** Prompt recall is on unless the user turned it off. */
export function promptRecallEnabled(path: string = defaultCliConfigPath()): boolean {
  return loadCliConfig(path).prompt_recall !== false;
}

/**
 * Record an explicit choice (`--prompt-recall` / `--no-prompt-recall`).
 * Best effort: a write failure is reported to the caller as false, never thrown.
 */
export function setPromptRecall(enabled: boolean, path: string = defaultCliConfigPath()): boolean {
  try {
    const config = loadCliConfig(path);
    if (enabled) delete config.prompt_recall;
    else config.prompt_recall = false;
    saveCliConfig(config, path);
    return true;
  } catch {
    return false;
  }
}
