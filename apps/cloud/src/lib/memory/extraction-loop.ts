// In-process extraction loop for the local stack (docs/design/2026-10-25_docker-free-store.md, rung one). It replaces
// the kicker container: every 2 minutes it calls the same kick function the cron route calls (kickExtraction, kick
// mode), so there is one claim path with its backoff, LLM ceilings and per-user lease. Local mode only; never hosted.
// Started from instrumentation.ts register(). A globalThis singleton keeps dev HMR (which re-runs modules) from
// stacking timers; a run that is still going when the next tick fires makes that tick a no-op; a failed run is logged
// and the loop carries on.
import { warmBundledEmbedder } from "@/lib/llm/bundled-embedder";
import { isBundledEmbeddingConfig, resolveEmbeddingConfig } from "@/lib/llm/embedding-client";
import { isLocalMode } from "@/lib/local/mode";
import { log } from "@/lib/log";
import { kickExtraction } from "./extraction-kick";

export const EXTRACTION_LOOP_INTERVAL_MS = 2 * 60_000;
/** The first tick runs this soon after start, so sessions pending across a restart do not wait a full interval. */
export const EXTRACTION_LOOP_FIRST_TICK_MS = 10_000;

const LOOP_KEY = Symbol.for("membral.extractionLoop");

interface LoopState {
  timer: ReturnType<typeof setInterval>;
  first: ReturnType<typeof setTimeout>;
  running: boolean;
}

type GlobalWithLoop = typeof globalThis & { [LOOP_KEY]?: LoopState };

/** True when the loop should run: local mode, the Node runtime, and MEMBRAL_EXTRACTION_LOOP not set to "0". */
export function extractionLoopEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return isLocalMode(env) && env.NEXT_RUNTIME === "nodejs" && env.MEMBRAL_EXTRACTION_LOOP?.trim() !== "0";
}

/** One tick. Never throws; skipped while the previous run is still going. */
export async function runExtractionTick(state: Pick<LoopState, "running">): Promise<void> {
  if (state.running) return;
  state.running = true;
  try {
    const res = await kickExtraction("kick");
    if (!res.ok) log.warn("extraction loop: kick failed", { err: res.error });
  } catch (err) {
    log.error("extraction loop: tick threw", { err: err instanceof Error ? err.message : String(err) });
  } finally {
    state.running = false;
  }
}

/** Starts the loop once per process. Returns true when this call started it. */
export function startExtractionLoop(env: Record<string, string | undefined> = process.env): boolean {
  if (!extractionLoopEnabled(env)) return false;
  const g = globalThis as GlobalWithLoop;
  if (g[LOOP_KEY]) return false;
  const state = { running: false } as LoopState;
  state.timer = setInterval(() => void runExtractionTick(state), EXTRACTION_LOOP_INTERVAL_MS);
  state.first = setTimeout(() => void runExtractionTick(state), EXTRACTION_LOOP_FIRST_TICK_MS);
  // The loop must never keep a process alive on its own (tests, `next build` workers).
  state.timer.unref?.();
  state.first.unref?.();
  // Warm the bundled embedding model in the background (download + load); no request waits on it.
  if (isBundledEmbeddingConfig(resolveEmbeddingConfig(env))) warmBundledEmbedder();
  g[LOOP_KEY] = state;
  log.info("extraction loop: started", { interval_ms: EXTRACTION_LOOP_INTERVAL_MS });
  return true;
}

/** Stops the loop (tests). */
export function stopExtractionLoop(): void {
  const g = globalThis as GlobalWithLoop;
  const state = g[LOOP_KEY];
  if (!state) return;
  clearInterval(state.timer);
  clearTimeout(state.first);
  delete g[LOOP_KEY];
}
