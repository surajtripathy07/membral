import { describe, expect, it } from "vitest";
import { localLlmStatus } from "../llm-status";

const CC = {
  MEMBRAL_LLM_PROVIDER: "claude-code",
  MEMBRAL_LOCAL: "1",
  CLAUDE_CODE_OAUTH_TOKEN: "tok-secret",
  OPENAI_API_KEY: "sk-test",
};

describe("localLlmStatus embeddings", () => {
  it("claude-code without MEMBRAL_EMBEDDINGS_BASE_URL: embeddings off, chat on", () => {
    const s = localLlmStatus(CC);
    expect(s.provider).toBe("claude-code");
    expect(s.extraction).toBe("on");
    expect(s.embeddings).toEqual({ configured: false, model: null });
  });

  it("claude-code with MEMBRAL_EMBEDDINGS_BASE_URL and a key: embeddings on", () => {
    const s = localLlmStatus({
      ...CC,
      MEMBRAL_EMBEDDINGS_BASE_URL: "http://localhost:11434/v1",
      MEMBRAL_EMBEDDINGS_API_KEY: "k",
    });
    expect(s.embeddings.configured).toBe(true);
    expect(s.embeddings.model).toBeTruthy();
  });

  it("API-key mode: embeddings follow the resolved key as before", () => {
    const s = localLlmStatus({ OPENAI_API_KEY: "sk-test" });
    expect(s.provider).toBe("openai");
    expect(s.embeddings.configured).toBe(true);
  });
});

describe("localLlmStatus with Claude Code unavailable", () => {
  it("the entrypoint's download-failed marker turns extraction off and says why", () => {
    const s = localLlmStatus({ ...CC, OPENAI_API_KEY: undefined, MEMBRAL_CLAUDE_UNAVAILABLE: "1" });
    expect(s.configured).toBe(false);
    expect(s.extraction).toBe("off");
    expect(s.reason).toContain("Claude Code could not be downloaded from npm");
    expect(JSON.stringify(s)).not.toContain("tok-secret");
  });

  it("a missing token is the reason when there is no token", () => {
    const s = localLlmStatus({ MEMBRAL_LLM_PROVIDER: "claude-code", MEMBRAL_LOCAL: "1" });
    expect(s.extraction).toBe("off");
    expect(s.reason).toContain("CLAUDE_CODE_OAUTH_TOKEN");
  });

  it("no reason field when extraction is on, or for other providers", () => {
    expect(localLlmStatus(CC)).not.toHaveProperty("reason");
    expect(localLlmStatus({})).not.toHaveProperty("reason");
  });
});
