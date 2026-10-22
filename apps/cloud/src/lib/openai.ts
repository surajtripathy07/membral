import OpenAI from "openai";
import { resolveEmbeddingConfig } from "./llm/embedding-client";

let _client: OpenAI | null = null;

/**
 * Memoized OpenAI-compatible client for lib/embeddings.ts's generateEmbedding()
 * — the single choke point every query/conversation/chunk embedding call
 * routes through (search.ts, /api/bridge/context, conversation-embeddings.ts,
 * conversation-chunks.ts, mcp/graph-tools.ts, kg/search.ts, kg/seeded-areas.ts).
 *
 * Honors the same OpenAI-compatible base-URL override the KG chat pipeline
 * uses (kg/embedding-client.ts's resolveEmbeddingConfig: MEMBRAL_EMBEDDINGS_BASE_URL,
 * falling back to MEMBRAL_MODEL_BASE_URL) so pointing the app at OpenRouter/
 * Ollama/etc. doesn't leave embeddings still hard-wired to api.openai.com.
 */
export function getOpenAI(): OpenAI {
  if (_client) return _client;
  const config = resolveEmbeddingConfig();
  if (!config.apiKey) throw new Error("Missing OPENAI_API_KEY");
  _client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL });
  return _client;
}
