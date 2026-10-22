import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { APIConnectionTimeoutError } from "openai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

import { spawn } from "node:child_process";
import { log } from "../../log";
import { describeLlmFailure } from "../../memory/llm-failure";
import {
  buildClaudeArgs,
  CLAUDE_CODE_MAX_OUTPUT_BYTES,
  claudeCodeActivation,
  extractJsonText,
  interpretClaudeOutput,
  runClaudeCode,
} from "../claude-code-provider";
import { LlmClient, ProviderBodyError } from "../client";
import { chatConfigured, resetClaudeCodeRefusalLogForTests, resolveModelConfig } from "../config";

const spawnMock = vi.mocked(spawn);
const TOKEN = "sk-ant-oat-test-token";

const LOCAL_ENV = {
  MEMBRAL_LLM_PROVIDER: "claude-code",
  MEMBRAL_LOCAL: "1",
  CLAUDE_CODE_OAUTH_TOKEN: TOKEN,
};

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: EventEmitter & { end: ReturnType<typeof vi.fn> };
  kill: ReturnType<typeof vi.fn>;
}

/** A fake child that emits `stdout` and closes with `code` once stdin is ended (unless `hang`). */
function fakeChild(opts: { stdout?: string; stderr?: string; code?: number | null; hang?: boolean }): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const stdin = new EventEmitter() as FakeChild["stdin"];
  stdin.end = vi.fn(() => {
    if (opts.hang) return;
    setImmediate(() => {
      if (opts.stdout) child.stdout.emit("data", Buffer.from(opts.stdout));
      if (opts.stderr) child.stderr.emit("data", Buffer.from(opts.stderr));
      child.emit("close", opts.code ?? 0);
    });
  });
  child.stdin = stdin;
  child.kill = vi.fn(() => {
    setImmediate(() => child.emit("close", null));
    return true;
  });
  return child;
}

function envelope(result: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result,
    usage: { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 3, output_tokens: 7 },
    ...extra,
  });
}

function stubLocalEnv(): void {
  vi.stubEnv("MEMBRAL_LLM_PROVIDER", "claude-code");
  vi.stubEnv("MEMBRAL_LOCAL", "1");
  vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", TOKEN);
  vi.stubEnv("VERCEL", undefined);
  vi.stubEnv("MEMBRAL_MODEL", undefined);
  vi.stubEnv("MEMBRAL_CLAUDE_BIN", undefined);
  vi.stubEnv("MEMBRAL_CLAUDE_TIMEOUT_MS", undefined);
  // Things that must never reach the child.
  vi.stubEnv("OPENAI_API_KEY", "sk-paid-openai");
  vi.stubEnv("ANTHROPIC_API_KEY", "sk-paid-anthropic");
  vi.stubEnv("CLAUDE_CODE_ENTRYPOINT", "cli");
  vi.stubEnv("CLAUDE_CODE_SSE_PORT", "1234");
}

const schema = z.object({ answer: z.string() });

function call(client: LlmClient) {
  return client.callJson({
    systemPrompt: "SYSTEM PROMPT",
    userPrompt: "USER PROMPT secret transcript",
    pass: "memory_backfill",
    conversationId: "c1",
    schema,
  });
}

beforeEach(() => {
  spawnMock.mockReset();
  resetClaudeCodeRefusalLogForTests();
  stubLocalEnv();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("activation (fail closed)", () => {
  it("resolves on a local stack with a token, model label claude-code/default", () => {
    const cfg = resolveModelConfig(LOCAL_ENV);
    expect(cfg.provider).toBe("claude-code");
    expect(cfg.model).toBe("claude-code/default");
    expect(cfg.keySource).toBe("CLAUDE_CODE_OAUTH_TOKEN");
    expect(JSON.stringify(cfg)).not.toContain(TOKEN);
    expect(resolveModelConfig({ ...LOCAL_ENV, MEMBRAL_MODEL: "sonnet" }).model).toBe("claude-code/sonnet");
  });

  it.each([
    ["hosted (VERCEL set)", { ...LOCAL_ENV, VERCEL: "1" }, /Vercel/],
    ["MEMBRAL_LOCAL missing", { ...LOCAL_ENV, MEMBRAL_LOCAL: undefined }, /MEMBRAL_LOCAL=1/],
    ["token missing", { ...LOCAL_ENV, CLAUDE_CODE_OAUTH_TOKEN: undefined }, /CLAUDE_CODE_OAUTH_TOKEN/],
    [
      "Claude Code download failed",
      { ...LOCAL_ENV, MEMBRAL_CLAUDE_UNAVAILABLE: "1" },
      /could not be downloaded from npm/,
    ],
  ])("refuses when %s, never falls back to a paid key", (_name, env, reason) => {
    const withPaidKey = { ...env, OPENAI_API_KEY: "sk-paid-openai" };
    expect(() => resolveModelConfig(withPaidKey)).toThrow(reason);
    expect(chatConfigured(withPaidKey)).toBe(false);
    expect(claudeCodeActivation(withPaidKey).ok).toBe(false);
  });

  it("logs the refusal reason once, without the token", () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const env = { ...LOCAL_ENV, VERCEL: "1" };
    expect(() => resolveModelConfig(env)).toThrow();
    expect(() => resolveModelConfig(env)).toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(TOKEN);
  });

  it("leaves hosted resolution unchanged when MEMBRAL_LLM_PROVIDER is unset", () => {
    const cfg = resolveModelConfig({ OPENAI_API_KEY: "k" });
    expect(cfg.provider).toBeUndefined();
    expect(cfg.model).toBe("gpt-4o-mini");
  });

  it("refuses at call time too when VERCEL appears after resolve", async () => {
    const client = new LlmClient(resolveModelConfig(LOCAL_ENV));
    vi.stubEnv("VERCEL", "1");
    await expect(call(client)).rejects.toThrow(/Vercel/);
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe("spawn", () => {
  it("passes tools off, json output, system prompt in argv, prompt on stdin, allowlisted env", async () => {
    const child = fakeChild({ stdout: envelope('{"answer":"yes"}') });
    spawnMock.mockReturnValue(child as never);
    const client = new LlmClient(resolveModelConfig(LOCAL_ENV));
    const out = await call(client);
    expect(out.data).toEqual({ answer: "yes" });

    const [bin, args, options] = spawnMock.mock.calls[0] as unknown as [
      string,
      string[],
      { cwd: string; env: Record<string, string> },
    ];
    expect(bin).toBe("claude");
    expect(args).toEqual(buildClaudeArgs(`${options.cwd}/system-prompt.txt`, undefined));
    expect(args).not.toContain("--system-prompt");
    expect(args).not.toContain("SYSTEM PROMPT");
    const toolsAt = args.indexOf("--tools");
    expect(args[toolsAt + 1]).toBe("");
    expect(args).toContain("-p");
    expect(args.slice(args.indexOf("--output-format"), args.indexOf("--output-format") + 2)).toEqual([
      "--output-format",
      "json",
    ]);
    expect(args).toContain("--strict-mcp-config");
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
    expect(args).not.toContain("--model");
    expect(args.join(" ")).not.toContain("USER PROMPT");
    expect(child.stdin.end).toHaveBeenCalledWith("USER PROMPT secret transcript");

    const allowed = ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR", "DISABLE_AUTOUPDATER", "HOME", "PATH"];
    if (process.env.LANG) allowed.push("LANG");
    expect(Object.keys(options.env).sort()).toEqual(allowed.sort());
    expect(options.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN);
    expect(options.env.DISABLE_AUTOUPDATER).toBe("1");
    expect(options.env.HOME).toBe(options.cwd);
    expect(options.env.CLAUDE_CONFIG_DIR).toBe(`${options.cwd}/.claude`);
    expect(options.cwd.startsWith(tmpdir())).toBe(true);
    // Temp dir removed afterwards.
    expect(existsSync(options.cwd)).toBe(false);
  });

  it("writes the system prompt to a file in the temp dir and passes --system-prompt-file", async () => {
    const big = "S".repeat(500_000);
    let fileText = "";
    spawnMock.mockImplementation(((_bin: string, args: string[]) => {
      fileText = readFileSync(args[args.indexOf("--system-prompt-file") + 1], "utf8");
      return fakeChild({ stdout: envelope("ok") });
    }) as never);
    const r = await runClaudeCode({ systemPrompt: big, userPrompt: "u", model: "claude-code/default" }, LOCAL_ENV);
    expect(r.kind).toBe("ok");
    expect(fileText).toBe(big);
    const args = spawnMock.mock.calls[0][1] as string[];
    expect(args.join("").length).toBeLessThan(1000);
  });

  it("kills the child and returns an error result when stdout exceeds the cap", async () => {
    const child = fakeChild({ hang: true });
    spawnMock.mockReturnValue(child as never);
    const p = runClaudeCode({ systemPrompt: "s", userPrompt: "u", model: "claude-code/default" }, LOCAL_ENV);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    await new Promise((r) => setImmediate(r));
    child.stdout.emit("data", Buffer.alloc(CLAUDE_CODE_MAX_OUTPUT_BYTES + 1));
    const r = await p;
    expect(r).toMatchObject({ kind: "error", exitCode: null });
    expect((r as { reason?: string }).reason).toMatch(/exceeded/);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("does the same for stderr", async () => {
    const child = fakeChild({ hang: true });
    spawnMock.mockReturnValue(child as never);
    const p = runClaudeCode({ systemPrompt: "s", userPrompt: "u", model: "claude-code/default" }, LOCAL_ENV);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    await new Promise((r) => setImmediate(r));
    child.stderr.emit("data", Buffer.alloc(CLAUDE_CODE_MAX_OUTPUT_BYTES + 1));
    const r = await p;
    expect(r).toMatchObject({ kind: "error", exitCode: null });
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  describe("temp dir cleanup and decoding", () => {
    const OPTS = { systemPrompt: "s", userPrompt: "u", model: "claude-code/default" };
    const dirOf = () => {
      const args = spawnMock.mock.calls[0][1] as string[];
      return dirname(args[args.indexOf("--system-prompt-file") + 1]);
    };

    it("removes the temp dir after an error exit", async () => {
      spawnMock.mockReturnValue(fakeChild({ stdout: "not json", code: 1 }) as never);
      const r = await runClaudeCode(OPTS, LOCAL_ENV);
      expect(r.kind).toBe("error");
      expect(existsSync(dirOf())).toBe(false);
    });

    it("removes the temp dir after a timeout", async () => {
      spawnMock.mockReturnValue(fakeChild({ hang: true }) as never);
      const r = await runClaudeCode(OPTS, { ...LOCAL_ENV, MEMBRAL_CLAUDE_TIMEOUT_MS: "20" });
      expect(r.kind).toBe("timeout");
      expect(existsSync(dirOf())).toBe(false);
    });

    it("removes the temp dir after an output overflow", async () => {
      const child = fakeChild({ hang: true });
      spawnMock.mockReturnValue(child as never);
      const p = runClaudeCode(OPTS, LOCAL_ENV);
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
      await new Promise((r) => setImmediate(r));
      child.stdout.emit("data", Buffer.alloc(CLAUDE_CODE_MAX_OUTPUT_BYTES + 1));
      expect((await p).kind).toBe("error");
      expect(existsSync(dirOf())).toBe(false);
    });

    it("returns an error result, not a throw, when the temp dir cannot be created", async () => {
      vi.stubEnv("TMPDIR", "/nonexistent-membral-dir/x");
      const r = await runClaudeCode(OPTS, LOCAL_ENV);
      expect(r).toMatchObject({ kind: "error", exitCode: null });
      expect(spawnMock).not.toHaveBeenCalled();
    });

    it("decodes a multi-byte character split across two chunks", async () => {
      const child = fakeChild({ hang: true });
      spawnMock.mockReturnValue(child as never);
      const p = runClaudeCode(OPTS, LOCAL_ENV);
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
      await new Promise((r) => setImmediate(r));
      const bytes = Buffer.from(envelope("caf\u00e9 \u20ac"));
      const cut = bytes.indexOf(0xc3) + 1; // between the two bytes of the e-acute
      child.stdout.emit("data", bytes.subarray(0, cut));
      child.stdout.emit("data", bytes.subarray(cut));
      child.emit("close", 0);
      const r = await p;
      expect(r).toMatchObject({ kind: "ok", text: "caf\u00e9 \u20ac" });
    });
  });

  it("passes --model and MEMBRAL_CLAUDE_BIN when set", async () => {
    vi.stubEnv("MEMBRAL_CLAUDE_BIN", "/opt/bin/claude");
    spawnMock.mockReturnValue(fakeChild({ stdout: envelope('{"answer":"x"}') }) as never);
    const client = new LlmClient(resolveModelConfig({ ...LOCAL_ENV, MEMBRAL_MODEL: "haiku" }));
    await call(client);
    const [bin, args] = spawnMock.mock.calls[0] as unknown as [string, string[]];
    expect(bin).toBe("/opt/bin/claude");
    expect(args.slice(-2)).toEqual(["--model", "haiku"]);
  });

  it("records a $0 spend row with envelope tokens under the claude-code label", async () => {
    spawnMock.mockReturnValue(fakeChild({ stdout: envelope('```json\n{"answer":"y"}\n```') }) as never);
    const onSpend = vi.fn();
    const client = new LlmClient(resolveModelConfig({ ...LOCAL_ENV, MEMBRAL_MODEL: "sonnet" }), { onSpend });
    const out = await call(client);
    expect(out.data).toEqual({ answer: "y" });
    expect(out.callCostUsd).toBe(0);
    expect(onSpend).toHaveBeenCalledTimes(1);
    expect(onSpend.mock.calls[0][0]).toMatchObject({
      model: "claude-code/sonnet",
      cost_usd: 0,
      tokens_in: 18,
      tokens_out: 7,
      pass: "memory_backfill",
    });
  });

  it("schema failure goes through the existing retry-then-throw path (caller's heuristic fallback)", async () => {
    spawnMock.mockImplementation(() => fakeChild({ stdout: envelope('{"wrong":1}') }) as never);
    const client = new LlmClient(resolveModelConfig(LOCAL_ENV));
    await expect(call(client)).rejects.toThrow(/JSON parse\/validation failed/);
    expect(spawnMock).toHaveBeenCalledTimes(3);
    expect(client.parseFailCount).toBe(3);
  });

  it("empty result goes through the existing empty-response path", async () => {
    spawnMock.mockImplementation(() => fakeChild({ stdout: envelope("") }) as never);
    const client = new LlmClient(resolveModelConfig(LOCAL_ENV));
    await expect(call(client)).rejects.toThrow(/Empty response/);
    expect(client.emptyResponseCount).toBe(3);
  });

  it("kills the child on timeout and throws the SDK timeout error", async () => {
    vi.stubEnv("MEMBRAL_CLAUDE_TIMEOUT_MS", "20");
    const child = fakeChild({ hang: true });
    spawnMock.mockReturnValue(child as never);
    const client = new LlmClient(resolveModelConfig(LOCAL_ENV));
    const err = await call(client).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(APIConnectionTimeoutError);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(describeLlmFailure(err, 0).isTimeout).toBe(true);
  });

  it("maps a usage-limit failure to the HTTP-429 path, not retried by callJson", async () => {
    spawnMock.mockImplementation(
      () =>
        fakeChild({
          stdout: envelope("Claude AI usage limit reached|1760000000", { is_error: true, subtype: "error" }),
          code: 1,
        }) as never,
    );
    const client = new LlmClient(resolveModelConfig(LOCAL_ENV));
    const err = await call(client).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderBodyError);
    expect((err as ProviderBodyError).status).toBe(429);
    expect(describeLlmFailure(err, 0).errorClass).toBe("RateLimitError");
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("runs one child at a time", async () => {
    let live = 0;
    let maxLive = 0;
    spawnMock.mockImplementation(() => {
      live++;
      maxLive = Math.max(maxLive, live);
      const c = fakeChild({ stdout: envelope('{"answer":"z"}') });
      c.on("close", () => live--);
      return c as never;
    });
    const client = new LlmClient(resolveModelConfig(LOCAL_ENV));
    await Promise.all([call(client), call(client), call(client)]);
    expect(spawnMock).toHaveBeenCalledTimes(3);
    expect(maxLive).toBe(1);
  });

  it("keeps embeddings off without an embeddings base URL", async () => {
    const client = new LlmClient(resolveModelConfig(LOCAL_ENV));
    await expect(client.embed({ text: "hi", pass: "memory_embedding", conversationId: "c" })).rejects.toThrow(
      /Embeddings are off/,
    );
  });
});

// The exact envelope claude 2.1.288 printed live with no login (exit code 0).
const NOT_LOGGED_IN = {
  type: "result",
  subtype: "success",
  is_error: true,
  terminal_reason: "api_error",
  api_error_status: null,
  result: "Not logged in · Please run /login",
  total_cost_usd: 0,
  num_turns: 1,
  usage: { input_tokens: 0, output_tokens: 0 },
  modelUsage: {},
};

describe("live envelope shapes (2.1.288)", () => {
  it("not logged in at exit 0 → a clear not-configured error, no retry loop", async () => {
    spawnMock.mockImplementation(() => fakeChild({ stdout: JSON.stringify(NOT_LOGGED_IN), code: 0 }) as never);
    const client = new LlmClient(resolveModelConfig(LOCAL_ENV));
    await expect(call(client)).rejects.toThrow(
      "claude-code provider: token rejected or missing — run `claude setup-token`",
    );
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(interpretClaudeOutput(JSON.stringify(NOT_LOGGED_IN), "", 0)).toEqual({ kind: "auth_failed" });
  });

  it("is_error true fails regardless of exit code and subtype", () => {
    const env = { ...NOT_LOGGED_IN, result: "something odd" };
    expect(interpretClaudeOutput(JSON.stringify(env), "", 0)).toEqual({ kind: "error", exitCode: 0 });
  });

  it("an abnormal terminal_reason fails even with is_error false", () => {
    const env = { ...NOT_LOGGED_IN, is_error: false, result: '{"answer":"x"}' };
    expect(interpretClaudeOutput(JSON.stringify(env), "", 0)).toEqual({ kind: "error", exitCode: 0 });
  });

  it("api_error_status 429 → the 429 backoff path", async () => {
    const env = { ...NOT_LOGGED_IN, api_error_status: 429, result: "API Error" };
    spawnMock.mockImplementation(() => fakeChild({ stdout: JSON.stringify(env), code: 0 }) as never);
    const client = new LlmClient(resolveModelConfig(LOCAL_ENV));
    const err = await call(client).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderBodyError);
    expect((err as ProviderBodyError).status).toBe(429);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("records the model the CLI actually used from modelUsage, still at $0", async () => {
    const env = {
      ...NOT_LOGGED_IN,
      is_error: false,
      terminal_reason: "completed",
      result: '{"answer":"ok"}',
      usage: { input_tokens: 4, output_tokens: 2 },
      modelUsage: { "claude-haiku-4-5": { outputTokens: 1 }, "claude-sonnet-5": { outputTokens: 2 } },
    };
    spawnMock.mockReturnValue(fakeChild({ stdout: JSON.stringify(env), code: 0 }) as never);
    const onSpend = vi.fn();
    const client = new LlmClient(resolveModelConfig(LOCAL_ENV), { onSpend });
    const out = await call(client);
    expect(out.data).toEqual({ answer: "ok" });
    expect(onSpend.mock.calls[0][0]).toMatchObject({ model: "claude-code/claude-sonnet-5", cost_usd: 0 });
  });
});

describe("output parsing", () => {
  it("classifies limit wording on stderr with a non-zero exit as rate limited", () => {
    expect(interpretClaudeOutput("", "Error: 5-hour limit reached", 1)).toEqual({ kind: "rate_limited" });
    expect(interpretClaudeOutput("", "boom", 2)).toEqual({ kind: "error", exitCode: 2 });
    expect(interpretClaudeOutput("not json", "", 0)).toEqual({ kind: "error", exitCode: 0 });
  });

  it("extracts JSON from prose or fences", () => {
    expect(extractJsonText('Here you go: {"a":1} done')).toBe('{"a":1}');
    expect(extractJsonText('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(extractJsonText('{"a":1}')).toBe('{"a":1}');
    expect(extractJsonText("no json")).toBe("no json");
  });
});
