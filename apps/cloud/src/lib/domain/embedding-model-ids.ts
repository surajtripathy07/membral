// Embedding family ids that domain code must name without importing an embedder (no node:* or SDK imports here).
// lib/llm/bundled-embedder.ts re-exports these, so existing imports of it keep working.

/** The family id recorded on every vector the bundled ONNX embedder produces. */
export const BUNDLED_EMBEDDING_MODEL = "nomic-embed-text-v1.5-onnx-q8";
