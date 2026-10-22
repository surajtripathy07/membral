// Goal 2026-09-24 review B1: the extract-next chain — auth token, base URL,
// trigger, and when a step chains the next call.
import { afterEach, describe, expect, it, vi } from "vitest";
import { log } from "@/lib/log";
import type { MemoryStepResult } from "../extraction-queue";
import {
  checkMemoryWorkerAuth,
  errorClassName,
  memoryWorkerToken,
  resolveInternalBaseUrl,
  runMemoryExtractionStep,
  triggerMemoryExtraction,
} from "../extraction-trigger";

vi.mock("@/lib/db/clients", () => ({ getServiceClient: () => ({}) }));

const ENV = { SUPABASE_SERVICE_ROLE_KEY: "service-key" };

describe("internal auth", () => {
  it("derives a stable token from the service-role key without exposing it", () => {
    const token = memoryWorkerToken(ENV);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(token).toBe(memoryWorkerToken(ENV));
    expect(token).not.toContain("service-key");
    expect(memoryWorkerToken({ SUPABASE_SERVICE_ROLE_KEY: "other" })).not.toBe(token);
  });

  it("accepts only the exact bearer token; refuses when unconfigured", () => {
    expect(checkMemoryWorkerAuth(`Bearer ${memoryWorkerToken(ENV)}`, ENV)).toBe("ok");
    expect(checkMemoryWorkerAuth("Bearer service-key", ENV)).toBe("forbidden");
    expect(checkMemoryWorkerAuth(null, ENV)).toBe("forbidden");
    expect(checkMemoryWorkerAuth(`Bearer ${memoryWorkerToken(ENV)}`, {})).toBe("not_configured");
  });
});

describe("resolveInternalBaseUrl", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("uses NEXT_PUBLIC_APP_URL in every environment", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "http://localhost:3001/");
    for (const env of ["production", "development", "test"]) {
      vi.stubEnv("NODE_ENV", env);
      expect(resolveInternalBaseUrl()).toBe("http://localhost:3001");
    }
  });

  it("falls back to http://localhost:3000 outside production when unset", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    vi.stubEnv("NODE_ENV", "development");
    expect(resolveInternalBaseUrl()).toBe("http://localhost:3000");
  });

  it("takes no request input, so a spoofed Host (loopback or not) cannot change it (#371)", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.example.test");
    vi.stubEnv("NODE_ENV", "development");
    expect(resolveInternalBaseUrl.length).toBe(0);
    // Callers used to pass req.url; extra args are ignored.
    const spoofed = resolveInternalBaseUrl as unknown as (u: string) => string;
    expect(spoofed("http://localhost:9999/api/code-sessions")).toBe("https://app.example.test");
    expect(spoofed("http://evil.test/api/code-sessions")).toBe("https://app.example.test");
  });
});

describe("triggerMemoryExtraction", () => {
  it("POSTs { userId } with the bearer token and succeeds only on 202", async () => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    expect(await triggerMemoryExtraction("u1", "http://localhost:3001", fetchImpl)).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("http://localhost:3001/api/memory/extract-next");
    expect(init.headers.authorization).toBe(`Bearer ${memoryWorkerToken(ENV)}`);
    expect(JSON.parse(init.body)).toEqual({ userId: "u1" });

    fetchImpl.mockResolvedValueOnce(new Response(null, { status: 403 }));
    expect(await triggerMemoryExtraction("u1", "http://localhost:3001", fetchImpl)).toBe(false);
    fetchImpl.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    expect(await triggerMemoryExtraction("u1", "http://localhost:3001", fetchImpl)).toBe(false);
    vi.unstubAllEnvs();
  });
});

describe("runMemoryExtractionStep — one invocation loops, never calls itself (issue #339)", () => {
  const step = (outcome: MemoryStepResult["outcome"], continueChain: boolean, reason?: string): MemoryStepResult => ({
    outcome,
    sessionId: outcome === "none_claimed" ? undefined : "s",
    continueChain,
    ...(reason ? { reason } : {}),
  });

  it("runs the next step in the same invocation while the step may continue, and never fetches", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const process = vi
      .fn()
      .mockResolvedValueOnce(step("done", true))
      .mockResolvedValueOnce(step("done", true))
      .mockResolvedValueOnce(step("none_claimed", false));
    const r = await runMemoryExtractionStep("u1", { process, clock: () => 0 });
    expect(process).toHaveBeenCalledTimes(3);
    expect(r).toMatchObject({ sessionsProcessed: 2, stopReason: "none_claimed" });
    expect(r).not.toHaveProperty("chained");
    expect(process.mock.calls.map((c) => c[1].stepIndex)).toEqual([0, 1, 2]);
    expect(process.mock.calls.every((c) => c[1].invocationStartedAt === 0)).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("stops after nothing was claimed, or after a budget/ceiling stop, or a deadline_partial", async () => {
    for (const s of [
      step("none_claimed", false),
      step("skipped_budget", false),
      step("released", false),
      step("released", true, "deadline_partial"),
    ]) {
      const process = vi.fn().mockResolvedValue(s);
      const r = await runMemoryExtractionStep("u1", { process, clock: () => 0 });
      expect(process).toHaveBeenCalledTimes(1);
      expect(r.sessionsProcessed).toBe(s.sessionId ? 1 : 0);
    }
  });

  it("a step that throws ends the invocation without rethrowing", async () => {
    const process = vi.fn().mockRejectedValue(new Error("boom"));
    const r = await runMemoryExtractionStep("u1", { process, clock: () => 0 });
    expect(r).toMatchObject({ stopReason: "step_error", sessionsProcessed: 0 });
  });

  it("step_error logs the error's class name only, never its message, capped at 64 chars", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logged: string[] = [];
    const errSpy = vi.spyOn(log, "error").mockImplementation((_msg: string, fields?: Record<string, unknown>) => {
      logged.push(String(fields?.error));
    });
    class ProviderSecretError extends Error {}
    await runMemoryExtractionStep("u1", {
      process: vi.fn().mockRejectedValue(new ProviderSecretError("transcript text: my password")),
      clock: () => 0,
    });
    expect(logged).toEqual(["ProviderSecretError"]);
    expect(errorClassName(new TypeError("x"))).toBe("TypeError");
    expect(errorClassName("a string")).toBe("string");
    const Long = { [`E${"x".repeat(100)}`]: class extends Error {} }[`E${"x".repeat(100)}`];
    expect(errorClassName(new Long("m"))).toHaveLength(64);
    errSpy.mockRestore();
    spy.mockRestore();
  });
});
