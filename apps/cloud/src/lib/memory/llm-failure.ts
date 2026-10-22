// Issue #339: a failed extraction window must be diagnosable from the logs
// alone — a timeout, a rate limit and a provider error need to look different.
// This turns whatever an LLM call threw into a small, content-free description.
//
// NO TRANSCRIPT OR PROMPT TEXT: an error message is kept only when its class is
// known to carry provider- or code-authored text (the OpenAI SDK's API errors,
// the SDK's own timeout/abort/connection messages, this app's cost-cap and
// pricing errors). A provider APIError's message is NOT kept (it can echo the
// request body); only status / code / type are, plus the message for a 429.
// callJson's JSON parse /
// validation failure embeds the model's raw output (which can quote the
// transcript), so it is reduced to a fixed label. Anything unrecognised logs
// its class only.
import { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError } from "openai";
import { CostCapExceededError, OutputTruncatedError, ProviderBodyError, UnpricedModelError } from "@/lib/llm/client";

/** Longest error message a failure log carries. */
export const LLM_FAILURE_MESSAGE_MAX_CHARS = 300;
const CLASS_MAX_CHARS = 64;
const PROVIDER_FIELD_MAX_CHARS = 64;
const CAUSE_CODE_MAX_CHARS = 32;

export interface LlmCallFailure {
  /** Stable class name (instanceof-based, so minification cannot rename it), capped at 64 chars. */
  errorClass: string;
  /** Provider- or code-authored text, truncated; a fixed label when the real message could hold model output. */
  message: string;
  /** Provider HTTP status, when the error carries one (e.g. 429). */
  status?: number;
  /** Provider error `code` (APIError), when a string, capped. */
  code?: string;
  /** Provider error `type` (APIError), when a string, capped. */
  type?: string;
  /** Connection failures: the underlying `cause.code` (ECONNRESET, ENOTFOUND, ...), capped at 32 chars. */
  causeCode?: string;
  /** True for the SDK's request timeout or an aborted request. */
  isTimeout: boolean;
  /** Wall time from the call's start to the throw: total time across callJson's parse retries, not one request. */
  latencyMs: number;
}

function truncate(text: unknown): string {
  return typeof text === "string" ? text.slice(0, LLM_FAILURE_MESSAGE_MAX_CHARS) : "message_omitted";
}

function cap(text: string, max: number): string {
  return text.slice(0, max);
}

function stringField(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value ? cap(value, max) : undefined;
}

function classOf(err: Error): string {
  const name = typeof err.name === "string" && err.name ? err.name : "Error";
  return cap(name, CLASS_MAX_CHARS);
}

function causeCodeOf(err: unknown): string | undefined {
  const cause = (err as { cause?: unknown }).cause;
  if (cause === null || typeof cause !== "object") return undefined;
  return stringField((cause as { code?: unknown }).code, CAUSE_CODE_MAX_CHARS);
}

/** Describes a thrown LLM-call error without any prompt, transcript or model-output text. Never throws. */
export function describeLlmFailure(err: unknown, latencyMs: number): LlmCallFailure {
  const ms = typeof latencyMs === "number" && Number.isFinite(latencyMs) ? Math.max(0, Math.round(latencyMs)) : 0;
  try {
    return describe(err, ms);
  } catch {
    return { errorClass: "unclassifiable", message: "message_omitted", isTimeout: false, latencyMs: ms };
  }
}

function describe(err: unknown, latencyMs: number): LlmCallFailure {
  const base = { latencyMs };
  // Subclasses first: every SDK error below is also an APIError.
  if (err instanceof APIConnectionTimeoutError) {
    return { ...base, errorClass: "APIConnectionTimeoutError", message: truncate(err.message), isTimeout: true };
  }
  if (err instanceof APIUserAbortError) {
    return { ...base, errorClass: "APIUserAbortError", message: truncate(err.message), isTimeout: true };
  }
  if (err instanceof APIConnectionError) {
    const causeCode = causeCodeOf(err);
    return {
      ...base,
      errorClass: "APIConnectionError",
      // The window log line has no cause_code field of its own, so it rides on the message.
      message: causeCode ? `${truncate(err.message)} cause_code=${causeCode}` : truncate(err.message),
      ...(causeCode ? { causeCode } : {}),
      isTimeout: false,
    };
  }
  if (err instanceof APIError) {
    // The SDK builds err.message from the provider's error body, which can echo
    // the request. Only status / code / type are kept; a 429's message is
    // provider-authored rate-limit text and useful, so it stays (truncated).
    const status = typeof err.status === "number" ? err.status : undefined;
    const code = stringField((err as { code?: unknown }).code, PROVIDER_FIELD_MAX_CHARS);
    const type = stringField((err as { type?: unknown }).type, PROVIDER_FIELD_MAX_CHARS);
    return {
      ...base,
      errorClass: status === 429 ? "RateLimitError" : "APIError",
      message: status === 429 ? truncate(err.message) : "provider_error",
      ...(status !== undefined ? { status } : {}),
      ...(code ? { code } : {}),
      ...(type ? { type } : {}),
      isTimeout: false,
    };
  }
  if (err instanceof ProviderBodyError) {
    return {
      ...base,
      errorClass: status429Class(err.status),
      message: "provider_body_error",
      ...(typeof err.status === "number" ? { status: err.status } : {}),
      isTimeout: false,
    };
  }
  // Issue #339: the reply was cut off at the output token limit and nothing
  // could be salvaged from it. Its own class, so it reads apart from malformed
  // JSON and from provider errors. The cut-off text itself is never kept.
  if (err instanceof OutputTruncatedError) {
    return { ...base, errorClass: "OutputTruncated", message: "output_truncated", isTimeout: false };
  }
  if (err instanceof CostCapExceededError) {
    return { ...base, errorClass: "CostCapExceededError", message: truncate(err.message), isTimeout: false };
  }
  if (err instanceof UnpricedModelError) {
    return { ...base, errorClass: "UnpricedModelError", message: truncate(err.message), isTimeout: false };
  }
  if (err instanceof Error) {
    const message = typeof err.message === "string" ? err.message : "";
    // callJson's RetryableJsonError (not exported): its message embeds the raw
    // model output after these code-authored prefixes, so only a label is kept.
    if (message.startsWith("JSON parse/validation failed")) {
      return { ...base, errorClass: "RetryableJsonError", message: "json_parse_failed", isTimeout: false };
    }
    if (message.startsWith("Empty response from")) {
      return { ...base, errorClass: "RetryableJsonError", message: "empty_response", isTimeout: false };
    }
    if (err.name === "AbortError" || err.name === "TimeoutError") {
      return { ...base, errorClass: err.name, message: "message_omitted", isTimeout: true };
    }
    // Unknown provenance (including built-in runtime errors, whose messages can
    // quote the data they choked on): the message is omitted, but a numeric
    // `status` (a wrapped provider error) is only a number and is kept.
    const status = (err as { status?: unknown }).status;
    return {
      ...base,
      errorClass: classOf(err),
      message: "message_omitted",
      ...(typeof status === "number" ? { status } : {}),
      isTimeout: false,
    };
  }
  return { ...base, errorClass: cap(typeof err, CLASS_MAX_CHARS), message: "message_omitted", isTimeout: false };
}

/**
 * Issue #339: error classes that mean the model's reply itself was unusable in a
 * way a retry cannot change: cut off at the output limit. Waiting does not help,
 * so it is not backed off. An empty or malformed reply (RetryableJsonError) is
 * NOT here: it can be transient provider behaviour, so it keeps the counted,
 * backed-off path.
 */
const CONTENT_FAILURE_CLASSES: ReadonlySet<string> = new Set(["OutputTruncated"]);

/** True when `failure` is a deterministic content failure (see CONTENT_FAILURE_CLASSES). */
export function isContentFailure(failure: LlmCallFailure | undefined): boolean {
  return failure !== undefined && CONTENT_FAILURE_CLASSES.has(failure.errorClass);
}

function status429Class(status: number | undefined): string {
  return status === 429 ? "RateLimitError" : "ProviderBodyError";
}
