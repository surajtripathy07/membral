// D-072: a non-default embedding family never sends a query vector to a
// family-unaware RPC (search_conversations); the default family still embeds (unchanged).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockRpc = vi.fn();
vi.mock("@/lib/db/clients", () => ({ getServiceClient: () => ({ rpc: mockRpc }) }));
const mockGenerateEmbedding = vi.fn();
vi.mock("@/lib/embeddings", () => ({
  generateEmbedding: (...args: unknown[]) => mockGenerateEmbedding(...args),
}));

import { searchConversations } from "@/lib/search";

const VEC = new Array(1536).fill(0.01);

beforeEach(() => {
  mockRpc.mockReset();
  mockRpc.mockResolvedValue({ data: [], error: null });
  mockGenerateEmbedding.mockReset();
  mockGenerateEmbedding.mockResolvedValue(VEC);
  vi.stubEnv("OPENAI_API_KEY", "sk-test");
});
afterEach(() => vi.unstubAllEnvs());

describe("searchConversations (lib/search.ts)", () => {
  it("default family: embeds and sends the vector", async () => {
    await searchConversations("u1", { query: "login" });
    expect(mockGenerateEmbedding).toHaveBeenCalledTimes(1);
    expect(mockRpc.mock.calls[0][1].query_embedding).toBe(`[${VEC.join(",")}]`);
  });

  it("non-default family: keyword-only, no embed call", async () => {
    vi.stubEnv("MEMBRAL_EMBEDDING_MODEL", "nomic-embed-text");
    await searchConversations("u1", { query: "login" });
    expect(mockGenerateEmbedding).not.toHaveBeenCalled();
    expect(mockRpc.mock.calls[0][1].query_embedding).toBeNull();
  });
});
