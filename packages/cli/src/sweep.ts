// Shared sweep-state.json helpers, read by `membral status`'s "Last sweep:"
// line and written by `membral sweep` (sweep-command.ts). The sweep itself
// (import-sessions + render-membral-md, previously folded into `membral
// agent`'s poll loop) was removed with the bridge daemon (agent-command.ts)
// — see the 2026-09-12 refocus goal's kill list. the launchd sweep script's
// cmd_sweep (the com.membral.sweep launchd job) is now a one-line call to
// `membral sweep`, so this file is the single writer; the bash script's
// `status` still reads the same fields back with jq.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// Same bound as the launchd sweep script's sweep_state_read (up to ~1 billion runs).
const SWEEP_ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const MAX_COUNTER_DIGITS = 9;

export function defaultSweepStatePath(): string {
  return join(homedir(), ".membral", "sweep-state.json");
}

export interface SweepState {
  last_success_at: string;
  run_count: number;
  runs_since_full_walk: number;
  /** Branch rows the last sweep's ref-keyed git check reported (goal 2026-09-26 P4); absent until one has run. */
  last_ref_checks?: number;
  /** ISO week ("2026-W41") the weekly dogfood step last ran (recall-precision W3b); absent until it has. */
  dogfood_last_week?: string;
}

export function defaultSweepState(): SweepState {
  return { last_success_at: "", run_count: 0, runs_since_full_walk: 0 };
}

/** Pure: validate/sanitize a parsed JSON value into a well-formed SweepState. Never throws. */
export function validateSweepState(raw: unknown): SweepState {
  const state = defaultSweepState();
  if (!raw || typeof raw !== "object") return state;
  const r = raw as Record<string, unknown>;

  if (typeof r.last_success_at === "string" && SWEEP_ISO_RE.test(r.last_success_at)) {
    state.last_success_at = r.last_success_at;
  }

  for (const key of ["run_count", "runs_since_full_walk"] as const) {
    const v = r[key];
    if (typeof v === "number" && Number.isInteger(v) && v >= 0 && String(v).length <= MAX_COUNTER_DIGITS) {
      state[key] = v;
    }
  }

  const refChecks = r.last_ref_checks;
  if (
    typeof refChecks === "number" &&
    Number.isInteger(refChecks) &&
    refChecks >= 0 &&
    String(refChecks).length <= MAX_COUNTER_DIGITS
  ) {
    state.last_ref_checks = refChecks;
  }

  if (typeof r.dogfood_last_week === "string" && /^\d{4}-W\d{2}$/.test(r.dogfood_last_week)) {
    state.dogfood_last_week = r.dogfood_last_week;
  }

  return state;
}

/** Reads the shared sweep-state.json. Missing/unreadable/corrupt file all degrade to defaultSweepState() — never throws. */
export async function readSweepState(path: string): Promise<SweepState> {
  try {
    const raw = await readFile(path, "utf8");
    return validateSweepState(JSON.parse(raw));
  } catch {
    return defaultSweepState();
  }
}

/** Atomic write (tmp file + rename), same convention as render-membral-md.ts's writeFileAtomic. */
export async function writeSweepState(path: string, state: SweepState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmpPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(tmpPath, path);
}
