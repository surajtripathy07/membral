// Centralized embeddings client configuration (membral #106-adjacent fix,
// 2026-08-27: the OpenAI account ran out of credits and chat calls were
// pointed at OpenRouter via MEMBRAL_MODEL_BASE_URL — but every embeddings
// call site still went straight to api.openai.com, so query/conversation/
// chunk embeddings kept failing even after chat recovered).
//
// This is the ONE place embedding-model/base-URL resolution happens.
// lib/openai.ts's getOpenAI() (the client lib/embeddings.ts's
// generateEmbedding() uses for every query/conversation/chunk embed —
// search.ts, /api/bridge/context, conversation-embeddings.ts,
// conversation-chunks.ts, mcp/graph-tools.ts, kg/search.ts,
// kg/seeded-areas.ts all funnel through that single function) calls
// resolveEmbeddingConfig() below to build its client. kg/types.ts's
// resolveModelConfig() (the KG chat pipeline's resolver — kg/llm.ts's
// LlmClient.embed/embedMany already shared the chat client's baseURL, so
// those were never actually broken) also delegates its embedModel field
// here, so there's exactly one source of truth for "which embedding model
// id to use."
//
// Precedence:
//   base URL:  MEMBRAL_EMBEDDINGS_BASE_URL > MEMBRAL_MODEL_BASE_URL > undefined (api.openai.com)
//   model id:  MEMBRAL_EMBEDDING_MODEL > MEMBRAL_EMBED_MODEL (kg/types.ts's older name) > "text-embedding-3-small"
//
// Verified 2026-08-26 against OpenRouter (https://openrouter.ai/api/v1/embeddings):
// the BARE "text-embedding-3-small" id resolves directly — 200, 1536-dim
// vectors, no "openai/" prefix required. callEmbeddingsCreate below still
// carries a one-shot fallback to the "openai/"-prefixed id for a
// hypothetical OpenAI-compatible provider that rejects the bare id, so a
// future base-URL swap to some other aggregator doesn't silently break
// embeddings the same way again.

import { isLocalMode } from "../local/mode";
import { log } from "../log";
import { BUNDLED_EMBEDDING_MODEL, isBundledEmbeddingModel } from "./bundled-embedder";

/**
 * The one source of truth for the embedding vector width — matches the
 * pgvector column width on every embeddings table (kg_conv_embeddings,
 * conversations.embedding, conversation_chunks.embedding). lib/embeddings.ts
 * imports this rather than keeping its own literal, so a future column-width
 * change is a one-line edit here.
 */
/** Placeholder key for local OpenAI-compatible servers (e.g. Ollama) that ignore auth but whose SDK needs a non-empty string. */
export const DUMMY_API_KEY = "not-needed";

export const EMBEDDING_DIMENSIONS = 1536 as const;

export interface EmbeddingConfig {
  /** Embedding model id. Default "text-embedding-3-small". */
  model: string;
  /** OpenAI-compatible base URL. undefined => api.openai.com. */
  baseURL: string | undefined;
  /**
   * API key. May be "" when OPENAI_API_KEY is unset and no baseURL fallback
   * applies — this resolver is a PURE env read and never throws (unlike
   * kg/types.ts's resolveModelConfig); callers that need a real client
   * decide for themselves whether a missing key is fatal (lib/openai.ts's
   * getOpenAI() throws, mirroring its own pre-existing behavior).
   */
  apiKey: string;
  /** Matches EMBEDDING_DIMENSIONS above — the pgvector column width. */
  dimensions: typeof EMBEDDING_DIMENSIONS;
  /**
   * True when the base URL came from MEMBRAL_EMBEDDINGS_BASE_URL or
   * MEMBRAL_MODEL_BASE_URL AND isFreeEmbeddingBaseURL holds (loopback,
   * host.docker.internal, or MEMBRAL_EMBEDDINGS_FREE=1). Only then may an
   * unpriced model be billed at $0 (D-072). Optional so hand-built configs in
   * tests stay valid.
   */
  selfHosted?: boolean;
}

// ------------------------------------------------------------------
// Embedding family (D-072, W7 local embeddings). Vectors from different
// models live in different spaces; cosine between them is meaningless. Every
// stored vector records its family (migration 118's `embedding_model`, NULL =
// the default family) and the store never holds two (embedding-family.ts).
// ------------------------------------------------------------------

/** The family every pre-118 vector belongs to; a NULL `embedding_model` means this. */
export const DEFAULT_EMBEDDING_FAMILY = "text-embedding-3-small";

/**
 * The model id with the known `openai/` provider prefix stripped:
 * `openai/text-embedding-3-small` (OpenRouter, or callEmbeddingsCreate's retry)
 * is the same vectors as the bare id. Any other `x/y` id is kept whole — a
 * different provider's `y` is not known to be the same model.
 */
export function canonicalEmbeddingFamily(model: string): string {
  const m = model.trim();
  return m.startsWith("openai/") ? m.slice("openai/".length) : m;
}

/** The family this process embeds with (env-resolved, same precedence as resolveEmbeddingConfig). */
export function currentEmbeddingFamily(env: Record<string, string | undefined> = process.env): string {
  return canonicalEmbeddingFamily(resolveEmbeddingConfig(env).model);
}

export function isDefaultEmbeddingFamily(family: string): boolean {
  return canonicalEmbeddingFamily(family) === DEFAULT_EMBEDDING_FAMILY;
}

/**
 * The `embedding_model` payload field for a write (migration 118): only a
 * non-default family with a vector writes the column. The default family
 * omits the key entirely (NULL already means default), so the hosted app
 * keeps working against a pre-118 database.
 */
export function embeddingModelField(
  hasVector: boolean,
  family: string = currentEmbeddingFamily(),
): { embedding_model?: string } {
  return hasVector && !isDefaultEmbeddingFamily(family) ? { embedding_model: canonicalEmbeddingFamily(family) } : {};
}

/**
 * True when embedding calls are free to run (D-072 $0 pricing): the base URL
 * host is loopback (localhost, 127.0.0.0/8, ::1) or host.docker.internal, or
 * MEMBRAL_EMBEDDINGS_FREE=1 says so explicitly. Any other host — including a
 * private-network one — keeps the normal price lookup.
 */
export function isFreeEmbeddingBaseURL(
  baseURL: string | undefined,
  env: Record<string, string | undefined> = process.env,
): boolean {
  // Local stack only (same gate as the claude-code provider): a stray flag on Vercel is ignored.
  if (isLocalMode(env) && env.MEMBRAL_EMBEDDINGS_FREE?.trim() === "1") return true;
  return isLocalModelBaseURL(baseURL);
}

/**
 * True when a model base URL points at this machine: loopback (localhost,
 * 127.0.0.0/8, ::1) or host.docker.internal (the local stack's way to reach
 * Ollama on the host). Shared by the embeddings and chat $0 rules (D-072).
 * Any other host — including a private-network one — is not local.
 */
export function isLocalModelBaseURL(baseURL: string | undefined): boolean {
  if (!baseURL) return false;
  let host: string;
  try {
    host = new URL(baseURL).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return false;
  }
  if (host === "localhost" || host === "host.docker.internal" || host === "::1") return true;
  return /^127\.\d+\.\d+\.\d+$/.test(host);
}

/**
 * The `dimensions` request field for a model: only OpenAI's text-embedding-3
 * family accepts it. Other models (e.g. Ollama's nomic-embed-text, 768-d) get
 * no `dimensions` and are zero-padded by padEmbedding instead.
 */
export function requestDimensions(model: string): typeof EMBEDDING_DIMENSIONS | undefined {
  return canonicalEmbeddingFamily(model).startsWith("text-embedding-3") ? EMBEDDING_DIMENSIONS : undefined;
}

/**
 * The embeddings request body for `model`. OpenAI's text-embedding-3 family
 * gets `dimensions`. Every other model (e.g. Ollama's nomic-embed-text) gets
 * `encoding_format: "float"`: without it the openai SDK asks for base64 and
 * decodes the reply as base64, but Ollama ignores the field and sends a float
 * array, which that decode turns into a vector of near-zero garbage (W7 D4,
 * seen live as all-zero stored embeddings).
 */
export function embeddingRequestBody<I extends string | string[]>(
  model: string,
  input: I,
): { model: string; input: I; dimensions?: number; encoding_format?: "float" } {
  const dimensions = requestDimensions(model);
  return dimensions === undefined ? { model, input, encoding_format: "float" } : { model, input, dimensions };
}

/** A provider returned a vector wider than the vector(1536) columns. Never truncated: a truncated vector is a different (wrong) vector. */
export class EmbeddingDimensionError extends Error {
  constructor(public readonly dimensions: number) {
    super(
      `Embedding has ${dimensions} dimensions; the store holds at most ${EMBEDDING_DIMENSIONS}. Use a model with ${EMBEDDING_DIMENSIONS} or fewer dimensions.`,
    );
    this.name = "EmbeddingDimensionError";
  }
}

/**
 * Right-pads a vector with zeros to EMBEDDING_DIMENSIONS. Cosine is unchanged:
 * the dot product gains only 0*0 terms and both norms only 0^2 terms. A wider
 * vector throws EmbeddingDimensionError.
 */
export function padEmbedding(vector: number[]): number[] {
  if (vector.length > EMBEDDING_DIMENSIONS) throw new EmbeddingDimensionError(vector.length);
  if (vector.length === EMBEDDING_DIMENSIONS) return vector;
  return [...vector, ...new Array<number>(EMBEDDING_DIMENSIONS - vector.length).fill(0)];
}

/**
 * What a writer stores for a vector `model` returned: wider than the column is
 * always an error; a model asked for `dimensions` (requestDimensions) is
 * returned as-is (the provider already sized it, so the default path is
 * unchanged); any other model is zero-padded.
 */
export function fitEmbedding(vector: number[], model: string): number[] {
  if (vector.length > EMBEDDING_DIMENSIONS) throw new EmbeddingDimensionError(vector.length);
  return requestDimensions(model) === undefined ? padEmbedding(vector) : vector;
}

/** True when `config` selects the in-process bundled model (no HTTP client is built for it). */
export function isBundledEmbeddingConfig(config: EmbeddingConfig): boolean {
  return isBundledEmbeddingModel(config.model);
}

/**
 * Resolves embeddings client configuration from the environment. Pure and
 * never throws — a missing OPENAI_API_KEY resolves to `apiKey: ""` (or
 * `"ollama"` when a base URL is set, mirroring resolveModelConfig's same
 * placeholder-for-local-servers convention) rather than throwing, so calling
 * this to inspect just the model/baseURL never fails a test or request path
 * that doesn't otherwise need a live client.
 */
export function resolveEmbeddingConfig(env: Record<string, string | undefined> = process.env): EmbeddingConfig {
  const explicitBaseURL = env.MEMBRAL_EMBEDDINGS_BASE_URL?.trim() || env.MEMBRAL_MODEL_BASE_URL?.trim() || undefined;
  // Only OpenAI and OpenRouter can serve the stored 1536-dim embeddings.
  // ANTHROPIC_API_KEY is deliberately NOT used (Anthropic has no embeddings API) and neither is
  // GEMINI_API_KEY (its vector dimension differs from the kg_conv_embeddings vector(1536) column).
  const openaiKey = env.OPENAI_API_KEY?.trim();
  const openrouterKey = openaiKey ? undefined : env.OPENROUTER_API_KEY?.trim();
  const explicitModel = env.MEMBRAL_EMBEDDING_MODEL?.trim() || env.MEMBRAL_EMBED_MODEL?.trim();
  // Bundled in-process model: chosen by naming it, or, in local mode only, when nothing else is configured.
  // Never on a hosted deploy by default (isLocalMode is false on Vercel), and never over a key or base URL.
  const bundled = explicitModel
    ? isBundledEmbeddingModel(explicitModel)
    : isLocalMode(env) && !explicitBaseURL && !openaiKey && !openrouterKey;
  if (bundled) {
    return {
      model: BUNDLED_EMBEDDING_MODEL,
      baseURL: undefined,
      apiKey: DUMMY_API_KEY,
      dimensions: EMBEDDING_DIMENSIONS,
      selfHosted: true,
    };
  }
  const apiKey = openaiKey || openrouterKey || (explicitBaseURL ? DUMMY_API_KEY : "");
  const baseURL = explicitBaseURL ?? (openrouterKey ? "https://openrouter.ai/api/v1" : undefined);
  const model =
    env.MEMBRAL_EMBEDDING_MODEL?.trim() ||
    env.MEMBRAL_EMBED_MODEL?.trim() ||
    (openrouterKey && !explicitBaseURL ? "openai/text-embedding-3-small" : "text-embedding-3-small");
  return {
    model,
    baseURL,
    apiKey,
    dimensions: EMBEDDING_DIMENSIONS,
    selfHosted: explicitBaseURL !== undefined && isFreeEmbeddingBaseURL(explicitBaseURL, env),
  };
}

/** The degraded note search tools return when embeddingsConfigured() is false (W7 D3). */
export const EMBEDDINGS_NOT_CONFIGURED_MESSAGE =
  "SEARCH DEGRADED: no embedding provider is configured (set OPENAI_API_KEY, OPENROUTER_API_KEY or MEMBRAL_EMBEDDINGS_BASE_URL) — keyword-only results";

/**
 * The degraded note for a non-default embedding family on search paths whose
 * RPCs compare a query vector with stored vectors without a family filter or a
 * per-family floor (chat/code unified search, KG search): they run keyword-only.
 */
export const EMBEDDING_FAMILY_KEYWORD_ONLY_MESSAGE =
  "SEARCH DEGRADED: a local embedding model is configured; this search compares vectors calibrated for text-embedding-3-small, so it is keyword-only";

/** True iff the current embedding family may meet stored vectors in a family-unaware RPC (the default family only). */
export function queryVectorsAllowed(env: Record<string, string | undefined> = process.env): boolean {
  return isDefaultEmbeddingFamily(currentEmbeddingFamily(env));
}

/** True iff resolveEmbeddingConfig yields a key, i.e. embedding calls can run. */
export function embeddingsConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(resolveEmbeddingConfig(env).apiKey);
}

/** What callEmbeddingsCreate needs from an embeddings.create response — a subset of the OpenAI SDK's CreateEmbeddingResponse. */
export interface EmbeddingCreateResultLike {
  data: Array<{ embedding: number[] }>;
  usage?: { prompt_tokens?: number } | null;
}

/** Per-request SDK options for a query-time embed: an abort signal, no SDK retries, an explicit timeout. */
export interface EmbeddingRequestOptions {
  signal?: AbortSignal;
  maxRetries?: number;
  timeout?: number;
}

/** MEMBRAL_EMBED_TIMEOUT_MS: the query-time embedding call's own timeout (SDK default is 10 minutes). Default 4000. */
export function embedTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.MEMBRAL_EMBED_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 4_000;
}

/** callEmbeddingsCreate's result: vectors padded to EMBEDDING_DIMENSIONS, plus the model id actually sent (after any retry). */
export interface EmbeddingCallResult extends EmbeddingCreateResultLike {
  usedModel: string;
  /** canonicalEmbeddingFamily(usedModel) — what a writer records in `embedding_model`. */
  family: string;
}

/** Minimal structural surface of an OpenAI SDK error we depend on for classification — mirrors lib/embeddings.ts's own StatusedError. */
interface StatusedError extends Error {
  status?: number;
  code?: string;
}

/**
 * True only for a 400/404 (or the SDK's `model_not_found` error code) whose
 * message indicates the MODEL id itself was rejected — never a token-
 * overflow, rate-limit, or input-validation error, which must propagate
 * untouched for the caller's own retry logic (e.g. lib/embeddings.ts's
 * halving-on-overflow loop) to handle.
 */
function isUnknownModelError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const e = err as StatusedError;
  // The SDK's own error code is authoritative when present — skip the message
  // heuristic entirely rather than requiring it to also spell out "not found".
  if (e.code === "model_not_found") return true;
  if (e.status !== 400 && e.status !== 404) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes("model") &&
    (msg.includes("not found") ||
      msg.includes("not_found") ||
      msg.includes("does not exist") ||
      msg.includes("invalid") ||
      msg.includes("unknown") ||
      msg.includes("no endpoints"))
  );
}

/**
 * Issues one embeddings.create call for `config.model`. When `config.baseURL`
 * is set (an OpenAI-compatible override) and the provider rejects the BARE
 * model id specifically as unknown, retries ONCE with an "openai/"-prefixed
 * id — dormant today (OpenRouter accepts the bare id directly, see the file
 * header), kept as a safety net for a future provider swap.
 *
 * `create` is a plain callback rather than a client object so callers can
 * pass `(body) => openai.embeddings.create(body)` directly — avoids pinning
 * this module to the OpenAI SDK's own response type shape.
 */
export async function callEmbeddingsCreate(
  create: (
    body: {
      model: string;
      input: string | string[];
      dimensions?: number;
      encoding_format?: "float";
    },
    requestOptions?: EmbeddingRequestOptions,
  ) => Promise<EmbeddingCreateResultLike>,
  config: EmbeddingConfig,
  input: string | string[],
  requestOptions?: EmbeddingRequestOptions,
): Promise<EmbeddingCallResult> {
  // The second argument is passed only when set, so every caller that sets none sees the one-argument call it always did.
  const call = (body: Parameters<typeof create>[0]) => (requestOptions ? create(body, requestOptions) : create(body));
  const body = (model: string) => embeddingRequestBody(model, input);
  const finish = (response: EmbeddingCreateResultLike, usedModel: string): EmbeddingCallResult => ({
    ...response,
    data: response.data.map((d) => ({ ...d, embedding: fitEmbedding(d.embedding, usedModel) })),
    usedModel,
    family: canonicalEmbeddingFamily(usedModel),
  });
  try {
    return finish(await call(body(config.model)), config.model);
  } catch (err) {
    if (config.baseURL && !config.model.startsWith("openai/") && isUnknownModelError(err)) {
      const fallbackModel = `openai/${config.model}`;
      log.warn("embeddings: bare model id rejected on base URL — retrying with openai/ prefix", {
        model: config.model,
        base_url: config.baseURL,
      });
      return finish(await call(body(fallbackModel)), fallbackModel);
    }
    throw err;
  }
}
