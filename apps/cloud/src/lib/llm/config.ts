// LLM model and cost-cap configuration, moved from lib/kg/types.ts (refactor
// programme step 1.1). lib/kg/types.ts re-exports these names.

import { isLocalMode } from "../local/mode";
import { log } from "../log";
import { CLAUDE_CODE_PROVIDER, claudeCodeActivation, claudeCodeModelLabel } from "./claude-code-provider";
import { DUMMY_API_KEY, isLocalModelBaseURL, resolveEmbeddingConfig } from "./embedding-client";

// ------------------------------------------------------------------
// Model configuration
// ------------------------------------------------------------------

export interface ModelConfig {
  /** Chat model id. Default "gpt-4o-mini". Ollama 13B+ opt-in via MEMBRAL_MODEL. */
  model: string;
  /** OpenAI-compatible base URL. undefined => OpenAI. Set for Ollama, e.g. http://localhost:11434/v1 */
  baseURL: string | undefined;
  /** API key. For a local (Ollama) base URL the SDK still needs a non-empty string. */
  apiKey: string;
  /** Which env var supplied the key (never the value), for diagnostics. */
  keySource?: ChatKeySource;
  /** Embedding model id. Default "text-embedding-3-small". */
  embedModel: string;
  /** Embedding dimensions. MUST stay 1536 to match kg_conv_embeddings vector(1536). */
  embedDimensions: 1536;
  /**
   * Embeddings-only base URL override (open-weight trial, 2026-09-24).
   * Optional and undefined by default — `LlmClient` then reuses `baseURL`
   * (today's behavior: embeddings ride the SAME client/base URL as chat, one
   * OpenAI SDK instance for both, per kg/llm.ts's `embed`/`embedMany`). Set
   * this (MEMBRAL_EMBEDDINGS_BASE_URL) ONLY when it must differ from `baseURL`
   * — e.g. chat moved to OpenRouter for a trial model but `memory_embedding`
   * calls must stay on api.openai.com. Also set `embedApiKey` when this is
   * set, since a differing base URL almost always needs a differing key.
   */
  embedBaseURL?: string;
  /**
   * Embeddings-only API key override (open-weight trial, 2026-09-24).
   * Optional and undefined by default — `LlmClient` then reuses `apiKey`.
   * Set via MEMBRAL_EMBEDDINGS_API_KEY alongside `embedBaseURL` above.
   */
  embedApiKey?: string;
  /**
   * D-072: the embeddings base URL was set explicitly (MEMBRAL_EMBEDDINGS_BASE_URL
   * or MEMBRAL_MODEL_BASE_URL) to a loopback host or host.docker.internal (e.g.
   * Ollama), or MEMBRAL_EMBEDDINGS_FREE=1 is set (isFreeEmbeddingBaseURL), so an
   * embedding model missing from the price table is billed $0 instead of
   * refused. Never true on the provider-key default path.
   */
  embedSelfHosted?: boolean;
  /**
   * D-072 / W7 D4: MEMBRAL_MODEL_BASE_URL points at this machine
   * (isLocalModelBaseURL: loopback or host.docker.internal, e.g. Ollama), or
   * MEMBRAL_MODEL_FREE=1 is set alongside a base URL, so a chat model missing
   * from the price table is billed $0 instead of refused. Never true on a
   * provider-key default path (no explicit base URL).
   */
  chatSelfHosted?: boolean;
  /**
   * "claude-code" (W7 D7, D-072): chat calls run the local `claude` CLI
   * (claude-code-provider.ts) instead of the OpenAI SDK. Undefined = the
   * OpenAI-compatible HTTP path, unchanged.
   */
  provider?: typeof CLAUDE_CODE_PROVIDER;
}

export type ChatKeySource =
  | "OPENAI_API_KEY"
  | "OPENROUTER_API_KEY"
  | "ANTHROPIC_API_KEY"
  | "GEMINI_API_KEY"
  | "base-url"
  | "CLAUDE_CODE_OAUTH_TOKEN";

const DEFAULT_CHAT_MODEL = "gpt-4o-mini";

// Resolution order = priority. Each provider key has an OpenAI-compatible
// endpoint and a cheap default model, used only when the caller sets neither
// MEMBRAL_MODEL_BASE_URL nor MEMBRAL_MODEL. OpenAI itself needs no base URL.
const CHAT_PROVIDERS: ReadonlyArray<{
  envKey: Exclude<ChatKeySource, "base-url" | "CLAUDE_CODE_OAUTH_TOKEN">;
  baseURL: string | undefined;
  model: string;
}> = [
  { envKey: "OPENAI_API_KEY", baseURL: undefined, model: DEFAULT_CHAT_MODEL },
  { envKey: "OPENROUTER_API_KEY", baseURL: "https://openrouter.ai/api/v1", model: `openai/${DEFAULT_CHAT_MODEL}` },
  { envKey: "ANTHROPIC_API_KEY", baseURL: "https://api.anthropic.com/v1/", model: "claude-sonnet-5" },
  {
    envKey: "GEMINI_API_KEY",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
    model: "gemini-2.5-flash",
  },
];

/**
 * Resolve model configuration from the environment.
 * - Key: first set of OPENAI_API_KEY, OPENROUTER_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY;
 *   else a dummy key when MEMBRAL_MODEL_BASE_URL is set; else throws.
 * - MEMBRAL_MODEL_BASE_URL always wins as the base URL; otherwise the chosen provider's default.
 * - Default chat model: gpt-4o-mini for OpenAI / explicit base URL (the honest quality floor per
 *   ADR Finding 5), a cheap per-provider default for the other keys. MEMBRAL_MODEL overrides.
 */
export function resolveModelConfig(env: Record<string, string | undefined> = process.env): ModelConfig {
  if (env.MEMBRAL_LLM_PROVIDER?.trim() === CLAUDE_CODE_PROVIDER) return resolveClaudeCodeConfig(env);
  const explicitBaseURL = env.MEMBRAL_MODEL_BASE_URL?.trim() || undefined;
  const provider = CHAT_PROVIDERS.find((p) => env[p.envKey]?.trim());
  const apiKey = (provider && env[provider.envKey]?.trim()) || (explicitBaseURL ? DUMMY_API_KEY : "");
  if (!apiKey) {
    throw new Error(
      "Missing LLM key (set OPENAI_API_KEY, OPENROUTER_API_KEY, ANTHROPIC_API_KEY or GEMINI_API_KEY, or set MEMBRAL_MODEL_BASE_URL to use a local OpenAI-compatible model).",
    );
  }
  const keySource: ChatKeySource = provider?.envKey ?? "base-url";
  const baseURL = explicitBaseURL ?? provider?.baseURL;
  const model = env.MEMBRAL_MODEL?.trim() || (explicitBaseURL ? undefined : provider?.model) || DEFAULT_CHAT_MODEL;
  return {
    model,
    baseURL,
    apiKey,
    keySource,
    // Delegates to embedding-client.ts's resolveEmbeddingConfig — the single
    // source of truth for the embedding model id (MEMBRAL_EMBEDDING_MODEL,
    // falling back to this module's older MEMBRAL_EMBED_MODEL name, then the
    // "text-embedding-3-small" default). NOTE: kg/llm.ts's LlmClient shares
    // ONE OpenAI client for both chat and embed calls, so its baseURL always
    // matches `baseURL` above — MEMBRAL_EMBEDDINGS_BASE_URL (an embeddings-
    // only override) is honored by lib/embeddings.ts's generateEmbedding()
    // (the query/conversation/chunk embedding path), not here.
    embedModel: resolveEmbeddingConfig(env).model,
    embedDimensions: 1536,
    // Open-weight trial (2026-09-24): both undefined unless explicitly set —
    // see ModelConfig's doc comments. Deliberately NOT the
    // MEMBRAL_EMBEDDINGS_BASE_URL/MEMBRAL_EMBEDDING_MODEL precedence
    // `resolveEmbeddingConfig` uses for lib/embeddings.ts's OWN client
    // (generateEmbedding, the query/conversation/chunk path) — that function
    // still doesn't read `embedApiKey` at all, so it can't be reused here.
    embedBaseURL: env.MEMBRAL_EMBEDDINGS_BASE_URL?.trim() || undefined,
    embedApiKey: env.MEMBRAL_EMBEDDINGS_API_KEY?.trim() || undefined,
    embedSelfHosted: resolveEmbeddingConfig(env).selfHosted === true,
    chatSelfHosted:
      explicitBaseURL !== undefined &&
      (isLocalModelBaseURL(explicitBaseURL) || (isLocalMode(env) && env.MEMBRAL_MODEL_FREE?.trim() === "1")),
  };
}

let claudeCodeRefusalLogged = false;

/**
 * MEMBRAL_LLM_PROVIDER=claude-code: fails closed (throws, so chatConfigured()
 * is false) when the provider may not run here, logging the reason once. It
 * never falls through to a provider key: a paid key in the same env is not
 * used for chat. Embeddings ride MEMBRAL_EMBEDDINGS_BASE_URL/_API_KEY only;
 * with neither set, LlmClient.embed refuses (embeddings stay off).
 */
function resolveClaudeCodeConfig(env: Record<string, string | undefined>): ModelConfig {
  const active = claudeCodeActivation(env);
  if (!active.ok) {
    if (!claudeCodeRefusalLogged) {
      claudeCodeRefusalLogged = true;
      log.warn("claude-code LLM provider not configured", { reason: active.reason });
    }
    throw new Error(active.reason);
  }
  return {
    model: claudeCodeModelLabel(env),
    baseURL: undefined,
    // Never sent anywhere: the chat path spawns `claude`, which reads CLAUDE_CODE_OAUTH_TOKEN itself.
    apiKey: DUMMY_API_KEY,
    keySource: "CLAUDE_CODE_OAUTH_TOKEN",
    embedModel: resolveEmbeddingConfig(env).model,
    embedDimensions: 1536,
    embedBaseURL: env.MEMBRAL_EMBEDDINGS_BASE_URL?.trim() || undefined,
    embedApiKey: env.MEMBRAL_EMBEDDINGS_API_KEY?.trim() || undefined,
    embedSelfHosted: resolveEmbeddingConfig(env).selfHosted === true,
    provider: CLAUDE_CODE_PROVIDER,
  };
}

/** Test-only: lets the once-per-process refusal log fire again. */
export function resetClaudeCodeRefusalLogForTests(): void {
  claudeCodeRefusalLogged = false;
}

// ------------------------------------------------------------------
// Cost cap / ceiling configuration (GitHub issue #21, ADR 0027 J6.2)
// ------------------------------------------------------------------

export interface CostCapConfig {
  /** Per-run hard cap in USD. Enforced DURING the run (LlmClient.capUsd) — see llm.ts. Default $5 (ADR 0027:284). */
  perRunCapUsd: number;
  /**
   * Rolling 30-day per-user spend ceiling in USD. `null` means the mechanism
   * exists but is NOT enforcing — there is deliberately NO default here (ADR
   * 0027 J6.2 maintainer decision, 2026-07-25): the dollar figure is a product/
   * pricing call that must be set explicitly before the first paid user, never
   * silently assumed. See checkMonthlyCeiling (spend-ledger.ts).
   */
  monthlyCeilingUsd: number | null;
}

const DEFAULT_PER_RUN_CAP_USD = 5;

/**
 * Parses a non-negative finite number from an env string for a cost-cap
 * setting. `0` IS a valid, meaningful value (driver decision, issue #21
 * adversarial review m7): a per-run cap of 0 halts at the very first budget
 * check (before any call); a monthly ceiling of 0 blocks every run outright
 * (spend can never be negative, so `spent >= 0` is always true). Only blank/
 * unset is silent (caller falls back to its own default without a warning);
 * a NON-blank value that fails to parse (garbage text) or is negative is a
 * real misconfiguration — logged, then falls back the same way blank does.
 */
// Exported (D5, ADR 0030 addendum "D9 — the arrival loop") so
// arrival-loop.ts's resolveIncrementalCapUsd (MEMBRAL_KG_INCREMENTAL_CAP_USD)
// reuses this exact parse/validate/warn behavior instead of a second copy.
export function parseNonNegativeUsd(raw: string | undefined, envKey: string): number | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) {
    log.warn(`${envKey}: unparseable or negative value, falling back to default`, { env_key: envKey, raw: trimmed });
    return undefined;
  }
  return n;
}

/**
 * Resolve the KG cost-cap configuration from the environment (mirrors
 * resolveModelConfig's parameterized style).
 * - MEMBRAL_KG_COST_CAP_USD: per-run cap, default 5 when unset. `0` is valid
 *   and enforcing (halts at the first check). Garbage/negative -> warn + default.
 * - MEMBRAL_KG_MONTHLY_CEILING_USD: rolling monthly ceiling, NO default when
 *   unset -> null (mechanism present, not enforcing) — never guess a dollar
 *   figure here. `0` is valid and enforcing (blocks every run). Garbage/
 *   negative -> warn + null.
 */
export function resolveCostCapConfig(env: Record<string, string | undefined> = process.env): CostCapConfig {
  return {
    perRunCapUsd:
      parseNonNegativeUsd(env.MEMBRAL_KG_COST_CAP_USD, "MEMBRAL_KG_COST_CAP_USD") ?? DEFAULT_PER_RUN_CAP_USD,
    monthlyCeilingUsd:
      parseNonNegativeUsd(env.MEMBRAL_KG_MONTHLY_CEILING_USD, "MEMBRAL_KG_MONTHLY_CEILING_USD") ?? null,
  };
}

/** True iff resolveModelConfig would yield a key (chat/LLM calls can run). Never throws. */
export function chatConfigured(env: Record<string, string | undefined> = process.env): boolean {
  try {
    return Boolean(resolveModelConfig(env).apiKey);
  } catch {
    return false;
  }
}
