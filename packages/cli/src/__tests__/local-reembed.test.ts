// `membral local reembed` against a fake app (fetch) and a temp stack dir. No Docker, no network, no real HOME.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type LocalDeps, localReembed } from "../local-command.js";
import { localPaths } from "../local-stack.js";

const KEY = "service-role-key-for-tests";
const REMAINING0 = { session_memories: 0, conversations: 0, conversation_chunks: 0, session_raw_units: 0 };

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

describe("localReembed", () => {
  let dir: string;
  let deps: LocalDeps;
  let out: string[];
  let errs: string[];
  let sleeps: number[];
  let urls: URL[];
  let auths: (string | null)[];
  let clock: number;
  let responses: Array<Response | Error>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "membral-reembed-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "docker-compose.yml"), "services: {}\n");
    writeFileSync(join(dir, ".env"), `SERVICE_ROLE_KEY=${KEY}\nMEMBRAL_APP_PORT=3456\n`);
    out = [];
    errs = [];
    sleeps = [];
    urls = [];
    auths = [];
    clock = 1_000_000;
    responses = [];
    process.exitCode = undefined;
    vi.spyOn(console, "log").mockImplementation((...a) => void out.push(a.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...a) => void errs.push(a.join(" ")));
    deps = {
      paths: localPaths(dir),
      env: {},
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
      now: () => (clock += 2000), // each read advances 2 s so the 3 s progress throttle fires every other batch
      stopSignal: new AbortController().signal,
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        urls.push(new URL(String(input)));
        auths.push(new Headers(init?.headers).get("authorization"));
        const next = responses.shift();
        if (!next) throw new Error("fake app: no response queued");
        if (next instanceof Error) throw next;
        return next;
      }) as typeof fetch,
    };
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  const batchResp = (over: Record<string, unknown>) =>
    json({
      table: "session_memories",
      done: 0,
      failed: 0,
      remaining_by_table: REMAINING0,
      finished: false,
      next: null,
      family: "nomic-embed-text",
      dry_run: false,
      ...over,
    });

  it("loops, following the cursor, until the server says finished; sends the bearer and never prints it", async () => {
    responses = [
      batchResp({
        done: 64,
        remaining_by_table: { ...REMAINING0, session_memories: 64, conversations: 10 },
        next: { table: "session_memories", after: "m-64" },
      }),
      batchResp({
        done: 64,
        remaining_by_table: { ...REMAINING0, conversations: 10 },
        next: { table: "session_memories", after: "m-128" },
      }),
      batchResp({ table: "conversations", done: 10, next: { table: "conversations", after: "c-10" } }),
      batchResp({ table: null, finished: true }),
    ];
    await localReembed({}, deps);
    expect(urls).toHaveLength(4);
    expect(urls[0].origin).toBe("http://localhost:3456");
    expect(urls[0].searchParams.get("table")).toBeNull();
    expect(urls[1].searchParams.get("table")).toBe("session_memories");
    expect(urls[1].searchParams.get("after")).toBe("m-64");
    expect(urls[3].searchParams.get("table")).toBe("conversations");
    expect(urls[3].searchParams.get("after")).toBe("c-10");
    expect(new Set(auths)).toEqual(new Set([`Bearer ${KEY}`]));
    expect(out.join("\n")).toContain("Re-embedding 138 row(s) to nomic-embed-text");
    expect(out.join("\n")).toMatch(/session_memories\s+\d+\/128/);
    expect(out.at(-1)).toMatch(/^Done: 138 re-embedded/);
    expect([...out, ...errs].join("\n")).not.toContain(KEY);
    expect(process.exitCode).toBeUndefined();
  });

  it("says so and stops when nothing needs re-embedding", async () => {
    responses = [batchResp({ table: null, finished: true })];
    await localReembed({}, deps);
    expect(out.join("\n")).toContain("Nothing to re-embed");
    expect(urls).toHaveLength(1);
  });

  it("passes --batch and rejects a bad one before any request", async () => {
    responses = [batchResp({ finished: true })];
    await localReembed({ batch: "128" }, deps);
    expect(urls[0].searchParams.get("batch")).toBe("128");
    await localReembed({ batch: "999" }, deps);
    expect(errs.at(-1)).toMatch(/Invalid --batch/);
    expect(urls).toHaveLength(1);
    expect(process.exitCode).toBe(1);
  });

  it("backs off on 429 (rule 4: honours Retry-After, never retries at once, decays on success) and resumes", async () => {
    responses = [
      json({ error: "rate_limited" }, 429, { "retry-after": "7" }),
      json({ error: "rate_limited" }, 429),
      batchResp({
        done: 1,
        remaining_by_table: { ...REMAINING0, session_memories: 1 },
        next: { table: "session_memories", after: "a" },
      }),
      batchResp({ table: null, finished: true }),
    ];
    await localReembed({}, deps);
    // First wait: Retry-After 7 s. Second: the grown bucket delay (500 -> 2,500 -> 7,500), above the 500 ms floor.
    expect(sleeps[0]).toBe(7000);
    expect(sleeps[1]).toBeGreaterThan(500);
    expect(sleeps.every((s) => s >= 500)).toBe(true);
    expect(urls).toHaveLength(4);
    expect(out.at(-1)).toMatch(/^Done: 1 re-embedded/);
    expect(process.exitCode).toBeUndefined();
  });

  it("gives up after repeated 429s with a resumable message", async () => {
    responses = Array.from({ length: 10 }, () => json({ error: "rate_limited" }, 429));
    await localReembed({}, deps);
    expect(errs.join("\n")).toContain("keeps rate-limiting");
    expect(process.exitCode).toBe(1);
  });

  it("reports the server's own message on 409 (no embedder) and 502 (embedder down)", async () => {
    responses = [json({ error: "no_embedder", message: "No embedding provider is configured" }, 409)];
    await localReembed({}, deps);
    expect(errs.at(-1)).toContain("No embedding provider is configured");
    responses = [json({ error: "embedder_unavailable", message: "model not pulled" }, 502)];
    await localReembed({}, deps);
    expect(errs.at(-1)).toContain("model not pulled");
    expect(process.exitCode).toBe(1);
  });

  it("stops cleanly after the batch in flight when interrupted, and says how to resume", async () => {
    const ac = new AbortController();
    deps.stopSignal = ac.signal;
    responses = [
      batchResp({
        done: 5,
        remaining_by_table: { ...REMAINING0, session_memories: 5 },
        next: { table: "session_memories", after: "a" },
      }),
    ];
    const orig = deps.fetchImpl as typeof fetch;
    deps.fetchImpl = (async (...a: Parameters<typeof fetch>) => {
      const r = await orig(...a);
      ac.abort(); // Ctrl-C arrives while the first batch is in flight
      return r;
    }) as typeof fetch;
    await localReembed({}, deps);
    expect(urls).toHaveLength(1);
    expect(out.at(-1)).toMatch(/^Stopped after 5 re-embedded/);
    expect(out.at(-1)).toContain("membral local reembed");
  });

  it("dry run prints a counts table and sends dry_run=1 only", async () => {
    responses = [
      json({
        family: "nomic-embed-text",
        dry_run: true,
        counts: {
          ...Object.fromEntries(
            Object.keys(REMAINING0).map((t) => [t, { remaining: 0, missing: 0, foreign_default: 0, foreign_other: 0 }]),
          ),
          session_memories: { remaining: 12, missing: 2, foreign_default: 9, foreign_other: 1 },
        },
      }),
    ];
    await localReembed({ dryRun: true }, deps);
    expect(urls).toHaveLength(1);
    expect(urls[0].searchParams.get("dry_run")).toBe("1");
    const text = out.join("\n");
    expect(text).toContain("Target embedding model: nomic-embed-text");
    expect(text).toMatch(/session_memories\s+12\s+2\s+9\s+1/);
    expect(text).toContain("Dry run: 12 vector(s) would be re-embedded. Nothing was written.");
  });

  it("fails clearly when there is no stack", async () => {
    rmSync(join(dir, ".env"));
    await localReembed({}, deps);
    expect(errs.at(-1)).toContain("No local stack yet");
    expect(urls).toHaveLength(0);
    expect(process.exitCode).toBe(1);
  });

  it("retries a dropped connection with backoff, then reports the app unreachable", async () => {
    responses = Array.from({ length: 10 }, () => new Error("ECONNREFUSED"));
    await localReembed({}, deps);
    expect(errs.at(-1)).toContain("not answering");
    expect(sleeps.length).toBeGreaterThan(0);
    expect(process.exitCode).toBe(1);
  });

  it("stops with exit 130 when Ctrl-C arrives during a network-retry sleep, without another request", async () => {
    const ac = new AbortController();
    deps.stopSignal = ac.signal;
    deps.sleep = async (ms) => {
      sleeps.push(ms);
      ac.abort();
    };
    responses = [new Error("ECONNRESET"), batchResp({ finished: true })];
    await localReembed({}, deps);
    expect(urls).toHaveLength(1);
    expect(out.at(-1)).toMatch(/^Stopped after 0 re-embedded/);
    expect(process.exitCode).toBe(130);
  });

  it("stops with exit 130 when Ctrl-C arrives during a 429 sleep, without another request", async () => {
    const ac = new AbortController();
    deps.stopSignal = ac.signal;
    deps.sleep = async (ms) => {
      sleeps.push(ms);
      ac.abort();
    };
    responses = [json({ error: "rate_limited" }, 429), batchResp({ finished: true })];
    await localReembed({}, deps);
    expect(urls).toHaveLength(1);
    expect(out.at(-1)).toMatch(/^Stopped after 0 re-embedded/);
    expect(process.exitCode).toBe(130);
  });

  it("does not report Stopped (or exit 130) when the run finished before the interrupt", async () => {
    const ac = new AbortController();
    deps.stopSignal = ac.signal;
    responses = [
      batchResp({
        done: 3,
        remaining_by_table: { ...REMAINING0, session_memories: 3 },
        next: { table: "session_memories", after: "c" },
      }),
      batchResp({ table: null, finished: true }),
    ];
    const orig = deps.fetchImpl as typeof fetch;
    let n = 0;
    deps.fetchImpl = (async (...a: Parameters<typeof fetch>) => {
      const r = await orig(...a);
      if (++n === 2) ac.abort(); // Ctrl-C lands while the final response is in flight
      return r;
    }) as typeof fetch;
    await localReembed({}, deps);
    expect(out.at(-1)).toMatch(/^Done: 3 re-embedded/);
    expect(out.join("\n")).not.toContain("Stopped");
    expect(process.exitCode).toBeUndefined();
  });

  it("prints a clear message and exits 1 on 422 embedding_dimension (nothing was written)", async () => {
    responses = [
      json({ error: "embedding_dimension", message: 'The embedding model "big" returns 2048-dimension vectors.' }, 422),
    ];
    await localReembed({}, deps);
    expect(errs.at(-1)).toContain("2048-dimension");
    expect(errs.at(-1)).toContain("Nothing was written");
    expect(errs.at(-1)).toContain("1536 or fewer dimensions");
    expect(process.exitCode).toBe(1);
  });

  it("reports deferred rows, counts them as handled, and tells the user to rerun", async () => {
    responses = [
      batchResp({
        done: 2,
        deferred: 3,
        remaining_by_table: { ...REMAINING0, session_memories: 3 },
        next: { table: "session_memories", after: "e" },
      }),
      batchResp({ table: null, finished: true, remaining_by_table: { ...REMAINING0, session_memories: 3 } }),
    ];
    await localReembed({}, deps);
    expect(out.join("\n")).toContain("Re-embedding 5 row(s)");
    expect(out.join("\n")).toMatch(/session_memories\s+5\/5/);
    expect(out.join("\n")).toContain("3 row(s) were skipped after transient embedding-server errors");
    expect(out.join("\n")).toContain("run `membral local reembed` again");
    expect(process.exitCode).toBeUndefined();
  });

  it("copes with remaining_by_table: null on every call after the first", async () => {
    responses = [
      batchResp({
        done: 4,
        remaining_by_table: { ...REMAINING0, session_memories: 2, conversations: 2 },
        next: { table: "session_memories", after: "d" },
      }),
      batchResp({ done: 2, remaining_by_table: null, next: { table: "session_memories", after: "f" } }),
      batchResp({
        table: "conversations",
        done: 2,
        remaining_by_table: null,
        next: { table: "conversations", after: "c2" },
      }),
      batchResp({ table: null, finished: true, remaining_by_table: REMAINING0 }),
    ];
    await localReembed({}, deps);
    expect(out.join("\n")).toContain("Re-embedding 8 row(s)");
    expect(out.at(-1)).toMatch(/^Done: 8 re-embedded/);
    expect(process.exitCode).toBeUndefined();
  });
});
