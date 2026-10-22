import { describe, expect, it, vi } from "vitest";
import { callEmbeddingsCreate, EMBEDDING_DIMENSIONS, padEmbedding } from "../embedding-client";

// Issue #188 / R5 5.11: the unknown-model classifier (isUnknownModelError) and
// padEmbedding's exact-width branch.

const config = {
  model: "text-embedding-3-small",
  baseURL: "https://router.example/v1",
  apiKey: "k",
  dimensions: 1536 as const,
};
const OK = { data: [{ embedding: [0.5] }], usage: { prompt_tokens: 1 } };

function statused(message: string, status: number | undefined, code?: string) {
  return Object.assign(new Error(message), { status, code });
}

/** Rejects once with `err`, then succeeds; reports whether the openai/ retry happened. */
async function retried(err: unknown): Promise<boolean> {
  const create = vi.fn().mockRejectedValueOnce(err).mockResolvedValueOnce(OK);
  try {
    const r = await callEmbeddingsCreate(create, config, "t");
    expect(r.usedModel).toBe("openai/text-embedding-3-small");
    return true;
  } catch (e) {
    expect(e).toBe(err);
    expect(create).toHaveBeenCalledTimes(1);
    return false;
  }
}

describe("padEmbedding", () => {
  it("returns an exactly full-width vector as the same array, unpadded", () => {
    const v = new Array<number>(EMBEDDING_DIMENSIONS).fill(0.25);
    expect(padEmbedding(v)).toBe(v);
  });
});

describe("unknown-model classification gates the openai/ retry", () => {
  it("a non-Error rejection is rethrown untouched", async () => {
    expect(await retried("plain string failure")).toBe(false);
  });

  it("the SDK code model_not_found retries whatever the status or message", async () => {
    expect(await retried(statused("nope", 500, "model_not_found"))).toBe(true);
  });

  it("a status other than 400/404 never retries, even if the message names the model", async () => {
    expect(await retried(statused("model not found", 500))).toBe(false);
  });

  it("a 400 whose message does not mention the model never retries", async () => {
    expect(await retried(statused("input is invalid", 400))).toBe(false);
  });

  it.each([
    ["not found", "model gizmo not found"],
    ["not_found", "model_gizmo not_found"],
    ["does not exist", "The model gizmo does not exist"],
    ["invalid", "model gizmo is invalid"],
    ["unknown", "unknown model gizmo"],
    ["no endpoints", "model gizmo: no endpoints available"],
  ])("a 404 saying '%s' about the model retries once", async (_label, message) => {
    expect(await retried(statused(message, 404))).toBe(true);
  });

  it("a 400 mentioning the model but none of the known phrases does not retry", async () => {
    expect(await retried(statused("model is overloaded, try later", 400))).toBe(false);
  });
});
