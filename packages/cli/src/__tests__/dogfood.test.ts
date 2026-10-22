import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  appendCandidates,
  candidateWindowDays,
  type DogfoodCandidateWire,
  fetchDogfood,
  formatDogfoodStatusLine,
  isFrozenBenchPath,
  isoWeek,
  neutralizeQuote,
  parseDogfood,
  postDigest,
  readDogfoodConfig,
  renderDigest,
  repoIsPrivate,
  runWeeklyDogfood,
} from "../dogfood.js";

const wire = {
  days: 7,
  since: "2026-10-03T00:00:00Z",
  totals: {
    served: 12,
    used: 4,
    ignored: 6,
    confirmed: 2,
    contradicted: 1,
    empty: 3,
    empty_below_floor: 2,
    empty_no_match: 1,
    hook: { calls: 9, injected: 5, empty: 2, budget_hit: 1, timeout: 1, errors: 0 },
    feedback: { total: 2, stale: 1, useful: 1, wrong: 0 },
  },
  quotes: [
    {
      id: "f1",
      sentiment: "stale",
      surface: "prompt_hook",
      quote: "that recall was stale, the PR merged yesterday",
      code_session_id: "s1",
      turn_idx: 7,
      created_at: "2026-10-08T00:00:00Z",
    },
  ],
};
const data = parseDogfood(wire)!;
const config = { apiUrl: "https://membral.test", apiKey: "lls_k", apiKeySource: "credentials" as const };

describe("status line", () => {
  it("has the exact prefix and the extra counts", () => {
    expect(formatDogfoodStatusLine(data)).toBe(
      "membral on membral: served 12 · used 4 · contradicted 1 · feedback 2 · empty 3 · budget-hit 2 (7 days)",
    );
  });
  it("parseDogfood rejects a wrong shape", () => {
    expect(parseDogfood(null)).toBeNull();
    expect(parseDogfood({ error: "x" })).toBeNull();
  });
  it("fetchDogfood is null on 404 and network failure", async () => {
    const f404 = vi.fn(async () => new Response("nf", { status: 404 })) as unknown as typeof fetch;
    expect(await fetchDogfood(config, 7, { fetchImpl: f404 })).toBeNull();
    const down = vi.fn(async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    expect(await fetchDogfood(config, 7, { fetchImpl: down })).toBeNull();
  });
});

describe("renderDigest", () => {
  it("renders counts, quotes with session links, and the agreement placeholder", () => {
    const md = renderDigest(data, { appUrl: "https://membral.test/", week: "2026-W41" });
    expect(md).toContain("## Membral on Membral — 2026-W41");
    expect(md).toContain("Served 12 records: used 4, ignored 6; confirmed 2, contradicted 1.");
    expect(md).toContain("Feedback: 2 (stale 1, useful 1).");
    expect(md).toContain("Self-report vs judge agreement: n/a");
    expect(md).toContain("(https://membral.test/code/session/s1?turn=7#turn-7)");
  });
  it("says so when there is no feedback", () => {
    expect(renderDigest({ ...data, quotes: [] }, { appUrl: "x", week: "w" })).toContain("No session said anything");
  });
});

const ghPrivate = (priv = true) =>
  vi.fn((args: string[]) =>
    args[0] === "repo"
      ? { status: 0, stderr: "", stdout: JSON.stringify({ isPrivate: priv }) }
      : { status: 0, stderr: "" },
  );
const commentCalls = (gh: ReturnType<typeof ghPrivate>) => gh.mock.calls.filter((c) => c[0][0] === "issue").length;

describe("neutralizeQuote", () => {
  it("breaks mentions and backlinks, defuses links and caps the length", () => {
    const out = neutralizeQuote("ping @octocat see #123 and [x](http://e.com) <b>hi</b> `code`");
    expect(out).not.toMatch(/@octocat/);
    expect(out).not.toMatch(/#123/);
    expect(out).not.toMatch(/\[x\]\(/);
    expect(out).not.toContain("<b>");
    expect(neutralizeQuote("y".repeat(900)).length).toBeLessThanOrEqual(200);
  });
  it("renders the digest with neutralised quotes", () => {
    const d = { ...wire, quotes: [{ ...wire.quotes[0], quote: "cc @someone fixes #9" }] } as never;
    const md = renderDigest(d, { appUrl: "http://x", week: "2026-W41" });
    expect(md).not.toMatch(/@someone/);
    expect(md).not.toMatch(/#9\b/);
  });
});

describe("postDigest", () => {
  it("refuses when the repo is public, unknown or the check fails (fail closed)", () => {
    const pub = ghPrivate(false);
    expect(postDigest("b", 1, "o/r", pub).ok).toBe(false);
    expect(commentCalls(pub)).toBe(0);
    const broken = vi.fn(() => ({ status: 1, stderr: "nope" }));
    expect(postDigest("b", 1, "o/r", broken).ok).toBe(false);
    const garbage = vi.fn(() => ({ status: 0, stderr: "", stdout: "not json" }));
    expect(postDigest("b", 1, "o/r", garbage).ok).toBe(false);
    expect(repoIsPrivate("o/r", ghPrivate(true))).toBe(true);
  });
  it("passes the body on stdin to gh issue comment", () => {
    const gh = ghPrivate();
    expect(postDigest("body", 12, "o/r", gh).ok).toBe(true);
    expect(gh).toHaveBeenCalledWith(["issue", "comment", "12", "--repo", "o/r", "--body-file", "-"], "body");
  });
  it("fails soft when gh is missing", () => {
    const err = Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" });
    const r = postDigest("b", 1, "o/r", (args) =>
      args[0] === "repo"
        ? { status: 0, stderr: "", stdout: '{"isPrivate":true}' }
        : { status: null, stderr: "", error: err },
    );
    expect(r).toEqual({ ok: false, message: "gh is not on PATH — digest not posted" });
  });
});

const cand = (id: string): DogfoodCandidateWire => ({
  id,
  text: `record ${id}`,
  record_quote: "rq",
  quote: "the PR merged yesterday",
  code_session_id: "s1",
  turn_idx: 3,
  contradicted_at: "2026-10-09T00:00:00Z",
});

describe("appendCandidates", () => {
  it("appends and dedupes by record id", () => {
    const path = join(mkdtempSync(join(tmpdir(), "dogfood-")), "candidates.json");
    expect(appendCandidates(path, [cand("a"), cand("b"), cand("a")], "https://m")).toBe(2);
    expect(appendCandidates(path, [cand("b"), cand("c")], "https://m")).toBe(1);
    const rows = JSON.parse(readFileSync(path, "utf8"));
    expect(rows.map((r: { id: string }) => r.id)).toEqual(["a", "b", "c"]);
    expect(rows[0].session_link).toBe("https://m/code/session/s1?turn=3#turn-3");
  });
  it("never writes the frozen bench file, by its real path, and refuses relative paths", () => {
    const root = mkdtempSync(join(tmpdir(), "dogfood-bench-"));
    const benchDir = join(root, "repo", "scripts", "eval", "recall-precision");
    mkdirSync(benchDir, { recursive: true });
    writeFileSync(join(benchDir, "bench.json"), "[]");
    expect(isFrozenBenchPath(join(benchDir, "bench.json"))).toBe(true);
    expect(isFrozenBenchPath("/elsewhere/recall-precision/bench.json")).toBe(true);
    // A symlink to the bench file is caught through realpath.
    symlinkSync(join(benchDir, "bench.json"), join(root, "cands.json"));
    expect(isFrozenBenchPath(join(root, "cands.json"))).toBe(true);
    expect(() => appendCandidates(join(root, "cands.json"), [cand("a")], "m")).toThrow(/frozen bench/);
    // Names alone no longer trip it.
    expect(isFrozenBenchPath(join(root, "bench-candidates.json"))).toBe(false);
    expect(isFrozenBenchPath(join(root, "bench.json"))).toBe(false);
    expect(() => appendCandidates("cands.json", [cand("a")], "m")).toThrow(/absolute/);
  });
});

describe("config + weekly guard", () => {
  it("reads dogfood keys and drops bad ones", () => {
    const dir = mkdtempSync(join(tmpdir(), "dogfood-cfg-"));
    const p = join(dir, "config.json");
    writeFileSync(p, JSON.stringify({ dogfood: { issue: 7, repo: "o/r", candidatesPath: "/c.json" } }));
    expect(readDogfoodConfig(p)).toEqual({ issue: 7, repo: "o/r", candidatesPath: "/c.json" });
    writeFileSync(p, JSON.stringify({ dogfood: { issue: "x", repo: "bad repo" } }));
    expect(readDogfoodConfig(p)).toEqual({});
  });

  it("runs at most once per ISO week and is off when unset", async () => {
    const now = new Date("2026-10-08T10:00:00Z");
    const gh = ghPrivate();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(wire), { status: 200 })) as unknown as typeof fetch;
    const base = { config, now, log: () => {}, gh, fetch: { fetchImpl } };
    expect(await runWeeklyDogfood({ ...base, dogfood: {}, lastWeek: undefined })).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
    const on = { issue: 3, repo: "o/r" };
    expect(await runWeeklyDogfood({ ...base, dogfood: on, lastWeek: isoWeek(now) })).toBeUndefined();
    expect(gh).not.toHaveBeenCalled();
    expect(await runWeeklyDogfood({ ...base, dogfood: on, lastWeek: "2026-W40" })).toBe("2026-W41");
    expect(commentCalls(gh)).toBe(1);
  });

  it("records the week once the digest posted, even when the candidates step throws", async () => {
    const gh = ghPrivate();
    const fetchImpl = vi.fn(async (url: string | URL) =>
      String(url).includes("view=candidates")
        ? new Response(JSON.stringify({ candidates: [cand("a")] }), { status: 200 })
        : new Response(JSON.stringify(wire), { status: 200 }),
    ) as unknown as typeof fetch;
    const dir = mkdtempSync(join(tmpdir(), "dogfood-throw-"));
    const notArray = join(dir, "c.json");
    writeFileSync(notArray, "{}"); // appendCandidates throws: not a JSON array
    const log = vi.fn();
    const week = await runWeeklyDogfood({
      config,
      now: new Date("2026-10-08T10:00:00Z"),
      log,
      gh,
      dogfood: { issue: 3, repo: "o/r", candidatesPath: notArray },
      lastWeek: "2026-W40",
      fetch: { fetchImpl },
    });
    expect(commentCalls(gh)).toBe(1);
    expect(week).toBe("2026-W41");
    expect(log.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(/candidates failed/);
  });

  it("fetches candidates since the last run, or 14 days on the first", () => {
    const now = new Date("2026-10-08T10:00:00Z"); // Thursday of 2026-W41
    expect(candidateWindowDays(undefined, now)).toBe(14);
    expect(candidateWindowDays("2026-W40", now)).toBe(11); // Monday 2026-09-28, 10.4 days
    expect(candidateWindowDays("2026-W41", now)).toBe(7);
    expect(candidateWindowDays("2025-W01", now)).toBe(90);
  });

  it("does not mark the week when the server cannot be read", async () => {
    const f404 = vi.fn(async () => new Response("nf", { status: 404 })) as unknown as typeof fetch;
    const week = await runWeeklyDogfood({
      config,
      now: new Date(),
      log: () => {},
      dogfood: { issue: 3, repo: "o/r" },
      lastWeek: undefined,
      fetch: { fetchImpl: f404 },
    });
    expect(week).toBeUndefined();
  });
});
