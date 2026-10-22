import { beforeEach, describe, expect, it, vi } from "vitest";
import { backoffMultiplier } from "@/lib/llm/retry";
import { currentEmbedBackoffMs, EMBED_BREAKER_FAILURES, embedBackoffDeps, resetEmbedBackoff } from "../embed";
import { buildRawUnits, computeSourceHash, UNITS_VERSION } from "../units";
import { CHUNK_BYTES, chunkRows, ensureSessionRawUnits, resetRawUnitsCaches, sweepSessionRawUnits } from "../write";
import { fakeEmbedder, makeUnitsDb, SESSION, seedTurns, TURNS, USER, vectorOf } from "./helpers";

const run = (u: ReturnType<typeof makeUnitsDb>, turns = TURNS, embedder = fakeEmbedder()) =>
  // biome-ignore lint/suspicious/noExplicitAny: fake client
  ensureSessionRawUnits(u.client as any, USER, SESSION, turns, { embedder });

describe("ensureSessionRawUnits", () => {
  const realDeps = { ...embedBackoffDeps };
  let slept: number[] = [];
  let clock = 1_000_000;
  beforeEach(() => {
    resetRawUnitsCaches();
    resetEmbedBackoff();
    slept = [];
    clock = 1_000_000;
    embedBackoffDeps.now = () => clock;
    embedBackoffDeps.random = () => 0;
    embedBackoffDeps.sleep = async (ms) => {
      slept.push(ms);
      clock += ms;
    };
    return () => Object.assign(embedBackoffDeps, realDeps);
  });

  it("writes every unit with a nomic-prefixed, versioned, non-zero vector", async () => {
    const u = makeUnitsDb();
    const e = fakeEmbedder();
    const r = await run(u, TURNS, e);
    expect(r.status).toBe("written");
    const rows = u.rows();
    expect(rows).toHaveLength(buildRawUnits(TURNS).length);
    for (const row of rows) {
      expect(row.embedding_model).toBe("nomic-embed-text+doc-v1");
      expect(row.embedding_failed_at).toBeNull();
      expect(row.source_hash).toBe(computeSourceHash(TURNS));
      expect(row.units_version).toBe(UNITS_VERSION);
      expect(vectorOf(row).some((n) => n !== 0)).toBe(true);
    }
    expect(e.calls.flat().every((s) => s.startsWith("search_document: "))).toBe(true);
  });

  it("is a no-op when nothing changed (no embed call, no rpc)", async () => {
    const u = makeUnitsDb();
    await run(u);
    const e = fakeEmbedder();
    const before = u.rpcCalls.length;
    const r = await run(u, TURNS, e);
    expect(r.status).toBe("current");
    expect(e.calls).toHaveLength(0);
    expect(u.rpcCalls).toHaveLength(before);
  });

  it("regenerates on change, re-embedding only new texts", async () => {
    const u = makeUnitsDb();
    await run(u);
    const idsBefore = u.rows().map((r) => r.id);
    const grown = [...TURNS, { idx: 3, role: "user", kind: "prose", text: "Now add a unit test for the retry." }];
    const e = fakeEmbedder();
    const r = await run(u, grown, e);
    expect(r.status).toBe("written");
    expect(r.reused).toBeGreaterThan(0);
    expect(e.calls.flat().length).toBe(r.embedded);
    expect(u.rows()).toHaveLength(buildRawUnits(grown).length);
    expect(u.rows().every((row) => row.source_hash === computeSourceHash(grown))).toBe(true);
    expect(u.rows().some((row) => idsBefore.includes(row.id))).toBe(false);
  });

  it("embed failure stores a null vector and a failed marker, never a zero vector", async () => {
    const u = makeUnitsDb();
    const e = fakeEmbedder();
    e.failing = true;
    const r = await run(u, TURNS, e);
    expect(r.status).toBe("written");
    expect(r.unembedded).toBe(u.rows().length);
    for (const row of u.rows()) {
      expect(row.embedding).toBeNull();
      expect(row.embedding_model).toBeNull();
      expect(row.embedding_failed_at).not.toBeNull();
    }
  });

  it("no provider (embedder null) also stores null vectors", async () => {
    const u = makeUnitsDb();
    // biome-ignore lint/suspicious/noExplicitAny: fake client
    await ensureSessionRawUnits(u.client as any, USER, SESSION, TURNS, { embedder: null, family: "nomic-embed-text" });
    expect(u.rows().every((r) => r.embedding === null && r.embedding_failed_at)).toBe(true);
  });

  it("retries failed embeddings only after the retry window, judged by the database", async () => {
    const u = makeUnitsDb();
    const bad = fakeEmbedder();
    bad.failing = true;
    await run(u, TURNS, bad);
    const good = fakeEmbedder();
    expect((await run(u, TURNS, good)).status).toBe("current"); // inside the window
    expect(good.calls).toHaveLength(0);
    u.ageFailures(16 * 60 * 1000);
    expect((await run(u, TURNS, good)).status).toBe("written");
    expect(u.rows().every((row) => row.embedding && !row.embedding_failed_at)).toBe(true);
  });

  it("a repeated failure refreshes the marker instead of rewriting the rows", async () => {
    const u = makeUnitsDb();
    const bad = fakeEmbedder();
    bad.failing = true;
    await run(u, TURNS, bad);
    const ids = u.rows().map((r) => r.id);
    u.ageFailures(16 * 60 * 1000);
    const r = await run(u, TURNS, bad);
    expect(r.status).toBe("current"); // the rpc answered -1
    expect(u.rows().map((x) => x.id)).toEqual(ids);
    expect(Date.now() - Date.parse(String(u.rows()[0].embedding_failed_at))).toBeLessThan(60_000);
    expect((await run(u, TURNS, fakeEmbedder())).status).toBe("current"); // and the next import waits again
  });

  it("an rpc failure keeps the paid vectors: the retry after the backoff does not embed again", async () => {
    const u = makeUnitsDb();
    const e = fakeEmbedder();
    u.failReplace("boom");
    expect((await run(u, TURNS, e)).status).toBe("failed");
    const embedCalls = e.calls.length;
    expect((await run(u, TURNS, e)).status).toBe("failed"); // inside the backoff: no work at all
    expect(e.calls).toHaveLength(embedCalls);
    u.failReplace(null);
    // biome-ignore lint/suspicious/noExplicitAny: fake client
    const r = await ensureSessionRawUnits(u.client as any, USER, SESSION, TURNS, {
      embedder: e,
      now: () => Date.now() + 16 * 60 * 1000,
    });
    expect(r.status).toBe("written");
    expect(e.calls).toHaveLength(embedCalls); // vectors came from the cache
    expect(u.rows().every((row) => row.embedding)).toBe(true);
  });

  const huge = Array.from({ length: 60 }, (_, i) => ({
    idx: i,
    role: "user",
    kind: "prose",
    text: `turn ${i} ${"word ".repeat(6000)}`,
  }));
  const estimate = (turns: typeof huge) =>
    chunkRows(buildRawUnits(turns), Number.MAX_SAFE_INTEGER).length === 1
      ? buildRawUnits(turns).reduce((n, x) => n + Buffer.byteLength(x.text) + 40_000, 0)
      : 0;

  it("a session far over one rpc's payload stores ALL units, in bounded staged chunks and one commit", async () => {
    const u = makeUnitsDb();
    expect(estimate(huge)).toBeGreaterThan(32 * 1024 * 1024);
    const r = await run(u, huge, fakeEmbedder());
    expect(r.status).toBe("written");
    expect(r.chunks).toBeGreaterThan(1);
    expect(u.rows()).toHaveLength(buildRawUnits(huge).length);
    expect(r.units).toBe(buildRawUnits(huge).length);
    expect(u.rows()[0].source_hash).toBe(computeSourceHash(huge));
    expect(u.staged()).toHaveLength(0);
    const stages = u.chunkCalls.filter(([k]) => k === "stage");
    expect(u.chunkCalls.at(-1)?.[0]).toBe("commit");
    for (const [, a] of stages) {
      const rows = a.p_rows as Array<{ text: string }>;
      const bytes = rows.reduce((n, x) => n + Buffer.byteLength(x.text) + 40_000, 0);
      expect(bytes).toBeLessThanOrEqual(CHUNK_BYTES * 1.6); // estimate bound (texts + vectors), not the exact figure
    }
    expect((await run(u, huge, fakeEmbedder())).status).toBe("current"); // no rewrite loop
  });

  it("an interruption between chunks leaves the old units visible and no staged row readable; the retry completes without re-embedding", async () => {
    const u = makeUnitsDb();
    await run(u); // old units
    const old = JSON.stringify(u.rows());
    const e = fakeEmbedder();
    u.failStageOnCall(2);
    const r = await run(u, huge, e);
    expect(r.status).toBe("failed");
    expect(JSON.stringify(u.rows())).toBe(old); // readers: exactly the old units
    expect(u.staged().length).toBeGreaterThan(0); // only orphans, in the stage table
    const embedCalls = e.calls.length;
    u.failStageOnCall(null);
    // biome-ignore lint/suspicious/noExplicitAny: fake client
    const again = await ensureSessionRawUnits(u.client as any, USER, SESSION, huge, {
      embedder: e,
      now: () => Date.now() + 16 * 60 * 1000,
    });
    expect(again.status).toBe("written");
    expect(e.calls).toHaveLength(embedCalls); // vectors came from the cache
    expect(u.rows()).toHaveLength(buildRawUnits(huge).length);
    expect(u.staged()).toHaveLength(0); // commit also collected the orphans
  });

  it("an incomplete commit (-3) is a failure, never 'current'; the old units stay", async () => {
    const u = makeUnitsDb();
    await run(u);
    const old = JSON.stringify(u.rows());
    const real = (u.client as { rpc: (n: string, a: Record<string, unknown>) => unknown }).rpc;
    (u.client as { rpc: unknown }).rpc = (n: string, a: Record<string, unknown>) => {
      if (n === "stage_session_raw_units" && u.staged().length > 0) {
        u.staged().length = 0; // a second writer's commit wiped our staged rows
      }
      return real(n, a);
    };
    const r = await run(u, huge, fakeEmbedder());
    expect(r.status).toBe("failed");
    expect(JSON.stringify(u.rows())).toBe(old);
  });

  it("a commit whose staged embeds failed never overwrites stored good vectors (-1); a changed text still does", async () => {
    const u = makeUnitsDb();
    await run(u);
    const stored = u.rows().map((r) => ({ ...r }));
    const rpc = (u.client as { rpc: (n: string, a: Record<string, unknown>) => Promise<{ data: unknown }> }).rpc;
    const stageAndCommit = async (runId: string, mutate: (r: Record<string, unknown>) => void) => {
      const rows = stored.map((r) => {
        const { id: _i, embedding_failed_at: _f, ...rest } = r;
        const copy = { ...rest, embedding: null, embedding_failed: true } as Record<string, unknown>;
        mutate(copy);
        return copy;
      });
      await rpc.call(u.client, "stage_session_raw_units", {
        p_user_id: USER,
        p_code_session_id: SESSION,
        p_run_id: runId,
        p_rows: rows,
      });
      return (
        await rpc.call(u.client, "commit_session_raw_units", {
          p_user_id: USER,
          p_code_session_id: SESSION,
          p_run_id: runId,
          p_expected_count: rows.length,
          p_source_hash: stored[0].source_hash,
          p_units_version: stored[0].units_version,
          p_content_hash: "h",
        })
      ).data;
    };
    expect(await stageAndCommit("r1", () => {})).toBe(-1);
    expect(u.rows().every((r) => r.embedding)).toBe(true); // vectors kept
    expect(u.staged()).toHaveLength(0); // stage cleared
    expect(await stageAndCommit("r2", (r) => (r.text_hash = "changed"))).toBe(stored.length);
    expect(u.rows().every((r) => r.embedding === null)).toBe(true); // a real change is promoted, null vector
  });

  it("without a contentHash the writer reads the stored one: sentinel skips, otherwise it is passed to the rpc", async () => {
    const u = makeUnitsDb();
    // biome-ignore lint/suspicious/noExplicitAny: fake client
    const call = () => ensureSessionRawUnits(u.client as any, USER, SESSION, TURNS, { embedder: fakeEmbedder() });
    u.db.getRows("code_sessions")[0].content_hash = "";
    expect((await call()).status).toBe("superseded");
    expect(u.rpcCalls).toHaveLength(0);
    u.db.getRows("code_sessions")[0].content_hash = "h";
    expect((await call()).status).toBe("written");
    expect(u.rpcCalls[0].p_content_hash).toBe("h");
    u.db.getRows("code_sessions")[0].content_hash = "changed"; // moved on after the read: the rpc guard would -2
    // biome-ignore lint/suspicious/noExplicitAny: fake client
    const explicit = await ensureSessionRawUnits(
      u.client as any,
      USER,
      SESSION,
      [...TURNS, { idx: 9, role: "user", kind: "prose", text: "more" }],
      {
        embedder: fakeEmbedder(),
        contentHash: "h",
      },
    );
    expect(explicit.status).toBe("superseded");
  });

  it("a superseded chunked write (content hash changed) stores nothing", async () => {
    const u = makeUnitsDb();
    // biome-ignore lint/suspicious/noExplicitAny: fake client
    const r = await ensureSessionRawUnits(u.client as any, USER, SESSION, huge, {
      embedder: fakeEmbedder(),
      contentHash: "older-hash",
    });
    expect(r.status).toBe("superseded");
    expect(u.rows()).toHaveLength(0);
    expect(u.staged()).toHaveLength(0);
  });

  it("a growing large session is rewritten whole with the new turns", async () => {
    const u = makeUnitsDb();
    await run(u, huge);
    const more = [...huge, { idx: 60, role: "user", kind: "prose", text: `turn 60 ${"word ".repeat(6000)}` }];
    const r = await run(u, more);
    expect(r.status).toBe("written");
    expect(u.rows()).toHaveLength(buildRawUnits(more).length);
  });

  it("a session just under the caps is written", async () => {
    const u = makeUnitsDb();
    const turns = Array.from({ length: 150 }, (_, i) => ({
      idx: i,
      role: "user",
      kind: "prose",
      text: `turn ${i} ${"word ".repeat(40)}`,
    }));
    expect((await run(u, turns)).status).toBe("written");
  });

  it("one breaker across batches: an outage costs EMBED_BREAKER_FAILURES calls, no per-text retries", async () => {
    const u = makeUnitsDb();
    const turns = Array.from({ length: 450 }, (_, i) => ({
      idx: i,
      role: "user",
      kind: "prose",
      text: `unique turn ${i} ${"w ".repeat(30)}`,
    }));
    const e = fakeEmbedder();
    e.failing = true;
    const r = await run(u, turns, e);
    expect(r.status).toBe("written");
    expect(e.calls).toHaveLength(EMBED_BREAKER_FAILURES);
    expect(u.rows().every((x) => x.embedding === null)).toBe(true);
  });

  const turns300 = Array.from({ length: 300 }, (_, i) => ({
    idx: i,
    role: "user",
    kind: "prose",
    text: `unique turn ${i} ${"w ".repeat(30)}`,
  }));
  const limited = (e: ReturnType<typeof fakeEmbedder>) => {
    e.embedBatch = async (t) => {
      e.calls.push(t);
      throw Object.assign(new Error("rate limited"), { status: 429 });
    };
  };

  it("a 429 is never retried immediately: the retry waits, and a second 429 stops the run", async () => {
    const u = makeUnitsDb();
    const e = fakeEmbedder();
    limited(e);
    await run(u, turns300, e);
    expect(e.calls).toHaveLength(2); // one attempt, one paced retry, then the run's breaker
    expect(slept.length).toBeGreaterThan(0);
    expect(slept[0]).toBeGreaterThanOrEqual(1000);
  });

  it("the delay grows proportionally on 429s (bigger multiplier at small delay) and decays 0.9x on success, no reset", async () => {
    const u = makeUnitsDb();
    const e = fakeEmbedder();
    limited(e);
    await run(u, turns300, e);
    const afterOne = currentEmbedBackoffMs();
    expect(afterOne).toBeGreaterThan(1000);
    resetRawUnitsCaches();
    await run(makeUnitsDb(), turns300, e);
    const afterTwo = currentEmbedBackoffMs();
    expect(afterTwo).toBeGreaterThan(afterOne);
    expect(afterTwo / afterOne).toBeLessThan(afterOne / 1000 + 0.001 + 4); // growth factor shrinks as delay grows
    const ok = fakeEmbedder();
    await run(makeUnitsDb(), TURNS, ok);
    const afterOk = currentEmbedBackoffMs();
    expect(afterOk).toBeCloseTo(afterTwo * 0.9, 5);
    expect(afterOk).toBeGreaterThan(1000); // decayed, not reset
  });

  it("429 jitter is applied to the pause", async () => {
    embedBackoffDeps.random = () => 1;
    const e = fakeEmbedder();
    limited(e);
    await run(makeUnitsDb(), turns300, e);
    expect(slept[0]).toBeCloseTo(1250, 5);
  });

  it("a 429 landing inside an existing pause window does not grow the delay again", async () => {
    embedBackoffDeps.sleep = async (ms) => void slept.push(ms); // the clock stays put: the 2nd 429 is in-window
    const e = fakeEmbedder();
    limited(e);
    await run(makeUnitsDb(), turns300, e);
    expect(e.calls).toHaveLength(2);
    expect(currentEmbedBackoffMs()).toBeCloseTo(1000 * backoffMultiplier(1000), 5); // grown once, not twice
  });

  it("a Retry-After above the 60 s cap is honoured in full: the run gives up without sleeping it out", async () => {
    const e = fakeEmbedder();
    e.embedBatch = async (t) => {
      e.calls.push(t);
      throw Object.assign(new Error("rate limited"), { status: 429, headers: { "retry-after": "300" } });
    };
    await run(makeUnitsDb(), turns300, e);
    expect(e.calls).toHaveLength(1);
    expect(slept).toHaveLength(0);
    const other = fakeEmbedder();
    await run(makeUnitsDb(), TURNS, other);
    expect(other.calls).toHaveLength(0); // the shared pause (300 s) still blocks other runs
  });

  it("a 429 pauses every run in the process, not only the one that saw it", async () => {
    const limitedE = fakeEmbedder();
    limited(limitedE);
    await run(makeUnitsDb(), turns300, limitedE);
    slept = [];
    clock = 1_000_000; // back inside the pause window set by the 429
    const other = fakeEmbedder();
    const r = await run(makeUnitsDb(), TURNS, other);
    expect(r.status).toBe("written");
    expect(slept.length).toBeGreaterThan(0); // the unrelated run waited out the shared pause first
    expect(vi.isMockFunction(other.embedBatch)).toBe(false);
  });

  it("a superseded writer (the content hash changed under it) writes nothing", async () => {
    const u = makeUnitsDb();
    // biome-ignore lint/suspicious/noExplicitAny: fake client
    const r = await ensureSessionRawUnits(u.client as any, USER, SESSION, TURNS, {
      embedder: fakeEmbedder(),
      contentHash: "older-hash",
    });
    expect(r.status).toBe("superseded");
    expect(u.rows()).toHaveLength(0);
  });

  it("import order and sweep order agree: shuffled stored turns hash like the payload", async () => {
    const u = makeUnitsDb();
    await run(u, [...TURNS].reverse()); // payload order differs from idx order
    seedTurns(u.db, [...TURNS].reverse());
    // biome-ignore lint/suspicious/noExplicitAny: fake client
    const r = await sweepSessionRawUnits(u.client as any, USER, SESSION, { embedder: fakeEmbedder() });
    expect(r.status).toBe("current");
    expect(u.rows()[0].source_hash).toBe(computeSourceHash(TURNS));
  });

  it("turn rows carry turn_len in parts", async () => {
    const u = makeUnitsDb();
    await run(u);
    const t = u.rows().find((r) => r.unit === "turn");
    expect(t?.parts).toEqual({ turn_len: buildRawUnits(TURNS).find((x) => x.unit === "turn")?.turn_len });
  });

  it("an rpc failure returns failed, never throws, and leaves the old units", async () => {
    const u = makeUnitsDb();
    await run(u);
    const old = JSON.stringify(u.rows());
    u.failReplace("boom");
    const r = await run(u, [...TURNS, { idx: 3, role: "user", kind: "prose", text: "more" }]);
    expect(r.status).toBe("failed");
    expect(JSON.stringify(u.rows())).toBe(old);
  });

  it("a missing function (migration not applied) is a failed result, not a throw", async () => {
    const u = makeUnitsDb();
    u.failReplace("function public.replace_session_raw_units does not exist");
    expect((await run(u)).status).toBe("failed");
  });

  it("concurrent calls for one session leave exactly one set of rows", async () => {
    const u = makeUnitsDb();
    const results = await Promise.all([run(u), run(u), run(u)]);
    expect(results.map((r) => r.status).every((s) => s !== "failed")).toBe(true);
    expect(u.rows()).toHaveLength(buildRawUnits(TURNS).length);
  });

  it("a turn-less session with no units is current", async () => {
    const u = makeUnitsDb();
    expect((await run(u, [])).status).toBe("current");
  });
});

describe("sweepSessionRawUnits (repair entrypoint)", () => {
  beforeEach(resetRawUnitsCaches);

  it("rebuilds units from the stored turns, e.g. after a crash between turns and units", async () => {
    const u = makeUnitsDb();
    seedTurns(u.db, TURNS);
    // biome-ignore lint/suspicious/noExplicitAny: fake client
    const r = await sweepSessionRawUnits(u.client as any, USER, SESSION, { embedder: fakeEmbedder() });
    expect(r.status).toBe("written");
    expect(u.rows()).toHaveLength(buildRawUnits(TURNS).length);
    // biome-ignore lint/suspicious/noExplicitAny: fake client
    expect((await sweepSessionRawUnits(u.client as any, USER, SESSION, { embedder: fakeEmbedder() })).status).toBe(
      "current",
    );
  });

  it("skips a session whose content_hash is still the pending sentinel, and reads the hash before the turns", async () => {
    const u = makeUnitsDb();
    seedTurns(u.db, TURNS);
    u.db.getRows("code_sessions")[0].content_hash = "";
    // biome-ignore lint/suspicious/noExplicitAny: fake client
    const r = await sweepSessionRawUnits(u.client as any, USER, SESSION, { embedder: fakeEmbedder() });
    expect(r.status).toBe("superseded");
    expect(u.rpcCalls).toHaveLength(0);
    expect(u.rows()).toHaveLength(0);
  });

  it("passes the stored content_hash to the rpc as p_content_hash", async () => {
    const u = makeUnitsDb();
    seedTurns(u.db, TURNS);
    // biome-ignore lint/suspicious/noExplicitAny: fake client
    await sweepSessionRawUnits(u.client as any, USER, SESSION, { embedder: fakeEmbedder() });
    expect(u.rpcCalls[0].p_content_hash).toBe("h");
  });
});
