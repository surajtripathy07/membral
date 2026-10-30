import { describe, expect, it, vi } from "vitest";
import type { DockerRunner } from "../docker-runner.js";
import { PREWARM_SQL, parseMemTotal, pgTuneArgs, prewarmExcerpts, readDockerMemTotal } from "../local-pg-tune.js";
import { renderCompose } from "../local-stack.js";

const GB = 1024 ** 3;
const flags = (a: string[]) => a.filter((_, i) => i % 2 === 1);

describe("pgTuneArgs", () => {
  it("sizes a 14 GB VM: 25% shared_buffers, 65% effective_cache_size", () => {
    expect(flags(pgTuneArgs(14 * GB))).toEqual([
      "shared_buffers=3584MB",
      "effective_cache_size=9318MB",
      "random_page_cost=1.1",
    ]);
  });

  it("sizes a 4 GB VM", () => {
    expect(flags(pgTuneArgs(4 * GB))).toEqual([
      "shared_buffers=1024MB",
      "effective_cache_size=2662MB",
      "random_page_cost=1.1",
    ]);
  });

  it("clamps high: 64 GB gives 4096MB and 12288MB", () => {
    expect(flags(pgTuneArgs(64 * GB))).toEqual([
      "shared_buffers=4096MB",
      "effective_cache_size=12288MB",
      "random_page_cost=1.1",
    ]);
  });

  it("clamps low: 256 MB gives 128MB and 512MB", () => {
    expect(flags(pgTuneArgs(256 * 1024 ** 2))).toEqual([
      "shared_buffers=128MB",
      "effective_cache_size=512MB",
      "random_page_cost=1.1",
    ]);
  });

  it("adds no flags when the size is unknown or junk", () => {
    for (const v of [null, undefined, 0, -5, Number.NaN, Number.POSITIVE_INFINITY]) expect(pgTuneArgs(v)).toEqual([]);
  });
});

describe("parseMemTotal / readDockerMemTotal", () => {
  it("parses a byte count and rejects junk", () => {
    expect(parseMemTotal("15032385536\n")).toBe(15032385536);
    for (const t of ["", "abc", "0", "-1", "1.5e9", "12 GB"]) expect(parseMemTotal(t)).toBeNull();
  });

  const runnerOf = (
    res: { code: number; stdout: string } | Error,
  ): DockerRunner & { run: ReturnType<typeof vi.fn> } => ({
    run: vi.fn(async () => {
      if (res instanceof Error) throw res;
      return { ...res, stderr: "" };
    }),
  });

  it("asks docker info for MemTotal", async () => {
    const r = runnerOf({ code: 0, stdout: "8589934592\n" });
    expect(await readDockerMemTotal(r)).toBe(8589934592);
    expect(r.run).toHaveBeenCalledWith(["info", "--format", "{{.MemTotal}}"]);
  });

  it("returns null when docker info fails, prints junk or throws", async () => {
    expect(await readDockerMemTotal(runnerOf({ code: 1, stdout: "" }))).toBeNull();
    expect(await readDockerMemTotal(runnerOf({ code: 0, stdout: "<no value>" }))).toBeNull();
    expect(await readDockerMemTotal(runnerOf(new Error("boom")))).toBeNull();
  });
});

describe("renderCompose db command", () => {
  const base = { appPort: 3940, image: "img:x", llmKeys: [] as string[] };
  const head = '"postgres", "-c", "config_file=/etc/postgresql/postgresql.conf", "-c", "log_min_messages=fatal"';

  it("keeps the stock command without a memory size", () => {
    expect(renderCompose(base)).toContain(`command: [${head}]\n`);
    expect(renderCompose({ ...base, dockerMemBytes: null })).toContain(`command: [${head}]\n`);
  });

  it("appends the flags after config_file and log_min_messages", () => {
    const yml = renderCompose({ ...base, dockerMemBytes: 14 * GB });
    expect(yml).toContain(
      `command: [${head}, "-c", "shared_buffers=3584MB", "-c", "effective_cache_size=9318MB", "-c", "random_page_cost=1.1"]\n`,
    );
  });
});

describe("prewarmExcerpts", () => {
  const argv = (...a: string[]) => ["compose", "-p", "p", ...a];

  it("runs pg_prewarm detached (exec -d) in the db container", async () => {
    const run = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    expect(await prewarmExcerpts({ run }, argv)).toBeNull();
    expect(run).toHaveBeenCalledTimes(1);
    const args = run.mock.calls[0]?.[0] as string[];
    expect(args.slice(0, 7)).toEqual(["compose", "-p", "p", "exec", "-d", "-T", "db"]);
    expect(args[args.length - 1]).toBe(PREWARM_SQL);
    expect(PREWARM_SQL).toContain("pg_prewarm('public.session_raw_units','buffer')");
    expect(PREWARM_SQL).toContain("idx_session_raw_units_embedding");
  });

  it("swallows a failing exit code and a thrown error, returning one line", async () => {
    const failing = { run: vi.fn(async () => ({ code: 1, stdout: "", stderr: "no such service" })) };
    const throwing = {
      run: vi.fn(async () => {
        throw new Error("spawn failed");
      }),
    };
    expect(await prewarmExcerpts(failing, argv)).toMatch(/Prewarm skipped/);
    expect(await prewarmExcerpts(throwing, argv)).toMatch(/Prewarm skipped/);
  });
});
