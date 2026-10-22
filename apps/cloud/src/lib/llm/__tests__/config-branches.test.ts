import { describe, expect, it } from "vitest";
import { resolveModelConfig } from "../config";

// Issue #188 / R5 5.11: the embeddings-only endpoint overrides on both the
// provider-key path and the claude-code path.

const CLAUDE_ENV = {
  MEMBRAL_LLM_PROVIDER: "claude-code",
  MEMBRAL_LOCAL: "1",
  CLAUDE_CODE_OAUTH_TOKEN: "tok",
};

describe("embedBaseURL / embedApiKey", () => {
  it("provider-key path: read from MEMBRAL_EMBEDDINGS_* and trimmed", () => {
    const cfg = resolveModelConfig({
      OPENAI_API_KEY: "sk",
      MEMBRAL_EMBEDDINGS_BASE_URL: "  http://emb.local/v1  ",
      MEMBRAL_EMBEDDINGS_API_KEY: " ek ",
    });
    expect(cfg.embedBaseURL).toBe("http://emb.local/v1");
    expect(cfg.embedApiKey).toBe("ek");
  });

  it("provider-key path: blank values stay undefined", () => {
    const cfg = resolveModelConfig({
      OPENAI_API_KEY: "sk",
      MEMBRAL_EMBEDDINGS_BASE_URL: "   ",
      MEMBRAL_EMBEDDINGS_API_KEY: "",
    });
    expect(cfg.embedBaseURL).toBeUndefined();
    expect(cfg.embedApiKey).toBeUndefined();
  });

  it("claude-code path: read from MEMBRAL_EMBEDDINGS_* and trimmed", () => {
    const cfg = resolveModelConfig({
      ...CLAUDE_ENV,
      MEMBRAL_EMBEDDINGS_BASE_URL: " http://emb.local/v1 ",
      MEMBRAL_EMBEDDINGS_API_KEY: " ek ",
    });
    expect(cfg.provider).toBe("claude-code");
    expect(cfg.embedBaseURL).toBe("http://emb.local/v1");
    expect(cfg.embedApiKey).toBe("ek");
  });

  it("claude-code path: unset stays undefined (embeddings off)", () => {
    const cfg = resolveModelConfig(CLAUDE_ENV);
    expect(cfg.embedBaseURL).toBeUndefined();
    expect(cfg.embedApiKey).toBeUndefined();
  });
});
