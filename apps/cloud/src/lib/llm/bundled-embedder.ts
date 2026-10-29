// Bundled local embeddings (docs/design/2026-10-25_docker-free-store.md, "Embeddings: bundled model and the floor").
// nomic-embed-text-v1.5 as ONNX through @huggingface/transformers (onnxruntime-node), so a local install needs no
// Ollama. The model id is distinct from Ollama's `nomic-embed-text`: a q8 ONNX file and Ollama's GGUF give different
// vectors, and the store never mixes families. Task prefixes (`search_document: `, `search_query: `) are applied by the
// callers, which key on /nomic/i in the family id (raw-units/embed.ts isNomicFamily), so they apply here unchanged.
//
// This module has no imports from embedding-client.ts (which imports the constants below). The model downloads on first
// use (about 137 MB, q8) into a cache directory and is loaded once per process.
import os from "node:os";
import path from "node:path";
import { BUNDLED_EMBEDDING_MODEL } from "@/lib/domain/embedding-model-ids";

/** The family id recorded on every vector this embedder produces (defined in the dependency-free domain module). */
export { BUNDLED_EMBEDDING_MODEL };

/** Hugging Face repo and the exact commit pinned (a moved `main` must never change stored vectors). */
export const BUNDLED_EMBEDDING_REPO = "nomic-ai/nomic-embed-text-v1.5";
export const BUNDLED_EMBEDDING_REVISION = "e9b6763023c676ca8431644204f50c2b100d9aab";

/** q8 resolves to onnx/model_quantized.onnx in the repo. */
export const BUNDLED_EMBEDDING_DTYPE = "q8";

export function isBundledEmbeddingModel(model: string): boolean {
  return model.trim() === BUNDLED_EMBEDDING_MODEL;
}

/** MEMBRAL_MODEL_CACHE_DIR, else ~/.membral/models. */
export function bundledModelCacheDir(env: Record<string, string | undefined> = process.env): string {
  return env.MEMBRAL_MODEL_CACHE_DIR?.trim() || path.join(os.homedir(), ".membral", "models");
}

/** What the pipeline returns, reduced to what we read. */
export interface EmbeddingTensorLike {
  tolist(): number[][];
}
export type FeatureExtractor = (
  texts: string[],
  options: { pooling: "mean"; normalize: boolean },
) => Promise<EmbeddingTensorLike>;

/** Loads the pipeline. Replaceable in tests so none of them downloads a model. */
export type PipelineLoader = () => Promise<FeatureExtractor>;

const defaultLoader: PipelineLoader = async () => {
  const { pipeline, env } = await import("@huggingface/transformers");
  env.cacheDir = bundledModelCacheDir();
  const extractor = await pipeline("feature-extraction", BUNDLED_EMBEDDING_REPO, {
    revision: BUNDLED_EMBEDDING_REVISION,
    dtype: BUNDLED_EMBEDDING_DTYPE,
  });
  return extractor as unknown as FeatureExtractor;
};

let loader: PipelineLoader = defaultLoader;
let loaded: Promise<FeatureExtractor> | null = null;
let failedAt = 0;
let failure: Error | null = null;

/** A failed load (offline, disk full) is not retried sooner than this: callers get the cached error at once. */
export const BUNDLED_LOAD_RETRY_MS = 5 * 60_000;

/** A model load (download included) that has not settled by now counts as a failure and enters the failure cache. */
export const BUNDLED_LOAD_TIMEOUT_MS = 10 * 60_000;

/** nomic takes 8192 tokens; 16k characters stays under that for ordinary text and bounds the padded batch tensor. */
export const BUNDLED_MAX_CHARS = 16_000;

let nowMs: () => number = Date.now;

/** Tests only: swap the loader (and clock) and drop the cached pipeline and cached failure. */
export function setBundledPipelineLoaderForTests(next: PipelineLoader | null, clock?: () => number): void {
  loader = next ?? defaultLoader;
  nowMs = clock ?? Date.now;
  loaded = null;
  failedAt = 0;
  failure = null;
}

function withLoadTimeout(work: Promise<FeatureExtractor>): Promise<FeatureExtractor> {
  return new Promise<FeatureExtractor>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`bundled embedding model load timed out after ${BUNDLED_LOAD_TIMEOUT_MS}ms`)),
      BUNDLED_LOAD_TIMEOUT_MS,
    );
    work.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

function getExtractor(): Promise<FeatureExtractor> {
  if (loaded) return loaded;
  if (failure && nowMs() - failedAt < BUNDLED_LOAD_RETRY_MS) return Promise.reject(failure);
  const p = withLoadTimeout(loader()).then(
    (ex) => {
      failure = null;
      return ex;
    },
    (err) => {
      if (loaded === p) loaded = null;
      failure = err instanceof Error ? err : new Error(String(err));
      failedAt = nowMs();
      throw failure;
    },
  );
  loaded = p;
  return p;
}

/** Starts loading the model in the background (local mode startup). Never throws, never awaited on a request path. */
export function warmBundledEmbedder(): void {
  getExtractor().catch(() => {});
}

/** Rejects when `signal` aborts or `timeoutMs` elapses before `work` settles; the work itself keeps running. */
function race<T>(work: Promise<T>, opts: { signal?: AbortSignal; timeoutMs?: number }): Promise<T> {
  const { signal, timeoutMs } = opts;
  if (!signal && timeoutMs === undefined) return work;
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => done(() => reject(signal?.reason ?? new Error("aborted")));
    const done = (fn: () => void) => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (timeoutMs !== undefined) {
      timer = setTimeout(
        () => done(() => reject(new Error(`bundled embedding timed out after ${timeoutMs}ms (model still loading?)`))),
        timeoutMs,
      );
    }
    work.then(
      (v) => done(() => resolve(v)),
      (e) => done(() => reject(e)),
    );
  });
}

/**
 * Embeds `input` and returns an embeddings.create-shaped result (768-d unit vectors; callEmbeddingsCreate zero-pads
 * them to 1536 like the Ollama path). `usage` is omitted: nothing is billed. Model load and inference race the abort
 * signal and `timeout`/`timeoutMs`, so a cold first call returns an error fast instead of hanging on the download.
 */
export async function bundledEmbeddingsCreate(
  body: { input: string | string[] },
  requestOptions?: { signal?: AbortSignal; timeout?: number; timeoutMs?: number },
): Promise<{ data: Array<{ embedding: number[] }> }> {
  const texts = (Array.isArray(body.input) ? body.input : [body.input]).map((t) =>
    t.length > BUNDLED_MAX_CHARS ? t.slice(0, BUNDLED_MAX_CHARS) : t,
  );
  const raceOpts = { signal: requestOptions?.signal, timeoutMs: requestOptions?.timeout ?? requestOptions?.timeoutMs };
  requestOptions?.signal?.throwIfAborted();
  const out = await race(
    getExtractor().then((extractor) => extractor(texts, { pooling: "mean", normalize: true })),
    raceOpts,
  );
  return { data: out.tolist().map((embedding) => ({ embedding })) };
}
