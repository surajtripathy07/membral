import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "@membral/test-kit";
import { resetEmbedBackoff } from "../../../src/lib/memory/raw-units/embed";
import { sweepSessionRawUnits, resetRawUnitsCaches } from "../../../src/lib/memory/raw-units/write";
import {
  fakeEmbedder,
  withUnitsRpc,
  USER,
} from "../../../src/lib/memory/raw-units/__tests__/helpers";
import {
  type Args,
  checkDbTarget,
  checkDisk,
  checkProvider,
  freeBytesOf,
  OUTAGE_SESSIONS,
  USAGE,
  formatSummary,
  parseArgs,
  redactUrl,
  run,
  syntheticUnitTexts,
} from "../backfill-raw-units";

const TURNS = [
  { idx: 0, role: "user", kind: "prose", text: "Add a retry to the CodeHub sync client." },
  { idx: 1, role: "assistant", kind: "tool_use", text: "Read src/sync/client.ts" },
  { idx: 2, role: "assistant", kind: "prose", text: "Done: sync() now retries three times." },
];

function seed(db: FakeSupabase, id: string, startedAt: string | null, hash: string, withTurns = true) {
  db.getRows("code_sessions").push({ id, user_id: USER, code_project_id: "p", content_hash: hash, started_at: startedAt });
  if (withTurns)
    for (const t of TURNS)
      db.getRows("code_session_turns").push({
        id: `${id}-${t.idx}`,
        user_id: USER,
        session_id: id,
        idx: t.idx,
        role: t.role,
        kind: t.kind,
        text: `${t.text} (${id})`,
      });
}

function store() {
    const u = withUnitsRpc(new FakeSupabase());
  seed(u.db, "s-new", "2026-10-05T00:00:00Z", "h1");
  seed(u.db, "s-cur", "2026-10-04T00:00:00Z", "h2");
  seed(u.db, "s-sent", "2026-10-03T00:00:00Z", "");
  seed(u.db, "s-none", "2026-10-02T00:00:00Z", "h4", false);
  seed(u.db, "s-old", "2026-09-01T00:00:00Z", "h5");
  return u;
}

const args = (over: Partial<Args> = {}): Args => ({
  userId: USER,
  apply: false,
  limit: undefined,
  since: undefined,
  sessionId: undefined,
  concurrency: 1,
  maxSeconds: undefined,
  json: false,
  allowHosted: false,
  allowHostedDb: false,
  benchEmbed: undefined,
  help: false,
  ...over,
});

// biome-ignore lint/suspicious/noExplicitAny: fake client
const asDb = (u: ReturnType<typeof withUnitsRpc>) => u.client as any;

beforeEach(() => {
  resetRawUnitsCaches();
  resetEmbedBackoff();
});

describe("parseArgs", () => {
  it("defaults to a dry run with concurrency 1", () => {
    const a = parseArgs(["--user", "u1"]) as Args;
    expect(a.apply).toBe(false);
    expect(a.concurrency).toBe(1);
    expect(a.userId).toBe("u1");
  });
  it("reads every flag", () => {
    const a = parseArgs([
      "--user", "u1", "--apply", "--limit", "5", "--since", "2026-09-18", "--session", "s1",
      "--concurrency", "2", "--max-seconds", "60", "--json", "--allow-hosted",
    ]) as Args;
    expect(a).toMatchObject({ apply: true, limit: 5, since: "2026-09-18", sessionId: "s1", concurrency: 2, maxSeconds: 60, json: true, allowHosted: true });
  });
  it("requires --user except for --bench-embed and --help", () => {
    expect(parseArgs([])).toHaveProperty("error");
    expect((parseArgs(["--bench-embed"]) as Args).benchEmbed).toBe(1000);
    expect((parseArgs(["--bench-embed", "50"]) as Args).benchEmbed).toBe(50);
    expect((parseArgs(["--help"]) as Args).help).toBe(true);
  });
  it("rejects bad numbers and dates", () => {
    expect(parseArgs(["--user", "u", "--limit", "x"])).toHaveProperty("error");
    expect(parseArgs(["--user", "u", "--since", "nope"])).toHaveProperty("error");
    expect(parseArgs(["--bench-embed", "0"])).toHaveProperty("error");
  });
  it("needs positive integers for --limit and --concurrency, and refuses a flag as a value", () => {
    expect(parseArgs(["--user", "u", "--limit", "0.5"])).toHaveProperty("error");
    expect(parseArgs(["--user", "u", "--limit", "0"])).toHaveProperty("error");
    expect(parseArgs(["--user", "u", "--concurrency", "1.5"])).toHaveProperty("error");
    expect(parseArgs(["--user", "u", "--concurrency", "2"])).toMatchObject({ concurrency: 2 });
    expect(parseArgs(["--user", "--apply"])).toHaveProperty("error");
    expect(parseArgs(["--user", "u", "--since", "--json"])).toHaveProperty("error");
    expect(parseArgs(["--user"])).toHaveProperty("error");
  });
  it("reads --allow-hosted-db and documents the PR 4 precondition and --limit in --help", () => {
    expect((parseArgs(["--user", "u", "--allow-hosted-db"]) as Args).allowHostedDb).toBe(true);
    expect(USAGE).toContain("Deferred to PR 4 precondition");
    expect(USAGE).toContain("search_document:");
    expect(USAGE).toContain("BEFORE classification");
  });
});

describe("dry run", () => {
  it("counts current / stale / sentinel / missing turns and writes nothing", async () => {
    const u = store();
    await sweepSessionRawUnits(asDb(u), USER, "s-cur", { embedder: fakeEmbedder() });
    const before = u.rows().length;
    const rpcBefore = u.rpcCalls.length;
    const e = fakeEmbedder();
    const s = await run(args(), { db: asDb(u), embedder: e });
    expect(s.mode).toBe("dry-run");
    expect(s).toMatchObject({ sessions_total: 5, current: 1, stale: 2, sentinel_skipped: 1, missing_turns: 1 });
    expect(s.est_units).toBeGreaterThan(0);
    expect(s.est_chars).toBeGreaterThan(0);
    expect(s.est_embedding_payload_bytes).toBeGreaterThan(s.est_chars); // prefix included
    expect(s.est_storage_bytes).toBeGreaterThan(s.est_units * 12 * 1024);
    expect(s.multi_chunk_sessions).toBe(0);
    expect(e.calls).toHaveLength(0);
    expect(u.rpcCalls).toHaveLength(rpcBefore);
    expect(u.rows()).toHaveLength(before);
    expect(formatSummary(s)).toContain("would write");
  });

  it("treats a changed session as stale and --since narrows the set", async () => {
    const u = store();
    await sweepSessionRawUnits(asDb(u), USER, "s-cur", { embedder: fakeEmbedder() });
    for (const r of u.db.getRows("code_session_turns")) if (r.session_id === "s-cur" && r.idx === 2) r.text = "changed";
    const all = await run(args(), { db: asDb(u), embedder: fakeEmbedder() });
    expect(all.current).toBe(0);
    expect(all.stale).toBe(3);
    const since = await run(args({ since: "2026-10-01" }), { db: asDb(u), embedder: fakeEmbedder() });
    expect(since.sessions_total).toBe(4);
  });

  it("--limit keeps the newest sessions; --session picks one", async () => {
    const u = store();
    const lim = await run(args({ limit: 2 }), { db: asDb(u), embedder: fakeEmbedder() });
    expect(lim).toMatchObject({ sessions_total: 2, stale: 2 }); // s-new, s-cur
    expect(lim.sessions_total).toBe(2);
    const one = await run(args({ sessionId: "s-old" }), { db: asDb(u), embedder: fakeEmbedder() });
    expect(one).toMatchObject({ sessions_total: 1, stale: 1 });
  });

  it("flags sessions that need multi-chunk staged writes", async () => {
    const u = store();
    u.db.setRows("code_session_turns", []);
    const big = "word ".repeat(1_000_000);
    // 2 MB of assistant prose per turn makes the full_text rows exceed the 8 MB chunk bound.
    for (let i = 0; i < 6; i++)
      u.db.getRows("code_session_turns").push({ id: `b${i}`, user_id: USER, session_id: "s-new", idx: i, role: "assistant", kind: "prose", text: `${i} ${big}` });
    const s = await run(args({ sessionId: "s-new" }), { db: asDb(u) });
    expect(s.multi_chunk_sessions).toBe(1);
    // ~4.4 s alone; the 12 MB fixture goes past the 5 s default under the parallel coverage run.
  }, 30_000);
});

describe("--apply", () => {
  it("sweeps stale sessions only, newest first, and a second run is a no-op", async () => {
    const u = store();
    await sweepSessionRawUnits(asDb(u), USER, "s-cur", { embedder: fakeEmbedder() });
    const sweep = vi.fn(sweepSessionRawUnits);
    const s = await run(args({ apply: true }), { db: asDb(u), embedder: fakeEmbedder(), sweep });
    expect(sweep.mock.calls.map((c) => c[2])).toEqual(["s-new", "s-old"]);
    expect(s).toMatchObject({ written: 2, failed: 0, stale: 2, current: 1, sentinel_skipped: 1, missing_turns: 1 });
    expect(new Set(u.rows().map((r) => r.code_session_id))).toEqual(new Set(["s-new", "s-cur", "s-old"]));
    const again = vi.fn(sweepSessionRawUnits);
    const s2 = await run(args({ apply: true }), { db: asDb(u), embedder: fakeEmbedder(), sweep: again });
    expect(again).not.toHaveBeenCalled();
    expect(s2).toMatchObject({ stale: 0, current: 3 });
  });

  it("--limit bounds the sessions swept", async () => {
    const u = store();
    const sweep = vi.fn(sweepSessionRawUnits);
    await run(args({ apply: true, limit: 1 }), { db: asDb(u), embedder: fakeEmbedder(), sweep });
    expect(sweep.mock.calls.map((c) => c[2])).toEqual(["s-new"]);
  });

  it("counts a failed sweep and keeps going", async () => {
    const u = store();
    const e = fakeEmbedder();
    u.failReplace("boom");
    const s = await run(args({ apply: true }), { db: asDb(u), embedder: e });
    expect(s.failed).toBe(3); // s-new, s-cur, s-old are all stale here
    expect(s.errors?.[0]).toContain("boom");
  });

  it("stops after 5 consecutive sessions that got no vector (embedding outage)", async () => {
    const u = withUnitsRpc(new FakeSupabase());
    for (let i = 0; i < 8; i++) seed(u.db, `o${i}`, `2026-10-0${i + 1}T00:00:00Z`, `h${i}`);
    const e = fakeEmbedder();
    e.failing = true;
    const sweep = vi.fn(sweepSessionRawUnits);
    const s = await run(args({ apply: true }), { db: asDb(u), embedder: e, sweep });
    expect(s.outage).toBe(true);
    expect(sweep).toHaveBeenCalledTimes(OUTAGE_SESSIONS);
    expect(s.stopped_early).toContain("embedding outage");
    expect(formatSummary(s)).toContain("outage");
  });

  it("stops taking sessions on Ctrl-C and on --max-seconds, then still summarises", async () => {
    const u = store();
    let n = 0;
    const sweep = vi.fn(sweepSessionRawUnits);
    const s = await run(args({ apply: true }), {
      db: asDb(u),
      embedder: fakeEmbedder(),
      sweep,
      stopRequested: () => (n++ >= 1 ? "interrupted" : null),
    });
    expect(sweep).toHaveBeenCalledTimes(1);
    expect(s.stopped_early).toBe("interrupted");
    expect(s.sessions_examined).toBe(1);

    let t = 0;
    const timed = await run(args({ maxSeconds: 10 }), { db: asDb(u), now: () => (t += 6000) });
    expect(timed.stopped_early).toContain("--max-seconds");
    expect(timed.sessions_examined).toBeLessThan(5);
  });
});

describe("dry run matches apply", () => {
  it("a session whose failed embeds are inside the 15-minute window is not stale; past it, it is", async () => {
    const u = withUnitsRpc(new FakeSupabase());
    seed(u.db, "s-fail", "2026-10-05T00:00:00Z", "h1");
    const e = fakeEmbedder();
    e.failing = true;
    await sweepSessionRawUnits(asDb(u), USER, "s-fail", { embedder: e });
    const recent = await run(args(), { db: asDb(u) });
    expect(recent.stale).toBe(0);
    expect(recent.current).toBe(1);
    const real = Date.now;
    Date.now = () => real() + 16 * 60 * 1000;
    try {
      const later = await run(args(), { db: asDb(u) });
      expect(later.stale).toBe(1);
    } finally {
      Date.now = real;
    }
  });

  it("prints the failed count and errors in a dry run too", async () => {
    const u = store();
    const db = asDb(u);
    const broken = { ...db, from: (t: string) => (t === "code_sessions" ? db.from(t) : { select: () => { throw new Error("read boom"); } }) };
    const s = await run(args(), { db: broken });
    expect(s.failed).toBeGreaterThan(0);
    expect(s.errors[0]).toContain("read boom");
    expect(formatSummary(s)).toContain("failed sessions");
    const clean = await run(args(), { db });
    expect(formatSummary(clean)).toContain("failed sessions:           0");
  });
});

describe("provider guard", () => {
  const local = { MEMBRAL_EMBEDDINGS_BASE_URL: "http://localhost:11434/v1", MEMBRAL_EMBEDDING_MODEL: "nomic-embed-text:latest" };
  it("accepts a loopback base URL", () => {
    expect(checkProvider(false, local)).toMatchObject({ ok: true, local: true });
  });
  it("refuses a hosted provider unless --allow-hosted", () => {
    const hosted = { OPENAI_API_KEY: "sk-test" };
    expect(checkProvider(false, hosted)).toMatchObject({ ok: false, local: false });
    expect(checkProvider(false, hosted).reason).toContain("--allow-hosted");
    expect(checkProvider(true, hosted).ok).toBe(true);
    const remote = { MEMBRAL_EMBEDDINGS_BASE_URL: "https://embeddings.example.com/v1" };
    expect(checkProvider(false, remote).ok).toBe(false);
  });
  it("refuses when no provider is configured, even with --allow-hosted", () => {
    expect(checkProvider(true, {}).ok).toBe(false);
  });
});

describe("database target guard", () => {
  const L = "http://127.0.0.1:54321";
  it("accepts loopback Supabase URLs", () => {
    for (const url of [L, "http://localhost:54321", "http://[::1]:54321", "http://host.docker.internal:54321"])
      expect(checkDbTarget(false, { NEXT_PUBLIC_SUPABASE_URL: url })).toMatchObject({ ok: true, local: true });
    expect(checkDbTarget(false, { NEXT_PUBLIC_SUPABASE_URL: L, SUPABASE_INTERNAL_URL: "http://localhost:8000" }).ok).toBe(true);
  });
  it("refuses a remote URL unless --allow-hosted-db, and a missing one always", () => {
    const hosted = { NEXT_PUBLIC_SUPABASE_URL: "https://abcdef.supabase.co" };
    const r = checkDbTarget(false, hosted);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("NEXT_PUBLIC_SUPABASE_URL");
    expect(r.reason).toContain("--allow-hosted-db");
    expect(checkDbTarget(true, hosted)).toMatchObject({ ok: true, local: false });
    expect(checkDbTarget(true, {}).ok).toBe(false);
  });
  it("refuses when the internal URL (the one the client uses) is hosted although the public one is local", () => {
    const r = checkDbTarget(false, { NEXT_PUBLIC_SUPABASE_URL: L, SUPABASE_INTERNAL_URL: "https://abcdef.supabase.co" });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("SUPABASE_INTERNAL_URL");
    // internal local but public hosted: effective is local yet the public variable still trips the guard
    const r2 = checkDbTarget(false, { NEXT_PUBLIC_SUPABASE_URL: "https://abcdef.supabase.co", SUPABASE_INTERNAL_URL: "http://gateway:8000" });
    expect(r2.ok).toBe(false);
  });
  it("--allow-hosted-db passes a hosted URL and the disk check is then skipped", () => {
    const t = checkDbTarget(true, { NEXT_PUBLIC_SUPABASE_URL: L, SUPABASE_INTERNAL_URL: "https://abcdef.supabase.co" });
    expect(t).toMatchObject({ ok: true, local: false });
    expect(checkDisk(1000, t.local, () => 0).note).toContain("skipped");
  });
  it("refuses an unparseable URL with a message, and prints URLs without credentials", () => {
    const r = checkDbTarget(false, { NEXT_PUBLIC_SUPABASE_URL: "not a url" });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("not a parseable URL");
    expect(redactUrl("https://user:secret@db.example.com/x")).not.toContain("secret");
    expect(redactUrl("https://user:secret@db.example.com/x")).not.toContain("user");
    const hosted = checkDbTarget(false, { NEXT_PUBLIC_SUPABASE_URL: "https://user:secret@db.example.com" });
    expect(`${hosted.reason}${hosted.url}`).not.toContain("secret");
  });
});

describe("free-disk preflight", () => {
  it("refuses when free space is under 1.5x the estimate", () => {
    const r = checkDisk(1000, true, () => 1400);
    expect(r.ok).toBe(false);
    expect(r.neededBytes).toBe(1500);
  });
  it("passes at or above 1.5x, and is skipped for a remote database", () => {
    expect(checkDisk(1000, true, () => 1500).ok).toBe(true);
    const skipped = checkDisk(1000, false, () => 0);
    expect(skipped).toMatchObject({ ok: true, skipped: true });
    expect(skipped.note).toContain("skipped");
  });
  it("reads real free bytes from the host disk", () => {
    expect(freeBytesOf(process.cwd())).toBeGreaterThan(0);
  });
});

describe("bench units", () => {
  it("produces N distinct synthetic texts from the fixtures", () => {
    const fx = JSON.parse(
      readFileSync(new URL("../../../src/lib/memory/raw-units/__tests__/fixtures/unit-fixtures.json", import.meta.url), "utf8"),
    );
    const texts = syntheticUnitTexts(700, fx);
    expect(texts).toHaveLength(700);
    expect(new Set(texts).size).toBe(700);
  });
});

describe("no LLM or chat client", () => {
  it("the script imports no chat, LLM or cost-guard module", () => {
    const src = readFileSync(new URL("../backfill-raw-units.ts", import.meta.url), "utf8");
    const imports = [...src.matchAll(/(?:from|import\()\s*["']([^"']+)["']/g)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(3);
    for (const spec of imports) {
      expect(spec).not.toMatch(/anthropic|openai$|kg\/llm|claude|cost-guard|chat|openrouter|llm\/client/i);
      expect(spec).not.toMatch(/kg\/queue/);
    }
  });
});
