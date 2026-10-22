// Issue #339: describeLlmFailure tells a timeout from a rate limit from a
// provider error, and never carries model output or prompt text.
import { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError } from "openai";
import { describe, expect, it } from "vitest";
import { CostCapExceededError, OutputTruncatedError, ProviderBodyError } from "@/lib/llm/client";
import { describeLlmFailure, isContentFailure, LLM_FAILURE_MESSAGE_MAX_CHARS } from "../llm-failure";

const SENTINEL = "SENTINEL-TRANSCRIPT-7f3c";

describe("describeLlmFailure", () => {
  it("a request timeout is is_timeout with no status", () => {
    const f = describeLlmFailure(new APIConnectionTimeoutError(), 60_000);
    expect(f).toMatchObject({ errorClass: "APIConnectionTimeoutError", isTimeout: true, latencyMs: 60_000 });
    expect(f.status).toBeUndefined();
  });

  it("an aborted request counts as a timeout", () => {
    expect(describeLlmFailure(new APIUserAbortError(), 5)).toMatchObject({ isTimeout: true });
  });

  it("a 429 carries status 429 and the provider's message, truncated", () => {
    const err = APIError.generate(429, { error: { message: "x".repeat(1000) } }, undefined, new Headers());
    const f = describeLlmFailure(err, 12);
    expect(f).toMatchObject({ errorClass: "RateLimitError", status: 429, isTimeout: false });
    expect(f.message.length).toBeLessThanOrEqual(LLM_FAILURE_MESSAGE_MAX_CHARS);
  });

  it("a 5xx is an APIError with its status", () => {
    const err = APIError.generate(503, { error: { message: "upstream unavailable" } }, undefined, new Headers());
    expect(describeLlmFailure(err, 1)).toMatchObject({ errorClass: "APIError", status: 503, isTimeout: false });
  });

  it("a parse failure (whose message embeds model output) keeps only a label", () => {
    const err = new Error(`JSON parse/validation failed on memory_backfill: bad\n--- raw ---\n${SENTINEL}`);
    const f = describeLlmFailure(err, 1);
    expect(f).toEqual({
      errorClass: "RetryableJsonError",
      message: "json_parse_failed",
      isTimeout: false,
      latencyMs: 1,
    });
  });

  it("an unrecognised error keeps its class and a numeric status, never its message", () => {
    const err = Object.assign(new Error(`wrapped ${SENTINEL}`), { status: 429 });
    const f = describeLlmFailure(err, 1);
    expect(f).toMatchObject({ errorClass: "Error", status: 429, message: "message_omitted" });
    expect(JSON.stringify(f)).not.toContain(SENTINEL);
  });

  it("the app's own cost-cap error keeps its code-authored message", () => {
    const f = describeLlmFailure(new CostCapExceededError("memory_backfill", 1, 0.5), 1);
    expect(f.errorClass).toBe("CostCapExceededError");
    expect(f.message.length).toBeGreaterThan(0);
  });

  it("a non-Error throw never throws", () => {
    expect(describeLlmFailure("boom", 1)).toMatchObject({ errorClass: "string", message: "message_omitted" });
  });

  it("a provider APIError body echoing a marker is not logged; status, code and type are", () => {
    const err = APIError.generate(
      400,
      { error: { message: `bad request ${SENTINEL}`, code: "context_length_exceeded", type: "invalid_request_error" } },
      undefined,
      new Headers(),
    );
    const f = describeLlmFailure(err, 1);
    expect(f).toMatchObject({
      errorClass: "APIError",
      status: 400,
      code: "context_length_exceeded",
      type: "invalid_request_error",
      message: "provider_error",
    });
    expect(JSON.stringify(f)).not.toContain(SENTINEL);
  });

  it("caps the error class at 64 chars and reports a unknown runtime error without its message", () => {
    const long = Object.assign(new Error("x"), { name: "N".repeat(200) });
    expect(describeLlmFailure(long, 1).errorClass).toHaveLength(64);
    const f = describeLlmFailure(new TypeError(`cannot read ${SENTINEL}`), 1);
    expect(f).toMatchObject({ errorClass: "TypeError", message: "message_omitted" });
  });

  it("a connection failure reports the cause code, capped, and never the cause message", () => {
    const err = new APIConnectionError({
      message: "Connection error.",
      cause: Object.assign(new Error(SENTINEL), { code: "ECONNRESET" }),
    });
    const f = describeLlmFailure(err, 1);
    expect(f.causeCode).toBe("ECONNRESET");
    expect(JSON.stringify(f)).not.toContain(SENTINEL);
  });

  it("a body-delivered 429 is status 429", () => {
    expect(describeLlmFailure(new ProviderBodyError(429), 1)).toMatchObject({
      errorClass: "RateLimitError",
      status: 429,
    });
    expect(describeLlmFailure(new ProviderBodyError(undefined), 1).status).toBeUndefined();
  });

  it("never throws: non-string message, hostile getters, non-Error values", () => {
    const badMessage = Object.assign(new Error("x"), { message: 42 as unknown as string });
    expect(() => describeLlmFailure(badMessage, 1)).not.toThrow();
    const hostile = new Error("x");
    Object.defineProperty(hostile, "name", {
      get() {
        throw new Error("boom");
      },
    });
    expect(describeLlmFailure(hostile, 1)).toMatchObject({
      errorClass: "unclassifiable",
      message: "message_omitted",
      isTimeout: false,
    });
    for (const v of [null, undefined, 7, {}, Symbol("s")]) expect(() => describeLlmFailure(v, 1)).not.toThrow();
  });
});

describe("issue #339: a reply cut off at the output limit", () => {
  it("is its own class, not a timeout, and never carries the cut-off text", () => {
    const f = describeLlmFailure(new OutputTruncatedError(`{"records": [{"text": "${SENTINEL}`, 0.01, 2000), 51_000);
    expect(f).toEqual({
      errorClass: "OutputTruncated",
      message: "output_truncated",
      isTimeout: false,
      latencyMs: 51_000,
    });
    expect(JSON.stringify(f)).not.toContain(SENTINEL);
  });

  it("isContentFailure: a cut-off reply only; empty or malformed replies may be transient", () => {
    expect(isContentFailure(describeLlmFailure(new OutputTruncatedError("", 0, 0), 1))).toBe(true);
    expect(isContentFailure(describeLlmFailure(new Error("JSON parse/validation failed on x"), 1))).toBe(false);
    expect(isContentFailure(describeLlmFailure(new Error("Empty response from m on p"), 1))).toBe(false);
    expect(isContentFailure(describeLlmFailure(new ProviderBodyError(429), 1))).toBe(false);
    expect(isContentFailure(describeLlmFailure(new Error("503 upstream"), 1))).toBe(false);
    expect(isContentFailure(undefined)).toBe(false);
  });
});
