import { beforeEach, describe, expect, it, vi } from "vitest";

const ctor = vi.hoisted(() => vi.fn());
vi.mock("openai", async (orig) => {
  const mod = await orig<typeof import("openai")>();
  class FakeOpenAI {
    chat = { completions: { create: vi.fn() } };
    embeddings = { create: vi.fn() };
    constructor(o: unknown) {
      ctor(o);
    }
  }
  return { ...mod, default: FakeOpenAI };
});

import { LlmClient } from "../client";

describe("LlmClient SDK construction (#170)", () => {
  beforeEach(() => ctor.mockClear());

  it("builds every OpenAI SDK client with maxRetries 0, whatever the caller asks", () => {
    new LlmClient(
      {
        model: "gpt-4o-mini",
        baseURL: undefined,
        apiKey: "k",
        embedModel: "text-embedding-3-small",
        embedDimensions: 1536,
      },
      { maxRetries: 8, embedMaxRetries: 2, embedTimeoutMs: 5 },
    );
    expect(ctor.mock.calls.length).toBeGreaterThanOrEqual(1);
    for (const [o] of ctor.mock.calls) expect((o as { maxRetries: number }).maxRetries).toBe(0);
  });
});
