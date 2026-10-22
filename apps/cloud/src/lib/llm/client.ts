// Knowledge-graph LLM client (membral-ort.2).
//
// Ported from an earlier (since removed) offline spike client, adapted for production:
// - model/baseURL configurable (GPT-4o-mini default; Ollama 13B+ opt-in)
// - optional Zod validation of JSON responses (parse-don't-validate at the boundary)
// - in-memory cost records + optional persistence hook
// - house backoff (retry.ts) for rate-limit smoothing at corpus scale; SDK maxRetries is 0

import OpenAI, { APIConnectionTimeoutError } from "openai";
import { log } from "../log";
import { CLAUDE_CODE_MODEL_PREFIX, CLAUDE_CODE_PROVIDER, extractJsonText, runClaudeCode } from "./claude-code-provider";
import type { ModelConfig } from "./config";
import { canonicalEmbeddingFamily, embeddingRequestBody, fitEmbedding } from "./embedding-client";
import type { CostRecord, PassName } from "./passes";
import { DEFAULT_MAX_RETRIES, withLlmRetry } from "./retry";

// Pricing per 1M tokens (USD). https://openai.com/api/pricing — update if
// these change.
//
// step2d finding 5 (docs/goals/2026-09-13_memory-v1-build_goal.md; issue
// #151): an unpriced model used to cost $0 here — every money guard built on
// top of it (session budget degrade, cost-cap `overBudget()`, the backfill's
// `--max-usd`, the `llm_spend` ledger itself) then silently read that as
// "free", so setting MEMBRAL_MODEL to anything outside this table let real
// spend through every guard unmetered. `chatCostUsd`/`embedCostUsd` now
// return `null` for an unpriced model instead of `0` — every caller in this
// file (attemptJson, embed, embedMany) fails closed on that, throwing rather
// than silently billing $0. A genuinely free local model (e.g. Ollama) is no
// longer representable as "priced at zero" — if that's wanted again, add it
// to the table with an explicit `{in: 0, out: 0}`/`0` entry, which now reads
// unambiguously as "priced, and the price is zero" rather than "unknown".
const CHAT_PRICING: Record<string, { in: number; out: number }> = {
  "gpt-4o-mini": { in: 0.15, out: 0.6 },
  "gpt-4o": { in: 2.5, out: 10.0 },
  "gpt-4.1-mini": { in: 0.4, out: 1.6 },
  // Open-weight trial (docs/goals memory-v1-build, D3 prompt v6 one-repo
  // trial). https://openrouter.ai/api/v1/models — checked 2026-09-24, no key
  // needed for that listing; routed through MEMBRAL_MODEL_BASE_URL=
  // https://openrouter.ai/api/v1 with an OpenRouter key, not OpenAI's.
  "qwen/qwen3-235b-a22b-2507": { in: 0.0875, out: 0.35 },
  "openai/gpt-oss-120b": { in: 0.15, out: 0.6 },
  // gpt-4o-mini routed through OpenRouter (same list price as direct) — the short-title backfill's --route openrouter.
  "openai/gpt-4o-mini": { in: 0.15, out: 0.6 },
  "google/gemma-4-31b-it": { in: 0.09, out: 0.34 },
  // Stronger-model association eval (D-057); OpenRouter list price, checked 2026-09-27.
  "anthropic/claude-sonnet-5": { in: 2.0, out: 10.0 },
  // Same model via Anthropic's own endpoint (ANTHROPIC_API_KEY default): OpenRouter passes through the list price above.
  "claude-sonnet-5": { in: 2.0, out: 10.0 },
  // Gemini API paid tier, https://ai.google.dev/gemini-api/docs/pricing (fetched 2026-10-03).
  "gemini-2.5-flash": { in: 0.3, out: 2.5 },
  // W7 D7 / D-072: the local-only claude-code provider runs the user's own
  // `claude` CLI on their subscription login. Subscription usage, so $0 here,
  // listed explicitly per alias rather than by prefix. Labels are
  // `claude-code/<MEMBRAL_MODEL>`; "default" = no --model passed.
  "claude-code/default": { in: 0, out: 0 },
  "claude-code/sonnet": { in: 0, out: 0 },
  "claude-code/opus": { in: 0, out: 0 },
  "claude-code/haiku": { in: 0, out: 0 },
};

const EMBED_PRICING: Record<string, number> = {
  "text-embedding-3-small": 0.02,
  "text-embedding-3-large": 0.13,
  // Routed through OpenRouter (OPENROUTER_API_KEY default) — same list price as direct, as for openai/gpt-4o-mini above.
  "openai/text-embedding-3-small": 0.02,
};

/**
 * `null` for an unpriced model — callers must fail closed, never treat that as free (finding 5).
 * Exception (D-072, W7 D4): `opts.selfHosted` (ModelConfig.chatSelfHosted: the chat
 * base URL is this machine, e.g. Ollama, or MEMBRAL_MODEL_FREE=1) prices an
 * unlisted model at $0. Listed models keep their price even then.
 */
export function chatCostUsd(
  model: string,
  tokensIn: number,
  tokensOut: number,
  opts?: { selfHosted?: boolean },
): number | null {
  const p = CHAT_PRICING[model];
  if (!p) return opts?.selfHosted ? 0 : null;
  return (tokensIn * p.in + tokensOut * p.out) / 1_000_000;
}

/**
 * `null` for an unpriced model — callers must fail closed, never treat that as free (finding 5).
 * Exception (D-072): `opts.selfHosted` (the embeddings base URL came from
 * MEMBRAL_EMBEDDINGS_BASE_URL / MEMBRAL_MODEL_BASE_URL, e.g. Ollama) prices an
 * unlisted model at $0. Listed models keep their price even then.
 */
export function embedCostUsd(model: string, tokensIn: number, opts?: { selfHosted?: boolean }): number | null {
  const price = EMBED_PRICING[model];
  if (price === undefined) return opts?.selfHosted ? 0 : null;
  return (tokensIn * price) / 1_000_000;
}

/** Thrown by every `chatCostUsd`/`embedCostUsd` call site in this file when the configured model has no price entry (finding 5) — never silently billed as $0. */
export class UnpricedModelError extends Error {
  constructor(public readonly model: string) {
    super(
      `No pricing entry for model "${model}" — refusing to bill it as $0. Add it to CHAT_PRICING/EMBED_PRICING in kg/llm.ts, or use one of: ${[...Object.keys(CHAT_PRICING), ...Object.keys(EMBED_PRICING)].join(", ")}.`,
    );
    this.name = "UnpricedModelError";
  }
}

/** Narrows a possibly-null cost back to `number`, throwing `UnpricedModelError` on `null` — used AFTER a pre-call pricing check has already made the `null` case unreachable in practice; TypeScript can't see that, so this keeps the type honest without an `as number` cast. */
function requirePriced(costUsd: number | null, model: string): number {
  if (costUsd === null) throw new UnpricedModelError(model);
  return costUsd;
}

// ------------------------------------------------------------------
// Minimal structural surface of the OpenAI client we depend on, so unit
// tests can inject a fake without constructing a real client.
// ------------------------------------------------------------------

export interface ChatCompletionLike {
  /** `finish_reason` is "length" when the reply was cut off at max_tokens (issue #339). */
  choices: Array<{ message: { content: string | null }; finish_reason?: string | null }>;
  usage?: {
    prompt_tokens?: number;
    /**
     * Total billable completion tokens. Per OpenAI's own reasoning-model
     * convention (o1/o3/o5) — which OpenRouter mirrors for gpt-oss, since
     * both are served over the same Chat Completions `usage` shape — this
     * ALREADY includes `completion_tokens_details.reasoning_tokens` as a
     * subset, not on top of it. `chatCostUsd` below bills this number
     * directly as `tokensOut`, so reasoning tokens are billed as output
     * without any separate addition (confirmed against the gpt-oss-120b
     * smoke test, 2026-09-24 — see scratchpad/reports/openweight-prep.md).
     */
    completion_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
  } | null;
}

export interface EmbeddingResponseLike {
  data: Array<{ embedding: number[] }>;
  usage?: { prompt_tokens?: number } | null;
}

export interface OpenAILike {
  chat: {
    completions: {
      create(body: {
        model: string;
        messages: Array<{ role: "system" | "user"; content: string }>;
        response_format?: { type: "json_object" };
        temperature?: number;
        max_tokens?: number;
        /** OpenRouter's unified reasoning param — see `isReasoningModel`/`isGemma4Model`. Ignored by providers that don't support it. */
        reasoning?: { effort: "low" | "medium" | "high" } | { enabled: boolean };
      }): Promise<ChatCompletionLike>;
    };
  };
  embeddings: {
    create(body: {
      model: string;
      input: string | string[];
      dimensions?: number;
      encoding_format?: "float";
    }): Promise<EmbeddingResponseLike>;
  };
}

function adaptOpenAI(client: OpenAI, maxRetries: number): OpenAILike {
  return {
    chat: {
      completions: {
        create: (body) =>
          withLlmRetry(() => client.chat.completions.create(body) as Promise<ChatCompletionLike>, { maxRetries }),
      },
    },
    embeddings: {
      create: (body) =>
        withLlmRetry(() => client.embeddings.create(body) as Promise<EmbeddingResponseLike>, { maxRetries }),
    },
  };
}

// ------------------------------------------------------------------
// Optional persistence hook for forensic/audit logging of every call.
// ------------------------------------------------------------------

export interface ExtractionLogEntry {
  pass: PassName;
  conversationId: string;
  model: string;
  systemPrompt: string | null;
  userPrompt: string;
  rawResponse: string;
  parsedOutput: unknown;
  parseError: string | null;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  latencyMs: number;
  /** 1-based attempt number within callJson's app-level empty/parse retry loop. */
  attempt?: number;
}

/** Max attempts for callJson's app-level retry on empty/parse-fail responses (membral-47k). */
const MAX_JSON_ATTEMPTS = 3;

export interface ExtractionLogger {
  logCall(entry: ExtractionLogEntry): Promise<void> | void;
}

// ------------------------------------------------------------------
// Retry classification
// ------------------------------------------------------------------

/**
 * Marks an empty-content or JSON-parse/schema failure as eligible for
 * callJson's app-level retry loop. Any other error (network/SDK, already
 * retried by withLlmRetry in retry.ts) is NOT wrapped and propagates
 * immediately — never double-retried at this layer.
 *
 * `costUsd` (round-5 fix, #98 MEDIUM 1): THIS attempt's own billed cost —
 * `attemptJson` already called `record()` (and so billed the attempt) before
 * throwing, for both the empty-response and parse-failure paths. Carrying it on
 * the error is what lets `callJson`'s retry loop accumulate a call's TOTAL cost
 * without ever reading the shared `LlmClient.totalCostUsd` counter.
 */
/**
 * Issue #339: a provider error delivered inside a 200 body (`{error: {code: 429}}`, no
 * `choices`). Carries only the numeric code — never the provider's message text.
 */
export class ProviderBodyError extends Error {
  readonly status: number | undefined;
  constructor(status: number | undefined) {
    super("provider_body_error");
    this.name = "ProviderBodyError";
    this.status = status;
  }
}

/** Longest `finish_reason` the llm_call log line carries (a short provider-authored enum). */
const FINISH_REASON_MAX_CHARS = 32;

/**
 * Issue #339: the reply was cut off at the output token limit (finish_reason
 * "length") and did not parse as a whole. NOT a RetryableJsonError: resending
 * the identical prompt is cut off the same way, so callJson never retries it.
 *
 * `rawText` is the cut-off reply, for a caller that can salvage the complete
 * part of it. It is non-enumerable and never in `message`, so serializing or
 * logging the error cannot carry model output (which can quote the transcript).
 */
export class OutputTruncatedError extends Error {
  declare readonly rawText: string;
  constructor(
    rawText: string,
    public readonly costUsd: number,
    public readonly tokensOut: number,
  ) {
    super("output_truncated");
    this.name = "OutputTruncatedError";
    Object.defineProperty(this, "rawText", { value: rawText, enumerable: false });
  }
}

class RetryableJsonError extends Error {
  constructor(
    message: string,
    public readonly costUsd: number,
  ) {
    super(message);
  }
}

/**
 * Attaches the running per-call cost total to any error `callJson` is about to
 * propagate (round-5 fix, #98 MEDIUM 1) — a final exhausted-attempts throw, a
 * `CostCapExceededError` from `checkBudget`, or a raw network/SDK error. Silent
 * no-op for a non-object throw (`throw null` / `throw "x"` — legal JS); the
 * error just carries no cost info then, exactly like today.
 */
function attachCallCost(err: unknown, callCostUsd: number): void {
  if (err && typeof err === "object") {
    (err as { callCostUsd?: number }).callCostUsd = callCostUsd;
  }
}

/**
 * Reads the `callCostUsd` a failed `callJson` call attached to its thrown error
 * (round-5 fix, #98 MEDIUM 1) — the TOTAL cost billed across every attempt that
 * one logical call made before giving up, accumulated locally inside `callJson`
 * itself rather than measured as a before/after delta of the shared
 * `LlmClient.totalCostUsd` counter. That delta pattern is unsafe under
 * concurrency (`runPass1`'s worker pool runs several conversations' `callJson`
 * calls concurrently on ONE `LlmClient`): another in-flight call's `record()`
 * can land between this call's own `await`s, so a before/after read of the
 * shared counter can attribute — even double-count — a DIFFERENT call's spend.
 * Defaults to 0 for anything that isn't a `callJson` failure (e.g. a caught
 * value that was never thrown by this module).
 */
export function getCallCostUsd(err: unknown): number {
  if (err && typeof err === "object" && "callCostUsd" in err) {
    const v = (err as { callCostUsd?: unknown }).callCostUsd;
    if (typeof v === "number") return v;
  }
  return 0;
}

/**
 * True for chat models that need different Chat Completions params than a
 * standard OpenAI model — no `temperature` (some reasoning APIs reject a
 * non-default value), and a capped `reasoning.effort` so hidden reasoning
 * tokens don't exhaust `max_tokens` before the JSON body is written.
 * Mirrors the SAME failure mode `scripts/kg/prompt-lab/run.ts`'s
 * `isReasoningModel`/`makeAdaptiveClient` found and fixed for
 * `moonshotai/kimi-k2.6` on OpenRouter (2026-08-27) — that lab-only wrapper
 * exists BECAUSE production's `LlmClient` (this file) had no such handling.
 * Scoped to gpt-oss here: the one reasoning-family model this client is
 * wired to call today (open-weight trial, 2026-09-24). qwen3-235b is NOT a
 * reasoning model and is unaffected.
 */
function isReasoningModel(model: string): boolean {
  return /(^|\/)gpt-oss(-|$)/.test(model);
}

/**
 * True for gemma-4 models on OpenRouter, which support optional reasoning
 * that defaults off. Pinned explicitly (`reasoning: { enabled: false }`)
 * rather than relying on that default, alongside `temperature`.
 */
function isGemma4Model(model: string): boolean {
  return model.startsWith("google/gemma-4");
}

/**
 * Thrown BEFORE a chat/embed call is issued once the client's running total
 * (totalCostUsd) has reached its capUsd (GitHub issue #21). Deliberately NOT a
 * RetryableJsonError — callJson's app-level retry loop must never retry a cap
 * breach. Callers (runPass1, runStageB, code-sessions summarize/rollup) must
 * special-case this type: it means "stop issuing calls, leave remaining work
 * pending/resumable," never "this item failed."
 */
export class CostCapExceededError extends Error {
  constructor(
    public readonly pass: PassName,
    public readonly totalCostUsd: number,
    public readonly capUsd: number,
  ) {
    super(`KG cost cap exceeded before ${pass}: $${totalCostUsd.toFixed(4)} >= cap $${capUsd.toFixed(4)}`);
    this.name = "CostCapExceededError";
  }
}

// ------------------------------------------------------------------
// LlmClient
// ------------------------------------------------------------------

/** One chat reply, before parsing and billing. */
interface ChatTurn {
  content: string;
  tokensIn: number;
  tokensOut: number;
  finishReason: string | null;
  /** Label to record instead of the priced request model (claude-code: `claude-code/<model the CLI used>`). Cost still comes from the request model's price. */
  recordModel?: string;
}

/** Fires once per billable call, AFTER record() accounts it. Never awaited by record() — see LlmClient.record. */
export type OnSpendCallback = (record: CostRecord) => void;

export class LlmClient {
  private readonly client: OpenAILike;
  /**
   * Embeddings-only client (open-weight trial, 2026-09-24). Defaults to the
   * SAME instance as `client` — preserving today's behavior of embeddings
   * riding the chat client's base URL/key — unless `config.embedBaseURL`/
   * `embedApiKey` are set to something different (see ModelConfig's doc
   * comments), or a test injects `opts.client` (always shared, matching
   * every existing llm.ts/tail-capture test's single-mock expectation).
   */
  private readonly embedClient: OpenAILike;
  private readonly config: ModelConfig;
  private readonly logger: ExtractionLogger | null;
  /** Per-run hard cap (issue #21). undefined = no cap (e.g. one-off scripts/tests not wired to a budget). */
  private readonly capUsd: number | undefined;
  /** Optional spend-ledger sink (spend-ledger.ts). Fire-and-forget: never awaited, never allowed to throw out. */
  private readonly onSpend: OnSpendCallback | null;

  public records: CostRecord[] = [];
  /** Seeded from opts.seedCostUsd (default 0) — lets a phase-split second client carry forward a prior client's spend so the per-run cap isn't reset (bootstrap Phase 1 -> Phase 2). */
  public totalCostUsd = 0;
  public totalCalls = 0;

  // Health counters rolled up into kg_run_metrics (issue #62). Cumulative over
  // this client's lifetime, across every callJson attempt:
  //  - parseFailCount:     attempts whose response failed JSON.parse / schema
  //  - emptyResponseCount: attempts that returned empty content
  //  - retryCount:         app-level re-attempts triggered by the two above
  //    (i.e. how many times callJson looped again, not counting the first try)
  public parseFailCount = 0;
  public emptyResponseCount = 0;
  public retryCount = 0;

  constructor(
    config: ModelConfig,
    opts?: {
      client?: OpenAILike;
      logger?: ExtractionLogger;
      /** Per-run hard cap in USD (issue #21). Omit for no cap. */
      capUsd?: number;
      /** Carry-in from a prior client covering the same logical run (e.g. bootstrap Phase 1's client), so capUsd isn't re-armed at 0 for Phase 2. Default 0. */
      seedCostUsd?: number;
      /** Spend-ledger sink — see spend-ledger.ts's createSpendLedger(). */
      onSpend?: OnSpendCallback;
      /** Per-request timeout for the built-in OpenAI client (ms). Default: the SDK's (10 min). Memory extraction passes 60s (P10 re-review N2). */
      timeoutMs?: number;
      /** Retries by the house backoff (retry.ts; 429/5xx/connection, honors Retry-After). The SDK itself gets maxRetries 0. Default 5. */
      maxRetries?: number;
      /** Embedding client only: timeout (ms) and SDK retries, when they should differ from the chat client's (P10 round 3 R3-m2). Default: same as chat. */
      embedTimeoutMs?: number;
      embedMaxRetries?: number;
    },
  ) {
    this.config = config;
    this.logger = opts?.logger ?? null;
    this.capUsd = opts?.capUsd;
    this.onSpend = opts?.onSpend ?? null;
    this.totalCostUsd = opts?.seedCostUsd ?? 0;
    // Retries (#170): the SDK is built with maxRetries: 0; withLlmRetry (retry.ts) applies
    // the house backoff to 429/5xx/connection errors, honoring Retry-After.
    const maxRetries = opts?.maxRetries ?? DEFAULT_MAX_RETRIES;
    const timeout = opts?.timeoutMs;
    this.client =
      opts?.client ??
      adaptOpenAI(new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL, maxRetries: 0, timeout }), maxRetries);
    const embedBaseURL = config.embedBaseURL ?? config.baseURL;
    const embedApiKey = config.embedApiKey ?? config.apiKey;
    const embedMaxRetries = opts?.embedMaxRetries ?? maxRetries;
    const embedTimeout = opts?.embedTimeoutMs ?? timeout;
    this.embedClient =
      opts?.client ??
      (embedBaseURL === config.baseURL &&
      embedApiKey === config.apiKey &&
      embedMaxRetries === maxRetries &&
      embedTimeout === timeout
        ? this.client
        : adaptOpenAI(
            new OpenAI({
              apiKey: embedApiKey,
              baseURL: embedBaseURL,
              maxRetries: 0,
              timeout: embedTimeout,
            }),
            embedMaxRetries,
          ));
  }

  get modelName(): string {
    return this.config.model;
  }

  /** True when chat runs on the local-only claude-code provider (W7 D7 / D-072). */
  get isClaudeCodeProvider(): boolean {
    return this.config.provider === CLAUDE_CODE_PROVIDER;
  }

  /** ModelConfig.chatSelfHosted: unlisted chat models cost $0 (pass to chatCostUsd and the cost estimates). */
  get chatSelfHosted(): boolean {
    return this.config.chatSelfHosted === true;
  }

  /** True once totalCostUsd has reached capUsd. Always false when no cap is configured. */
  overBudget(): boolean {
    return this.capUsd !== undefined && this.totalCostUsd >= this.capUsd;
  }

  /** USD headroom left under the cap. +Infinity when no cap is configured. */
  remainingUsd(): number {
    if (this.capUsd === undefined) return Number.POSITIVE_INFINITY;
    return Math.max(0, this.capUsd - this.totalCostUsd);
  }

  /** Throws CostCapExceededError if already over budget. Called BEFORE every chat/embed network call. */
  private checkBudget(pass: PassName): void {
    if (this.overBudget()) {
      throw new CostCapExceededError(pass, this.totalCostUsd, this.capUsd as number);
    }
  }

  /**
   * Call the chat model expecting a JSON object back. Parses (and optionally
   * Zod-validates) the response. Throws on empty response, invalid JSON, or
   * schema-validation failure — always logging the raw response first.
   *
   * `callCostUsd` (round-5 fix, #98 MEDIUM 1) on the success return: the TOTAL
   * cost billed across every attempt THIS call made — including any earlier
   * attempt that failed empty/parse and looped, not just the attempt that
   * finally succeeded. On failure, the same total is attached to whatever error
   * propagates (`getCallCostUsd()` above reads it back off the catch). Neither
   * path ever reads `this.totalCostUsd` — see `getCallCostUsd`'s doc for why a
   * shared-counter delta is unsafe here.
   */
  async callJson<T>(opts: {
    systemPrompt: string;
    userPrompt: string;
    pass: PassName;
    conversationId: string;
    /** Optional boundary validator (e.g. a Zod schema); throws on invalid shape. */
    schema?: { parse: (data: unknown) => T };
    model?: string;
    maxTokens?: number;
    temperature?: number;
  }): Promise<{ data: T; record: CostRecord; callCostUsd: number }> {
    let lastError: Error = new Error(`callJson: no attempts made for ${opts.pass}`);
    let callCostUsd = 0;
    for (let attempt = 1; attempt <= MAX_JSON_ATTEMPTS; attempt++) {
      try {
        const { data, record } = await this.attemptJson<T>(opts, attempt);
        callCostUsd += record.cost_usd;
        return { data, record, callCostUsd };
      } catch (e) {
        // Issue #339: a cut-off reply billed this attempt but is never retried.
        if (e instanceof OutputTruncatedError) callCostUsd += e.costUsd;
        if (e instanceof RetryableJsonError) {
          callCostUsd += e.costUsd;
          lastError = e;
          // A retryable failure occurred; if another attempt follows, it's a retry.
          if (attempt < MAX_JSON_ATTEMPTS) this.retryCount++;
          continue;
        }
        // Network/SDK errors (already retried by withLlmRetry in retry.ts) and
        // CostCapExceededError (from checkBudget, below) are NOT app-level-
        // retryable — rethrow immediately, no double-retry. Attach whatever this
        // call already billed across any EARLIER attempts before it propagates.
        attachCallCost(e, callCostUsd);
        throw e;
      }
    }
    attachCallCost(lastError, callCostUsd);
    throw lastError;
  }

  /**
   * One request+parse attempt. Throws RetryableJsonError on empty/parse-fail;
   * OutputTruncatedError when that reply was cut off at max_tokens (issue
   * #339); any other throw is non-retryable.
   */
  private async attemptJson<T>(
    opts: {
      systemPrompt: string;
      userPrompt: string;
      pass: PassName;
      conversationId: string;
      schema?: { parse: (data: unknown) => T };
      model?: string;
      maxTokens?: number;
      temperature?: number;
    },
    attempt: number,
  ): Promise<{ data: T; record: CostRecord }> {
    this.checkBudget(opts.pass);
    const model = opts.model ?? this.config.model;
    // step2d finding 5: fail BEFORE issuing the call, not after paying for a
    // response we'd then refuse to price.
    const priceOpts = { selfHosted: this.chatSelfHosted };
    if (chatCostUsd(model, 0, 0, priceOpts) === null) throw new UnpricedModelError(model);
    const t0 = Date.now();
    const { content, tokensIn, tokensOut, finishReason, recordModel } =
      this.config.provider === CLAUDE_CODE_PROVIDER
        ? await this.chatViaClaudeCode(model, opts)
        : await this.chatViaOpenAI(model, opts);
    const latencyMs = Date.now() - t0;
    const costUsd = requirePriced(chatCostUsd(model, tokensIn, tokensOut, priceOpts), model);
    const cutOff = finishReason === "length";
    const recordedModel = recordModel ?? model;

    if (!content) {
      await this.log({
        pass: opts.pass,
        conversationId: opts.conversationId,
        model: recordedModel,
        systemPrompt: opts.systemPrompt,
        userPrompt: opts.userPrompt,
        rawResponse: "",
        parsedOutput: null,
        parseError: "empty_response",
        tokensIn,
        tokensOut,
        costUsd,
        latencyMs,
        attempt,
      });
      // Record cost on the empty path too — a billable attempt regardless of outcome.
      this.record(opts.conversationId, opts.pass, recordedModel, tokensIn, tokensOut, costUsd, latencyMs, finishReason);
      this.emptyResponseCount++;
      if (cutOff) throw new OutputTruncatedError("", costUsd, tokensOut);
      throw new RetryableJsonError(`Empty response from ${model} on ${opts.pass}`, costUsd);
    }

    let parsed: unknown = null;
    let parseError: string | null = null;
    try {
      parsed = JSON.parse(content);
      if (opts.schema) parsed = opts.schema.parse(parsed);
    } catch (e) {
      parseError = (e as Error).message;
    }

    await this.log({
      pass: opts.pass,
      conversationId: opts.conversationId,
      model: recordedModel,
      systemPrompt: opts.systemPrompt,
      userPrompt: opts.userPrompt,
      rawResponse: content,
      parsedOutput: parseError ? null : parsed,
      parseError,
      tokensIn,
      tokensOut,
      costUsd,
      latencyMs,
      attempt,
    });

    const record = this.record(
      opts.conversationId,
      opts.pass,
      recordedModel,
      tokensIn,
      tokensOut,
      costUsd,
      latencyMs,
      finishReason,
    );

    if (parseError) {
      this.parseFailCount++;
      // A reply cut off at the limit would be cut off again on a resend.
      if (cutOff) throw new OutputTruncatedError(content, costUsd, tokensOut);
      throw new RetryableJsonError(
        `JSON parse/validation failed on ${opts.pass}: ${parseError}\n--- raw ---\n${content.slice(0, 500)}`,
        costUsd,
      );
    }
    return { data: parsed as T, record };
  }

  /** One Chat Completions request over the OpenAI-compatible HTTP path. */
  private async chatViaOpenAI(
    model: string,
    opts: { systemPrompt: string; userPrompt: string; maxTokens?: number; temperature?: number },
  ): Promise<ChatTurn> {
    const reasoning = isReasoningModel(model);
    const gemma4 = isGemma4Model(model);
    const response = await this.client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: opts.systemPrompt },
        { role: "user", content: opts.userPrompt },
      ],
      response_format: { type: "json_object" },
      max_tokens: opts.maxTokens ?? 1500,
      // Reasoning models: no `temperature` (see isReasoningModel), and a low
      // reasoning effort so hidden reasoning content doesn't eat the whole
      // max_tokens budget before the JSON body is written. gemma-4: reasoning
      // is optional and defaults off, but pinned explicitly alongside
      // `temperature` rather than relying on that default (see isGemma4Model).
      ...(reasoning
        ? { reasoning: { effort: "low" as const } }
        : { temperature: opts.temperature ?? 0.1, ...(gemma4 ? { reasoning: { enabled: false } } : {}) }),
    });

    // A response with no `choices` array (an error inside a 200 body) used to
    // TypeError at `choices[0]`; it is still a failed call, now a named one.
    if (!Array.isArray((response as { choices?: unknown } | null)?.choices)) {
      const code = (response as { error?: { code?: unknown } } | null)?.error?.code;
      throw new ProviderBodyError(typeof code === "number" ? code : undefined);
    }

    const rawFinish = response.choices[0]?.finish_reason;
    return {
      content: response.choices[0]?.message?.content ?? "",
      tokensIn: response.usage?.prompt_tokens ?? 0,
      tokensOut: response.usage?.completion_tokens ?? 0,
      finishReason: typeof rawFinish === "string" ? rawFinish.slice(0, FINISH_REASON_MAX_CHARS) : null,
    };
  }

  /**
   * W7 D7 / D-072: one turn of the local `claude` CLI (claude-code-provider.ts).
   * A usage/rate limit throws the same error an HTTP 429 in a 200 body does
   * (ProviderBodyError 429), so callers' rule-4 backoff applies unchanged; a
   * timeout throws the SDK's timeout error; a refusal (hosted, not local, no
   * token) or a CLI failure throws a non-retryable error. The result text goes
   * through the normal empty/parse/Zod path below.
   */
  private async chatViaClaudeCode(
    model: string,
    opts: { systemPrompt: string; userPrompt: string },
  ): Promise<ChatTurn> {
    // Only claude-code/<alias> labels are priced for this path; a per-call override to another model is refused.
    if (!model.startsWith(CLAUDE_CODE_MODEL_PREFIX)) throw new UnpricedModelError(model);
    const r = await runClaudeCode({ systemPrompt: opts.systemPrompt, userPrompt: opts.userPrompt, model });
    switch (r.kind) {
      case "ok":
        return {
          content: extractJsonText(r.text),
          tokensIn: r.tokensIn,
          tokensOut: r.tokensOut,
          finishReason: null,
          ...(r.actualModel ? { recordModel: `${CLAUDE_CODE_MODEL_PREFIX}${r.actualModel}` } : {}),
        };
      case "auth_failed":
        // Not retried: callJson only loops on empty/parse failures.
        throw new Error("claude-code provider: token rejected or missing — run `claude setup-token`");
      case "rate_limited":
        throw new ProviderBodyError(429);
      case "timeout":
        throw new APIConnectionTimeoutError({ message: `claude CLI timed out after ${r.timeoutMs}ms` });
      case "refused":
        throw new Error(r.reason);
      case "error":
        throw new ProviderBodyError(undefined);
    }
  }

  /** Generate an embedding vector for a piece of text. Empty text => zero vector. */
  async embed(opts: {
    text: string;
    pass: PassName;
    conversationId: string;
  }): Promise<{ vector: number[]; record: CostRecord }> {
    const t0 = Date.now();
    this.refuseEmbeddingsWithoutConfig();
    const text = opts.text.trim();
    if (!text) {
      const record = this.record(opts.conversationId, opts.pass, this.config.embedModel, 0, 0, 0, 0);
      return { vector: new Array(this.config.embedDimensions).fill(0), record };
    }
    this.checkBudget(opts.pass);
    // step2d finding 5: fail BEFORE issuing the call, not after paying for a
    // response we'd then refuse to price.
    if (this.embedCost(0) === null) throw new UnpricedModelError(this.config.embedModel);
    const response = await this.embedClient.embeddings.create(this.embedBody(text));
    const latencyMs = Date.now() - t0;
    const tokensIn = response.usage?.prompt_tokens ?? 0;
    const costUsd = requirePriced(this.embedCost(tokensIn), this.config.embedModel);
    const got = response.data[0]?.embedding;
    const vector = got ? fitEmbedding(got, this.config.embedModel) : new Array(this.config.embedDimensions).fill(0);
    const record = this.record(opts.conversationId, opts.pass, this.config.embedModel, tokensIn, 0, costUsd, latencyMs);
    return { vector, record };
  }

  /**
   * Embed a batch of texts in ONE API call (OpenAI accepts an array input up to
   * 2048). Vectors are returned aligned to `texts` by position. Callers MUST
   * pass only non-empty strings — OpenAI rejects empty entries in a batch.
   */
  async embedMany(opts: {
    texts: string[];
    pass: PassName;
    conversationId: string;
  }): Promise<{ vectors: number[][]; record: CostRecord }> {
    const t0 = Date.now();
    this.refuseEmbeddingsWithoutConfig();
    const zero = (): number[] => new Array(this.config.embedDimensions).fill(0);
    if (opts.texts.length === 0) {
      const record = this.record(opts.conversationId, opts.pass, this.config.embedModel, 0, 0, 0, 0);
      return { vectors: [], record };
    }
    this.checkBudget(opts.pass);
    // step2d finding 5: fail BEFORE issuing the call, not after paying for a
    // response we'd then refuse to price.
    if (this.embedCost(0) === null) throw new UnpricedModelError(this.config.embedModel);
    const response = await this.embedClient.embeddings.create(this.embedBody(opts.texts));
    const latencyMs = Date.now() - t0;
    const tokensIn = response.usage?.prompt_tokens ?? 0;
    const costUsd = requirePriced(this.embedCost(tokensIn), this.config.embedModel);
    // OpenAI returns data in input order; align by position. Narrower vectors (a local model) are zero-padded.
    const vectors = opts.texts.map((_, i) => {
      const got = response.data[i]?.embedding;
      return got ? fitEmbedding(got, this.config.embedModel) : zero();
    });
    const record = this.record(opts.conversationId, opts.pass, this.config.embedModel, tokensIn, 0, costUsd, latencyMs);
    return { vectors, record };
  }

  /** The embedding family this client writes (provider prefix stripped) — D-072. */
  get embedFamily(): string {
    return canonicalEmbeddingFamily(this.config.embedModel);
  }

  /** embeddingRequestBody: `dimensions` for models that accept it; others ask for floats and are zero-padded after the call. */
  private embedBody(input: string | string[]): ReturnType<typeof embeddingRequestBody> {
    return embeddingRequestBody(this.config.embedModel, input);
  }

  private embedCost(tokensIn: number): number | null {
    return embedCostUsd(this.config.embedModel, tokensIn, { selfHosted: this.config.embedSelfHosted === true });
  }

  /**
   * claude-code serves chat only. With no MEMBRAL_EMBEDDINGS_BASE_URL its
   * placeholder key would reach api.openai.com, so embeddings stay off.
   */
  private refuseEmbeddingsWithoutConfig(): void {
    if (this.config.provider === CLAUDE_CODE_PROVIDER && !this.config.embedBaseURL) {
      throw new Error(
        "Embeddings are off: MEMBRAL_LLM_PROVIDER=claude-code serves chat only; set MEMBRAL_EMBEDDINGS_BASE_URL for embeddings.",
      );
    }
  }

  private record(
    conversationId: string,
    pass: PassName,
    model: string,
    tokensIn: number,
    tokensOut: number,
    costUsd: number,
    latencyMs: number,
    finishReason: string | null = null,
  ): CostRecord {
    const rec: CostRecord = {
      conversation_id: conversationId,
      pass,
      model,
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      cost_usd: costUsd,
      latency_ms: latencyMs,
    };
    this.records.push(rec);
    this.totalCostUsd += costUsd;
    this.totalCalls++;
    // One structured cost line per billable call. record() is the single choke
    // point every chat/embed path funnels through exactly once, so this can't
    // double-count against totalCostUsd (issue #72).
    log.info("llm_call", {
      event: "llm_call",
      model,
      pass,
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      cost_usd: costUsd,
      latency_ms: latencyMs,
      // Issue #339: "length" means the reply was cut off at max_tokens. Null for embeddings.
      finish_reason: finishReason,
    });
    // Fire-and-forget spend-ledger sink (issue #21). Never awaited here — the
    // ledger itself buffers/flushes asynchronously and swallows its own
    // failures (see spend-ledger.ts); a logging problem must never crash or
    // stall extraction.
    if (this.onSpend) {
      try {
        this.onSpend(rec);
      } catch (e) {
        log.warn("llm onSpend callback threw", { pass, err: (e as Error).message });
      }
    }
    return rec;
  }

  private async log(entry: ExtractionLogEntry): Promise<void> {
    if (!this.logger) return;
    try {
      await this.logger.logCall(entry);
    } catch (e) {
      // Logging is auxiliary — never break extraction because auditing failed.
      log.warn("extraction log failed", {
        pass: entry.pass,
        conversation_id: entry.conversationId,
        err: (e as Error).message,
      });
    }
  }
}

/** Human-readable per-pass cost rollup for progress reporting. */
export function summarizeCost(records: CostRecord[]): string {
  const byPass: Record<string, { calls: number; in: number; out: number; cost: number; latency: number }> = {};
  let totalCost = 0;
  for (const r of records) {
    byPass[r.pass] ??= { calls: 0, in: 0, out: 0, cost: 0, latency: 0 };
    const b = byPass[r.pass];
    b.calls++;
    b.in += r.tokens_in;
    b.out += r.tokens_out;
    b.cost += r.cost_usd;
    b.latency += r.latency_ms;
    totalCost += r.cost_usd;
  }
  const lines = [`Total calls: ${records.length}`, `Total cost: $${totalCost.toFixed(4)}`];
  for (const [pass, b] of Object.entries(byPass)) {
    const avg = b.calls > 0 ? Math.round(b.latency / b.calls) : 0;
    lines.push(
      `  ${pass}: calls=${b.calls} tokens_in=${b.in} tokens_out=${b.out} cost=$${b.cost.toFixed(4)} avg_latency=${avg}ms`,
    );
  }
  return lines.join("\n");
}
