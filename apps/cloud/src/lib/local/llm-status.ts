// The `llm` block /api/health shows on the local stack only (W7 design §10).
//
// Pure env read: no network call, never throws. Derived from the same
// resolvers the LLM paths use, so it cannot drift from what actually runs.
//
// EXTRACTION GATE. Memory extraction (lib/memory/extraction-queue.ts) runs a
// session when (1) the per-user `memory` feature allows it — it defaults to
// ENABLED with no lifetime budget (lib/feature-flags.ts header), (2) the global
// daily/monthly ceilings have headroom, and (3) a chat model resolves
// (createCostGuardedLlm -> resolveModelConfig). (1) and (2) are DB reads about
// one user's spend, not configuration, and the extract-next trigger needs only
// the service-role key the local stack always has. So the configuration-level
// gate is (3): extraction is "on" exactly when a chat key/base URL resolves.
// The separate `llm` feature flag gates KG passes, not memory extraction.

import { CLAUDE_CODE_PROVIDER, claudeCodeActivation } from "@/lib/llm/claude-code-provider";
import { resolveModelConfig } from "@/lib/llm/config";
import { embeddingsConfigured, isBundledEmbeddingConfig, resolveEmbeddingConfig } from "@/lib/llm/embedding-client";

export interface LocalLlmStatus {
  configured: boolean;
  provider: string | null;
  model: string | null;
  extraction: "on" | "off";
  /** Why extraction is off, when the chosen provider explains it (claude-code only today). */
  reason?: string;
  embeddings: { configured: boolean; model: string | null };
}

const PROVIDER_NAMES: Record<string, string> = {
  OPENAI_API_KEY: "openai",
  OPENROUTER_API_KEY: "openrouter",
  ANTHROPIC_API_KEY: "anthropic",
  GEMINI_API_KEY: "gemini",
  "base-url": "openai-compatible",
};

export function localLlmStatus(env: Record<string, string | undefined> = process.env): LocalLlmStatus {
  let provider: string | null = null;
  let model: string | null = null;
  try {
    const cfg = resolveModelConfig(env);
    if (cfg.apiKey) {
      // A named non-SDK provider (e.g. claude-code) wins; otherwise the key
      // source, with unknown sources passed through by name.
      const named = (cfg as { provider?: string }).provider;
      const source = cfg.keySource as string | undefined;
      provider = named ?? (source ? (PROVIDER_NAMES[source] ?? source) : "unknown");
      model = cfg.model;
    }
  } catch {
    // No key and no base URL: unconfigured.
  }
  const configured = provider !== null;

  const emb = resolveEmbeddingConfig(env);
  // claude-code serves chat only: LlmClient refuses embeddings unless
  // MEMBRAL_EMBEDDINGS_BASE_URL is set (client.ts refuseEmbeddingsWithoutConfig),
  // so the field must be off in that mode without it, whatever key resolves.
  // The bundled in-process model needs no base URL, so it is never refused.
  const embeddingsRefused =
    provider === CLAUDE_CODE_PROVIDER && !env.MEMBRAL_EMBEDDINGS_BASE_URL?.trim() && !isBundledEmbeddingConfig(emb);
  const embConfigured = embeddingsConfigured(env) && !embeddingsRefused;

  // claude-code chosen but refused (no token, or Claude Code could not be downloaded): say why.
  const activation =
    !configured && env.MEMBRAL_LLM_PROVIDER?.trim() === CLAUDE_CODE_PROVIDER ? claudeCodeActivation(env) : null;

  return {
    configured,
    provider,
    model,
    extraction: configured ? "on" : "off",
    ...(activation && !activation.ok ? { reason: activation.reason } : {}),
    embeddings: { configured: embConfigured, model: embConfigured ? emb.model : null },
  };
}
