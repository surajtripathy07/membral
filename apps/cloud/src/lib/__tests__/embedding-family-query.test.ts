// D-072 / migration 139: the default family embeds and sends no family args (unchanged); a family with chat floors
// (nomic-embed-text) embeds and sends p_embedding_model plus p_min_similarity; any other family never sends a query
// vector to search_conversations.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockRpc = vi.fn();
vi.mock("@/lib/db/clients", () => ({ getServiceClient: () => ({ rpc: mockRpc }) }));
const mockGenerateEmbedding = vi.fn();
vi.mock("@/lib/embeddings", () => ({
  generateEmbedding: (...args: unknown[]) => mockGenerateEmbedding(...args),
}));

import { BUNDLED_EMBEDDING_MODEL } from "@/lib/domain/embedding-model-ids";
import { CHAT_FAMILY_THRESHOLDS } from "@/lib/domain/similarity";
import { chatVectorPlan } from "@/lib/llm/embedding-family";
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

  it("default family: sends neither p_embedding_model nor p_min_similarity", async () => {
    await searchConversations("u1", { query: "login" });
    expect(mockRpc.mock.calls[0][1]).not.toHaveProperty("p_embedding_model");
    expect(mockRpc.mock.calls[0][1]).not.toHaveProperty("p_min_similarity");
  });

  it("nomic-embed-text: embeds and sends its family with sem_floor as the cut", async () => {
    vi.stubEnv("MEMBRAL_EMBEDDING_MODEL", "nomic-embed-text");
    await searchConversations("u1", { query: "login" });
    expect(mockGenerateEmbedding).toHaveBeenCalledTimes(1);
    const args = mockRpc.mock.calls[0][1];
    expect(args.query_embedding).toBe(`[${VEC.join(",")}]`);
    expect(args.p_embedding_model).toBe("nomic-embed-text");
    expect(args.p_min_similarity).toBe(0.68);
  });

  it("nomic-embed-text in keyword mode: no vector, no family args", async () => {
    vi.stubEnv("MEMBRAL_EMBEDDING_MODEL", "nomic-embed-text");
    await searchConversations("u1", { query: "login", mode: "keyword" });
    expect(mockGenerateEmbedding).not.toHaveBeenCalled();
    expect(mockRpc.mock.calls[0][1].query_embedding).toBeNull();
    expect(mockRpc.mock.calls[0][1]).not.toHaveProperty("p_embedding_model");
  });

  it("uncalibrated family (bundled ONNX): keyword-only, no embed call, no family args", async () => {
    vi.stubEnv("MEMBRAL_EMBEDDING_MODEL", BUNDLED_EMBEDDING_MODEL);
    await searchConversations("u1", { query: "login" });
    expect(mockGenerateEmbedding).not.toHaveBeenCalled();
    expect(mockRpc.mock.calls[0][1].query_embedding).toBeNull();
    expect(mockRpc.mock.calls[0][1]).not.toHaveProperty("p_embedding_model");
  });

  it("nomic-embed-text: an RPC failure falls back to keyword with no family args", async () => {
    vi.stubEnv("MEMBRAL_EMBEDDING_MODEL", "nomic-embed-text");
    mockRpc.mockResolvedValueOnce({ data: null, error: { message: "boom" } });
    await searchConversations("u1", { query: "login" });
    expect(mockRpc).toHaveBeenCalledTimes(2);
    expect(mockRpc.mock.calls[1][1].query_embedding).toBeNull();
    expect(mockRpc.mock.calls[1][1]).not.toHaveProperty("p_embedding_model");
  });
});

describe("chatVectorPlan (lib/llm/embedding-family.ts)", () => {
  it("default family: allowed, no args", () => {
    expect(chatVectorPlan("text-embedding-3-small")).toEqual({ allowed: true, rpcArgs: {} });
  });
  it("nomic-embed-text: allowed with its family and sem_floor", () => {
    expect(chatVectorPlan("nomic-embed-text")).toEqual({
      allowed: true,
      rpcArgs: { p_embedding_model: "nomic-embed-text", p_min_similarity: 0.68 },
    });
  });
  it("any other family, including bundled ONNX: not allowed", () => {
    expect(chatVectorPlan(BUNDLED_EMBEDDING_MODEL)).toEqual({ allowed: false });
    expect(chatVectorPlan("some-other-model")).toEqual({ allowed: false });
  });
  it("the chat table holds only the measured nomic row", () => {
    expect(CHAT_FAMILY_THRESHOLDS).toEqual({
      "nomic-embed-text": { sem_floor: 0.68, mixed_sem_floor: 0.63, sql_cut: 0.55 },
    });
  });
});
