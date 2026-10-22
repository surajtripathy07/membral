import { describe, expect, it } from "vitest";
import { EMBED_SIM_THRESHOLD } from "@/lib/code-sessions/cross-links";
import { DEFAULT_EMBEDDING_FAMILY } from "@/lib/llm/embedding-client";
import { vectorThreshold } from "@/lib/llm/embedding-family";

describe("content_match threshold", () => {
  it("similarity.ts and cross-links.ts agree for the default family", () => {
    expect(vectorThreshold("content_match", DEFAULT_EMBEDDING_FAMILY)).toBe(EMBED_SIM_THRESHOLD);
  });
});
