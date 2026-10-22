import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGenerateEmbedding = vi.fn();
vi.mock("@/lib/embeddings", () => ({
  generateEmbedding: (...args: unknown[]) => mockGenerateEmbedding(...args),
  EmbeddingCeilingExceededError: class EmbeddingCeilingExceededError extends Error {},
}));
vi.mock("@/lib/feature-flags", () => ({
  FeatureDisabledError: class FeatureDisabledError extends Error {},
}));

import { makeMemoryFakeSupabase as makeFakeSupabase, type Row } from "@membral/test-kit";
import type { Db } from "@/lib/db/types";
import {
  buildPromptRecall,
  collapsePromptRecallDuplicates,
  loadPromptRecallFollowUps,
  PROMPT_RECALL_ALREADY_SENT_PREFIX,
  PROMPT_RECALL_FOLLOW_UP_PREFIX,
  PROMPT_RECALL_FOOTER_MAX_CHARS,
  PROMPT_RECALL_FOOTER_PREFIX,
  PROMPT_RECALL_HEADER,
  PROMPT_RECALL_LEGACY_MAX_RECORDS,
  PROMPT_RECALL_LINE_MAX_CEILING,
  PROMPT_RECALL_LINE_MAX_CHARS,
  PROMPT_RECALL_MAX_RECORDS,
  PROMPT_RECALL_RESEARCH_NOTE,
  PROMPT_RECALL_TOTAL_MAX_CHARS,
  pathsShare,
  promptSkipReason,
  relatedToServed,
  renderPromptRecallAlreadySent,
  renderPromptRecallBlock,
  renderPromptRecallFooter,
  renderPromptRecallLine,
  resolveLineMax,
  scaleTotal,
  titleTokens,
} from "../prompt-recall";
import type { ServedRecord } from "../verify";

const USER = "user-1";
const PROJECT = "proj-a";
const OTHER = "proj-b";
const NOW = new Date("2026-10-08T12:00:00Z");
const PROMPT =
  "src/legacy/ledger-sync.ts still calls the vendor API inline. Wrap it in the client helper and make sure tests pass.";

function rec(o: Partial<Row> & { id: string; text: string }): Row {
  const quote = `${o.text} -- said in review`;
  return {
    code_session_id: `abcd1234-${o.id}`,
    code_project_id: PROJECT,
    agent_id: null,
    source: "hook",
    kind: "decision",
    quote,
    turn_idx: 0,
    turn_role: "assistant",
    ref: null,
    ref_kind: null,
    branch: null,
    head_sha: null,
    thread: null,
    paths: [],
    verified: false,
    durable: true,
    observed_durable: false,
    recurrence_count: 1,
    scope: "project",
    confidence: 0.5,
    supersedes: null,
    retired_at: null,
    chat_conversation_id: null,
    created_at: "2026-10-06T12:00:00Z",
    similarity: 0.62,
    lex_hits: 4,
    query_lexemes: 12,
    leg_score: 0.02,
    ...o,
  };
}

const rpcCalls: Record<string, unknown>[] = [];
function setup(rows: Row[], turns: Row[] = rows, memories: Row[] = []) {
  return makeFakeSupabase(
    {
      session_memories: memories,
      code_projects: [
        { id: PROJECT, user_id: USER, display_name: null, repo_identity: "github.com/acme/app" },
        { id: OTHER, user_id: USER, display_name: null, repo_identity: "github.com/acme/other" },
      ],
      code_session_turns: turns.map((r) => ({ session_id: r.code_session_id, idx: 0, text: r.quote, props: {} })),
      memory_branch_state: [],
      conversations: [],
    },
    {
      rpc: {
        memory_search_scored: (args: Record<string, unknown>) => {
          rpcCalls.push(args);
          const data = rows.filter(
            (r) =>
              (!args.p_code_project_id || r.code_project_id === args.p_code_project_id) &&
              (!Array.isArray(args.p_kinds) || args.p_kinds.includes(r.kind)),
          );
          return { data: data.slice(0, args.p_limit as number), error: null };
        },
      },
    },
  );
}

beforeEach(() => {
  rpcCalls.length = 0;
  vi.stubEnv("OPENAI_API_KEY", "sk-test");
  // These tests count and order memory_search_scored calls; 0 turns the embed deadline (and its extra keyword-only call) off.
  // The deadline path is covered by search-embed-deadline.test.ts.
  vi.stubEnv("MEMBRAL_PROMPT_RECALL_EMBED_DEADLINE_MS", "0");
  mockGenerateEmbedding.mockReset();
  mockGenerateEmbedding.mockResolvedValue(new Array(1536).fill(0));
});

describe("promptSkipReason", () => {
  it("skips slash commands and prompts under four words", () => {
    expect(promptSkipReason("/review 12")).toBe("slash_command");
    expect(promptSkipReason("  /clear")).toBe("slash_command");
    expect(promptSkipReason("yes do it")).toBe("short_prompt");
    expect(promptSkipReason("convert the queue file now")).toBeNull();
  });
});

describe("renderPromptRecallLine", () => {
  const served = (o: Partial<ServedRecord>): ServedRecord =>
    ({
      id: "r",
      kind: "decision",
      text: "Keep src/legacy/ledger-sync.ts as the single inline-call exception",
      ref: "#157",
      session_id: "abcd1234-ffff",
      when: "2026-10-06T12:00:00Z",
      ...o,
    }) as ServedRecord;

  it("renders kind, age, short session id, text and ref", () => {
    expect(renderPromptRecallLine(served({}), NOW.getTime())).toBe(
      "[decision · as of 2026-10-06 · 2d ago · session abcd1234] Keep src/legacy/ledger-sync.ts as the single inline-call exception (#157)",
    );
  });

  it("does not repeat a ref the text already names", () => {
    expect(renderPromptRecallLine(served({ text: "Ruled on #157 today" }), NOW.getTime())).toMatch(/today$/);
  });

  // A record's text is ≤ 500 chars by schema (MEMORY_TEXT_MAX).
  const fullText =
    `${"Keep src/legacy/ledger-sync.ts calling the vendor API inline; ".repeat(4)}so converting it breaks the sync worker`
      .slice(0, 240)
      .trimEnd();

  it("keeps a 240-char text intact, with its ref and URL", () => {
    const url = "https://github.com/acme/codehub/issues/157";
    expect(fullText.length).toBeGreaterThan(230);
    const line = renderPromptRecallLine(served({ text: fullText, ref_url: url }), NOW.getTime());
    expect(line).toBe(`[decision · as of 2026-10-06 · 2d ago · session abcd1234] ${fullText} (#157) → ${url}`);
    expect(line.length).toBeLessThanOrEqual(PROMPT_RECALL_LINE_MAX_CHARS);
    expect(line).not.toContain("…");
  });

  it("ends with the ref's forge URL when known; over the cap it drops the URL, then the ref, never the text", () => {
    const url = "https://github.com/acme/codehub/issues/157";
    expect(renderPromptRecallLine(served({ ref_url: url }), NOW.getTime())).toBe(
      `[decision · as of 2026-10-06 · 2d ago · session abcd1234] Keep src/legacy/ledger-sync.ts as the single inline-call exception (#157) → ${url}`,
    );
    const huge = `https://github.com/acme/codehub/issues/${"9".repeat(600)}`;
    const noUrl = renderPromptRecallLine(served({ text: fullText, ref_url: huge }), NOW.getTime());
    expect(noUrl).toBe(`[decision · as of 2026-10-06 · 2d ago · session abcd1234] ${fullText} (#157)`);
    const hugeRef = `#${"9".repeat(600)}`;
    const noRef = renderPromptRecallLine(served({ text: fullText, ref: hugeRef, ref_url: huge }), NOW.getTime());
    expect(noRef).toBe(`[decision · as of 2026-10-06 · 2d ago · session abcd1234] ${fullText}`);
    expect(renderPromptRecallLine(served({ ref_url: null }), NOW.getTime())).not.toContain("→");
  });
});

describe("renderPromptRecallLine: the URL outranks the relative age", () => {
  it("a long text keeps its URL by dropping the age before the URL", () => {
    const url = "https://github.com/acme/codehub/issues/157";
    const r = {
      id: "r",
      kind: "decision",
      text: "y".repeat(610),
      ref: "#157",
      ref_url: url,
      session_id: "abcd1234-ffff-4fff-8fff-ffffffffffff",
      when: "2026-10-06T12:00:00Z",
    } as ServedRecord;
    // Size the text so the full head overflows the cap by one character and the age-less head just fits.
    const overhead = renderPromptRecallLine({ ...r, text: "y" }, NOW.getTime()).length - 1;
    r.text = "y".repeat(PROMPT_RECALL_LINE_MAX_CHARS - overhead + 1);
    const line = renderPromptRecallLine(r, NOW.getTime());
    expect(line.length).toBeLessThanOrEqual(PROMPT_RECALL_LINE_MAX_CHARS);
    expect(line).toContain(url);
    expect(line).toContain("as of 2026-10-06");
    expect(line).not.toContain("2d ago");
  });
});

describe("renderPromptRecallBlock", () => {
  const rec = (i: number, text: string): ServedRecord =>
    ({
      id: `r${i}`,
      kind: "decision",
      text,
      ref: `#${i}`,
      ref_url: `https://github.com/acme/codehub/issues/${i}`,
      session_id: `${i}bcd1234-ffff-4fff-8fff-ffffffffffff`,
      turn_idx: i,
      when: "2026-10-06T12:00:00Z",
    }) as ServedRecord;

  it("three full-length records stay under the total cap and far under Claude Code's 10,000", () => {
    const { lines, shown } = renderPromptRecallBlock(
      [1, 2, 3].map((i) => rec(i, "x".repeat(240))),
      NOW.getTime(),
    );
    expect(shown).toHaveLength(3);
    // Header, three records, the re-search note, the footer.
    expect(lines).toHaveLength(6);
    expect(lines[4]).toBe(PROMPT_RECALL_RESEARCH_NOTE);
    expect(lines[5].startsWith(PROMPT_RECALL_FOOTER_PREFIX)).toBe(true);
    expect(lines.join("\n").length).toBeLessThanOrEqual(PROMPT_RECALL_TOTAL_MAX_CHARS);
  });

  it("budget: at most five records and 3,000 chars, follow-ups counted; the last record and its follow-up drop first", () => {
    expect(PROMPT_RECALL_MAX_RECORDS).toBe(5);
    expect(PROMPT_RECALL_TOTAL_MAX_CHARS).toBe(3_000);
    const records = [1, 2, 3, 4, 5, 6].map((i) => rec(i, "x".repeat(240)));
    const followUps = new Map(records.map((r) => [r.id, { id: `f-${r.id}`, text: "y".repeat(400) }]));
    const { lines, shown, followUpIds } = renderPromptRecallBlock(
      records,
      NOW.getTime(),
      PROMPT_RECALL_TOTAL_MAX_CHARS,
      followUps,
    );
    expect(shown.length).toBeLessThan(5);
    expect(lines.join("\n").length).toBeLessThanOrEqual(PROMPT_RECALL_TOTAL_MAX_CHARS);
    expect(followUpIds).toEqual(shown.map((r) => `f-${r.id}`));
    const short = renderPromptRecallBlock(
      records.map((r) => ({ ...r, text: "short", ref_url: null })),
      NOW.getTime(),
    );
    expect(short.shown).toHaveLength(5);
    expect(short.lines.join("\n").length).toBeLessThanOrEqual(PROMPT_RECALL_TOTAL_MAX_CHARS);
    // A follow-up line is cut to 300 chars.
    const fu = lines.find((l) => l.startsWith(PROMPT_RECALL_FOLLOW_UP_PREFIX))!;
    expect(fu.length).toBe(300);
  });

  it("drops the third record when the block would pass the total cap", () => {
    const records = [1, 2, 3].map((i) => rec(i, "x".repeat(240)));
    const { lines, shown } = renderPromptRecallBlock(records, NOW.getTime(), 1_200);
    expect(shown.map((r) => r.id)).toEqual(["r1", "r2"]);
    expect(lines).toHaveLength(5);
  });
});

describe("collapsePromptRecallDuplicates", () => {
  const sr = (o: Partial<ServedRecord> & { id: string; text: string }): ServedRecord =>
    ({
      kind: "outcome",
      ref: null,
      session_id: `sess-${o.id}`,
      turn_idx: 1,
      when: "2026-10-05T12:00:00Z",
      ...o,
    }) as ServedRecord;

  it("groups same kind+ref whose texts also match, shows the newest in the best-ranked slot, with (seen in N sessions)", () => {
    const records = [
      sr({
        id: "a",
        ref: "#370",
        text: "PR #370 merged into main, closing issue #361 today",
        when: "2026-10-03T00:00:00Z",
      }),
      sr({ id: "other", ref: "#12", text: "Shipped the importer" }),
      sr({ id: "b", ref: "#370", text: "PR #370 merged into main, closing issue #361", when: "2026-10-05T00:00:00Z" }),
      sr({
        id: "c",
        ref: "#370",
        text: "PR #370 merged into main today, closing issue #361",
        when: "2026-10-04T00:00:00Z",
      }),
      sr({ id: "d", kind: "decision", ref: "#370", text: "PR #370 merged into main, closing issue #361" }),
    ];
    const out = collapsePromptRecallDuplicates(records);
    expect(out.records.map((r) => r.id)).toEqual(["b", "other", "d"]);
    expect(out.seenIn.get("b")).toBe(3);
    expect(out.seenIn.get("other")).toBe(1);
    const line = renderPromptRecallLine(out.records[0], NOW.getTime(), out.seenIn.get("b"));
    expect(line).toMatch(/closing issue #361 \(seen in 3 sessions\)$/);
    expect(renderPromptRecallLine(out.records[1], NOW.getTime(), 1)).not.toContain("seen in");
  });

  it("keeps the count of records rankAndServe already collapsed (seen_in), not just the members", () => {
    const out = collapsePromptRecallDuplicates([
      sr({ id: "a", ref: "#370", text: "PR #370 merged into main, closing issue #361", seen_in: 3 }),
      sr({ id: "b", ref: "#370", text: "PR #370 merged into main, closing issue #361", when: "2026-10-06T00:00:00Z" }),
    ]);
    expect(out.seenIn.get("b")).toBe(4);
  });

  it("a shared kind+ref alone never collapses: two different rulings on one PR stay two lines", () => {
    const records = [
      sr({ id: "a", kind: "decision", ref: "#370", text: "Keep PR #370 small: split the importer change out" }),
      sr({ id: "b", kind: "decision", ref: "#370", text: "PR #370 ships behind the flag, default off in prod" }),
    ];
    expect(collapsePromptRecallDuplicates(records).records.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("never collapses when number/identifier tokens differ, even at high Jaccard", () => {
    const short = [
      sr({ id: "a", text: "Migration 118 applied to prod" }),
      sr({ id: "b", text: "Migration 119 applied to prod" }),
    ];
    expect(collapsePromptRecallDuplicates(short).records.map((r) => r.id)).toEqual(["a", "b"]);
    const long = [
      sr({ id: "a", text: "Migration 118 applied to the hosted prod database after the backup finished" }),
      sr({ id: "b", text: "Migration 119 applied to the hosted prod database after the backup finished" }),
      sr({ id: "c", text: "Deployed dpl_abc123 to the hosted prod project after the backup finished" }),
      sr({ id: "d", text: "Deployed dpl_xyz789 to the hosted prod project after the backup finished" }),
      sr({ id: "e", text: "Reverted commit 4cf7aa0 on main after the build agents stopped" }),
      sr({ id: "f", text: "Reverted commit 6a9ef3e on main after the build agents stopped" }),
    ];
    expect(collapsePromptRecallDuplicates(long).records.map((r) => r.id)).toEqual(["a", "b", "c", "d", "e", "f"]);
  });

  it("never collapses texts under six tokens: enabled vs disabled stay separate", () => {
    const records = [
      sr({ id: "a", text: "cache enabled for /api/pulse" }),
      sr({ id: "b", text: "cache disabled for /api/pulse" }),
      sr({ id: "c", text: "cache enabled for /api/pulse" }),
    ];
    expect(collapsePromptRecallDuplicates(records).records.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("collapses ref-less records whose token sets have Jaccard >= 0.6, keeping the newest", () => {
    const records = [
      sr({ id: "x", text: "The import route now retries a 504 with backoff.", when: "2026-10-01T00:00:00Z" }),
      sr({ id: "y", text: "Import route retries 504 with backoff now", when: "2026-10-06T00:00:00Z" }),
      sr({ id: "z", text: "The queue worker reads env through accessors" }),
    ];
    const out = collapsePromptRecallDuplicates(records);
    expect(out.records.map((r) => r.id)).toEqual(["y", "z"]);
    expect(out.seenIn.get("y")).toBe(2);
  });
});

describe("renderPromptRecallFooter", () => {
  it("names each shown record's full session id and turn once, in order", () => {
    expect(
      renderPromptRecallFooter([
        { session_id: "aaaa-1", turn_idx: 4 },
        { session_id: "bbbb-2", turn_idx: 0 },
        { session_id: "aaaa-1", turn_idx: 4 },
        { session_id: "aaaa-1", turn_idx: 9 },
      ]),
    ).toBe(`${PROMPT_RECALL_FOOTER_PREFIX}id=aaaa-1 turn=4, id=bbbb-2 turn=0, id=aaaa-1 turn=9`);
    expect(renderPromptRecallFooter([])).toBeNull();
  });

  it("three full uuids fit under the CLI's 300-char cut; longer ids drop from the end behind …", () => {
    const uuid = (n: number) => `${String(n).repeat(8)}-1111-2222-3333-444444444444`;
    const three = renderPromptRecallFooter([1, 2, 3].map((n) => ({ session_id: uuid(n), turn_idx: 1234 })))!;
    expect(three.split("id=")).toHaveLength(4);
    expect(three.length).toBeLessThan(300);
    const long = (n: number) => `${String(n).repeat(80)}`;
    const cut = renderPromptRecallFooter([1, 2, 3].map((n) => ({ session_id: long(n), turn_idx: 7 })))!;
    expect(cut.endsWith(", …")).toBe(true);
    expect(cut.split("id=")).toHaveLength(3);
    expect(cut.length).toBeLessThanOrEqual(PROMPT_RECALL_FOOTER_MAX_CHARS);
  });
});

describe("buildPromptRecall", () => {
  /** What the current CLI sends as budget_ms; without it the route answers in the legacy shape. */
  const EXT = 4000;
  const generic = (i: number) =>
    rec({
      id: `env-${i}`,
      // No digit in the text: records differing by a number never collapse.
      text: `Cloud code reads env through the lib/env accessors, rule ${["one", "two", "three", "four"][i - 1]}`,
      leg_score: 2 / (60 + i),
    });
  const exception = rec({
    id: "queue",
    text: "Keep src/legacy/ledger-sync.ts as the single inline-call exception: #157 removes the ledger module",
    ref: "#157",
    leg_score: 1 / 70,
  });

  it("serves the header, collapsed records, note and footer, the ruling naming the prompt's file first", async () => {
    const rows = [generic(1), generic(2), generic(3), generic(4), exception];
    const out = await buildPromptRecall(
      setup(rows),
      USER,
      null,
      { prompt: PROMPT, repo: "github.com/acme/app", clientBudgetMs: EXT },
      { now: NOW },
    );
    expect(out.lines[0]).toBe(PROMPT_RECALL_HEADER);
    // Header, the ruling and the env rules collapsed into one line, the note, then the footer.
    expect(out.lines).toHaveLength(5);
    expect(out.record_ids[0]).toBe("queue");
    expect(out.lines[4]).toBe(
      `${PROMPT_RECALL_FOOTER_PREFIX}${out.record_ids.map((id) => `id=abcd1234-${id} turn=0`).join(", ")}`,
    );
    expect(out.lines.join("\n").length).toBeLessThan(10_000);
    expect(out.lines[1]).toContain("src/legacy/ledger-sync.ts");
  });

  describe("exclude_record_ids (already injected this session)", () => {
    // Distinct topics, so nothing collapses; descending score fixes the order r1..r7.
    const texts = [
      "Billing webhooks verify the signature before parsing the payload",
      "The nightly export job writes parquet files to the archive bucket",
      "Avatar uploads are resized on the edge and never stored at full size",
      "Search indexing batches at five hundred documents per flush",
      "Feature flags default to off in every preview deployment",
      "Session cookies rotate whenever the account role changes",
      "Invoice PDFs render in a worker so the request thread stays free",
    ];
    const many = () => texts.map((text, i) => rec({ id: `r${i + 1}`, text, leg_score: 1 / (60 + i) }));
    const call = (excludeRecordIds?: string[]) =>
      buildPromptRecall(
        setup(many()),
        USER,
        null,
        {
          prompt: PROMPT,
          repo: "github.com/acme/app",
          clientBudgetMs: EXT,
          ...(excludeRecordIds ? { excludeRecordIds } : {}),
        },
        { now: NOW },
      );

    it("without the field, serves the top five as before", async () => {
      expect((await call()).record_ids).toEqual(["r1", "r2", "r3", "r4", "r5"]);
    });

    it("applies the cap first: no refill, the fresh records render and one pointer line names the sent ones", async () => {
      const out = await call(["r1", "r3"]);
      expect(out.record_ids).toEqual(["r2", "r4", "r5"]);
      const pointer = out.lines.filter((l) => l.startsWith(PROMPT_RECALL_ALREADY_SENT_PREFIX));
      expect(pointer).toEqual([
        `${PROMPT_RECALL_ALREADY_SENT_PREFIX}${texts[0].slice(0, 59)}… (#r1), ${texts[2].slice(0, 59).trimEnd()}… (#r3)`,
      ]);
      // Header, three records, the pointer, the note, the footer; r6 and r7 never appear.
      expect(out.lines).toHaveLength(7);
      expect(out.lines[4]).toBe(pointer[0]);
      expect(out.lines.join("\n")).not.toContain(texts[5]);
      expect(out.lines.join("\n")).not.toContain(texts[6]);
      // Only the fresh records are in the footer.
      expect(out.lines[6]).not.toContain("abcd1234-r1 ");
    });

    it("all five top records excluded answers with no lines and skipped already_sent", async () => {
      const out = await call(["r1", "r2", "r3", "r4", "r5"]);
      expect(out.lines).toEqual([]);
      expect(out.record_ids).toEqual([]);
      expect(out.skipped).toBe("already_sent");
    });

    it("an excluded id outside the top five changes nothing", async () => {
      const plain = await call();
      const out = await call(["r7"]);
      expect(out.lines).toEqual(plain.lines);
      expect(out.record_ids).toEqual(plain.record_ids);
    });

    it("none excluded: no pointer line, same output with an empty list as without the field", async () => {
      const plain = await call();
      expect(plain.lines.some((l) => l.startsWith(PROMPT_RECALL_ALREADY_SENT_PREFIX))).toBe(false);
      expect((await call([])).lines).toEqual(plain.lines);
    });
  });

  describe("renderPromptRecallAlreadySent", () => {
    const mk = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ id: `id${i}-0000-1111`, text: `Record ${i} ${"word ".repeat(30)}` }));

    it("caps at five entries, cuts titles to 60 chars and names ids by their first eight characters", () => {
      const line = renderPromptRecallAlreadySent(mk(8), 720) ?? "";
      expect(line.startsWith(PROMPT_RECALL_ALREADY_SENT_PREFIX)).toBe(true);
      expect(line.match(/\(#/g)).toHaveLength(5);
      expect(line).toContain("(#id0-0000)");
      expect(line).toContain("… (#id4-0000)");
      expect(line).not.toContain("id5-0000");
      for (const title of line.slice(PROMPT_RECALL_ALREADY_SENT_PREFIX.length).split(/ \(#[^)]*\)(?:, |$)/)) {
        expect(title.length).toBeLessThanOrEqual(60);
      }
    });

    it("drops entries from the end to stay within the line cap; null for none", () => {
      const line = renderPromptRecallAlreadySent(mk(5), 300) ?? "";
      expect(line.length).toBeLessThanOrEqual(300);
      expect(line.match(/\(#/g)?.length).toBeLessThan(5);
      expect(renderPromptRecallAlreadySent([], 300)).toBeNull();
    });
  });

  it("scopes the search to the caller's repo", async () => {
    const rows = [
      exception,
      rec({ id: "elsewhere", code_project_id: OTHER, text: "src/legacy/ledger-sync.ts elsewhere" }),
    ];
    const out = await buildPromptRecall(
      setup(rows),
      USER,
      null,
      { prompt: PROMPT, repo: "acme/app", clientBudgetMs: EXT },
      { now: NOW },
    );
    expect(rpcCalls[0].p_code_project_id).toBe(PROJECT);
    expect(out.record_ids).toEqual(["queue"]);
  });

  it("an unknown repo serves nothing and never searches every project", async () => {
    const out = await buildPromptRecall(setup([exception]), USER, null, {
      prompt: PROMPT,
      repo: "github.com/acme/nope",
    });
    expect(out).toMatchObject({ lines: [], record_ids: [], skipped: "unknown_repo" });
    expect(rpcCalls).toHaveLength(0);
  });

  it("nothing above the relevance floor -> no lines at all", async () => {
    const weak = [
      rec({ id: "weak", text: "sourdough hydration notes", similarity: 0.2, lex_hits: 1, query_lexemes: 12 }),
    ];
    const out = await buildPromptRecall(
      setup(weak),
      USER,
      null,
      { prompt: PROMPT, repo: "acme/app", clientBudgetMs: EXT },
      { now: NOW },
    );
    expect(out).toMatchObject({ lines: [], record_ids: [], skipped: "no_match" });
  });

  it("drops unverified records and blockers older than seven days", async () => {
    const rows = [
      rec({ id: "unverified", text: "src/legacy/ledger-sync.ts is fine as is" }),
      rec({
        id: "old-blocker",
        kind: "blocker",
        text: "src/legacy/ledger-sync.ts tests flake",
        created_at: "2026-09-20T00:00:00Z",
      }),
      exception,
    ];
    const turns = rows.filter((r) => r.id !== "unverified");
    const out = await buildPromptRecall(
      setup(rows, turns),
      USER,
      null,
      { prompt: PROMPT, repo: "acme/app", clientBudgetMs: EXT },
      { now: NOW },
    );
    expect(out.record_ids).toEqual(["queue"]);
  });

  it("skips short prompts and slash commands without a search", async () => {
    expect(
      (await buildPromptRecall(setup([exception]), USER, null, { prompt: "/clear", repo: "acme/app" })).skipped,
    ).toBe("slash_command");
    expect(
      (await buildPromptRecall(setup([exception]), USER, null, { prompt: "ok go", repo: "acme/app" })).skipped,
    ).toBe("short_prompt");
    expect(rpcCalls).toHaveLength(0);
  });

  const SESSION = "abcd1234-queue";
  const outcome = (o: Partial<Row> & { id: string; text: string }): Row =>
    // Shares the served ruling's ref: a follow-up is shown only when it shares a ref or a path with its record.
    rec({ user_id: USER, kind: "outcome", code_session_id: SESSION, verified: true, turn_idx: 5, ref: "#157", ...o });

  it("appends the latest later outcome of the served record's own session, and logs its id", async () => {
    const memories = [
      outcome({ id: "early", text: "Deployed an older build", turn_idx: 3 }),
      outcome({ id: "later", text: "Deployed main to prod after migrations 115-117", turn_idx: 9 }),
      outcome({ id: "retired", text: "Rolled back", turn_idx: 12, retired_at: "2026-10-07T00:00:00Z" }),
      outcome({ id: "unverified", text: "Maybe deployed", turn_idx: 11, verified: false }),
      outcome({ id: "elsewhere", text: "Another session's deploy", turn_idx: 20, code_session_id: "zzzz-other" }),
      outcome({ id: "other-user", text: "Not yours", turn_idx: 30, user_id: "user-2" }),
    ];
    const out = await buildPromptRecall(
      setup([{ ...exception, turn_idx: 2 }], undefined, memories),
      USER,
      null,
      { prompt: PROMPT, repo: "acme/app", clientBudgetMs: EXT },
      { now: NOW },
    );
    expect(out.lines[1]).toContain("src/legacy/ledger-sync.ts");
    expect(out.lines[2]).toBe(`${PROMPT_RECALL_FOLLOW_UP_PREFIX}Deployed main to prod after migrations 115-117`);
    expect(out.lines.at(-2)).toBe(PROMPT_RECALL_RESEARCH_NOTE);
    expect(out.lines.at(-1)?.startsWith(PROMPT_RECALL_FOOTER_PREFIX)).toBe(true);
    // Served records only; the follow-up's id is kept apart and not logged.
    expect(out.record_ids).toEqual(["queue"]);
    expect(out.followup_ids).toEqual(["later"]);
  });

  it("no follow-up when the session has no later outcome", async () => {
    // Same turn as the served record: not later.
    const memories = [outcome({ id: "before", text: "Earlier outcome", turn_idx: 0 })];
    const out = await buildPromptRecall(
      setup([exception], undefined, memories),
      USER,
      null,
      { prompt: PROMPT, repo: "acme/app", clientBudgetMs: EXT },
      { now: NOW },
    );
    expect(out.lines.some((l) => l.startsWith(PROMPT_RECALL_FOLLOW_UP_PREFIX))).toBe(false);
    expect(out.lines).toEqual([
      PROMPT_RECALL_HEADER,
      expect.stringContaining("src/legacy/ledger-sync.ts"),
      PROMPT_RECALL_RESEARCH_NOTE,
      expect.stringContaining(PROMPT_RECALL_FOOTER_PREFIX),
    ]);
    expect(out.record_ids).toEqual(["queue"]);
  });

  it("second hop: with slots left and a quick first search, a search on the served texts adds a new record", async () => {
    // Shares the hop-1 ruling's ref: hop 2 keeps only records related to what hop 1 served.
    const hopRow = rec({
      id: "hop",
      kind: "decision",
      text: "Deploy W3 to prod now",
      code_session_id: "a38e14cc-x",
      ref: "#157",
    });
    const db = makeFakeSupabase(
      {
        session_memories: [],
        code_projects: [{ id: PROJECT, user_id: USER, display_name: null, repo_identity: "github.com/acme/app" }],
        code_session_turns: [exception, hopRow].map((r) => ({
          session_id: r.code_session_id,
          idx: 0,
          text: r.quote,
          props: {},
        })),
        memory_branch_state: [],
        conversations: [],
      },
      {
        rpc: {
          memory_search_scored: (args: Record<string, unknown>) => {
            rpcCalls.push(args);
            return { data: rpcCalls.length === 1 ? [exception] : [exception, hopRow], error: null };
          },
        },
      },
    );
    const out = await buildPromptRecall(
      db,
      USER,
      null,
      { prompt: PROMPT, repo: "acme/app", clientBudgetMs: EXT },
      { now: NOW },
    );
    expect(rpcCalls).toHaveLength(2);
    expect(out.hops).toBe(2);
    expect(out.record_ids).toEqual(["queue", "hop"]);
    expect(out.lines[2]).toContain("Deploy W3 to prod now");
  });

  it("second hop skipped when the first search took longer than the guard", async () => {
    const out = await buildPromptRecall(
      setup([exception]),
      USER,
      null,
      { prompt: PROMPT, repo: "acme/app", clientBudgetMs: EXT },
      { now: NOW, secondHopGuardMs: 0 },
    );
    expect(rpcCalls).toHaveLength(1);
    expect(out.hops).toBe(1);
    expect(out.record_ids).toEqual(["queue"]);
  });

  describe("request deadline (extended path)", () => {
    // Shares the hop-1 ruling's ref: hop 2 keeps only records related to what hop 1 served.
    const hopRow = rec({
      id: "hop",
      kind: "decision",
      text: "Deploy W3 to prod now",
      code_session_id: "a38e14cc-x",
      ref: "#157",
    });
    const memories = [outcome({ id: "later", text: "Deployed main to prod after migrations 115-117", turn_idx: 9 })];
    /** A fake clock that the first search moves forward by `firstSearchMs`. */
    function timed(firstSearchMs: number) {
      let t = 10_000;
      const db = makeFakeSupabase(
        {
          session_memories: memories,
          code_projects: [{ id: PROJECT, user_id: USER, display_name: null, repo_identity: "github.com/acme/app" }],
          code_session_turns: [exception, hopRow].map((r) => ({
            session_id: r.code_session_id,
            idx: 0,
            text: r.quote,
            props: {},
          })),
          memory_branch_state: [],
          conversations: [],
        },
        {
          rpc: {
            memory_search_scored: (args: Record<string, unknown>) => {
              rpcCalls.push(args);
              if (rpcCalls.length === 1) t += firstSearchMs;
              return { data: rpcCalls.length === 1 ? [exception] : [exception, hopRow], error: null };
            },
          },
        },
      );
      return { db, clock: () => t };
    }

    it("a first search that ends near the deadline skips hop 2 and follow-ups and still serves hop 1", async () => {
      // Deadline = start + min(4,000 - 1,200, 2,800) = start + 2,800; the search ends at start + 2,600.
      const { db, clock } = timed(2_600);
      const out = await buildPromptRecall(
        db,
        USER,
        null,
        { prompt: PROMPT, repo: "acme/app", clientBudgetMs: EXT },
        { now: NOW, clock, secondHopGuardMs: 10_000 },
      );
      expect(rpcCalls).toHaveLength(1);
      expect(out.hops).toBe(1);
      expect(out.record_ids).toEqual(["queue"]);
      expect(out.followup_ids).toEqual([]);
      expect(out.lines.some((l) => l.startsWith(PROMPT_RECALL_FOLLOW_UP_PREFIX))).toBe(false);
    });

    it("a first search that leaves under 700 ms skips hop 2 but runs the follow-ups", async () => {
      const { db, clock } = timed(2_200);
      const out = await buildPromptRecall(
        db,
        USER,
        null,
        { prompt: PROMPT, repo: "acme/app", clientBudgetMs: EXT },
        { now: NOW, clock, secondHopGuardMs: 10_000 },
      );
      expect(rpcCalls).toHaveLength(1);
      expect(out.hops).toBe(1);
      expect(out.followup_ids).toEqual(["later"]);
    });

    it("a fast first search runs hop 2 and the follow-ups", async () => {
      const { db, clock } = timed(100);
      const out = await buildPromptRecall(
        db,
        USER,
        null,
        { prompt: PROMPT, repo: "acme/app", clientBudgetMs: EXT },
        { now: NOW, clock },
      );
      expect(rpcCalls).toHaveLength(2);
      expect(out.hops).toBe(2);
      expect(out.record_ids).toEqual(["queue", "hop"]);
      expect(out.followup_ids).toEqual(["later"]);
    });
  });

  const many = () => [
    exception,
    ...[1, 2, 3, 4, 5].map((i) =>
      rec({
        id: `m${i}`,
        text: `src/legacy/ledger-sync.ts note ${i}: wrap call site ${i} in the helper`,
        leg_score: 1 / (80 + i),
      }),
    ),
  ];

  it("legacy client (no budget_ms): at most 3 records, header + 3 + footer, no second hop, no follow-ups, no note", async () => {
    const memories = [
      outcome({ id: "later", text: "Deployed main to prod", turn_idx: 9, code_session_id: "abcd1234-queue" }),
    ];
    for (const clientBudgetMs of [undefined, 2000]) {
      rpcCalls.length = 0;
      const out = await buildPromptRecall(
        setup(many(), undefined, memories),
        USER,
        null,
        { prompt: PROMPT, repo: "acme/app", ...(clientBudgetMs ? { clientBudgetMs } : {}) },
        { now: NOW },
      );
      expect(PROMPT_RECALL_LEGACY_MAX_RECORDS).toBe(3);
      expect(out.record_ids).toHaveLength(3);
      expect(out.lines.length).toBeLessThanOrEqual(5);
      expect(out.lines).toHaveLength(5);
      expect(out.lines[0]).toBe(PROMPT_RECALL_HEADER);
      expect(out.lines.at(-1)?.startsWith(PROMPT_RECALL_FOOTER_PREFIX)).toBe(true);
      expect(out.lines).not.toContain(PROMPT_RECALL_RESEARCH_NOTE);
      expect(out.lines.some((l) => l.startsWith(PROMPT_RECALL_FOLLOW_UP_PREFIX))).toBe(false);
      expect(out.followup_ids).toEqual([]);
      expect(rpcCalls).toHaveLength(1);
      expect(out.hops).toBe(1);
    }
  });

  it("new client (budget_ms >= 3,500): up to 5 records, the note, and follow-ups", async () => {
    const memories = [
      outcome({ id: "later", text: "Deployed main to prod", turn_idx: 9, code_session_id: "abcd1234-queue" }),
    ];
    const out = await buildPromptRecall(
      setup(many(), undefined, memories),
      USER,
      null,
      { prompt: PROMPT, repo: "acme/app", clientBudgetMs: 3500 },
      { now: NOW },
    );
    expect(out.record_ids).toHaveLength(PROMPT_RECALL_MAX_RECORDS);
    expect(out.lines).toContain(PROMPT_RECALL_RESEARCH_NOTE);
    expect(out.followup_ids).toEqual(["later"]);
  });

  /** A hop-1 db whose second search fails (or hangs, via the embedder) while hop 1 answers. */
  const hopDb = (second: () => { data: unknown; error: { message: string } | null }) => {
    const hopRow = rec({ id: "hop", text: "Deploy W3 to prod now", code_session_id: "a38e14cc-x" });
    return makeFakeSupabase(
      {
        session_memories: [],
        code_projects: [{ id: PROJECT, user_id: USER, display_name: null, repo_identity: "github.com/acme/app" }],
        code_session_turns: [exception, hopRow].map((r) => ({
          session_id: r.code_session_id,
          idx: 0,
          text: r.quote,
          props: {},
        })),
        memory_branch_state: [],
        conversations: [],
      },
      {
        rpc: {
          memory_search_scored: (args: Record<string, unknown>) => {
            rpcCalls.push(args);
            return rpcCalls.length === 1 ? { data: [exception], error: null } : second();
          },
        },
      },
    );
  };

  it("second hop error: hop 1's records are served alone", async () => {
    const out = await buildPromptRecall(
      hopDb(() => ({ data: null, error: { message: "boom" } })),
      USER,
      null,
      { prompt: PROMPT, repo: "acme/app", clientBudgetMs: EXT },
      { now: NOW },
    );
    expect(rpcCalls).toHaveLength(2);
    expect(out.record_ids).toEqual(["queue"]);
    expect(out.hops).toBe(1);
    expect(out.lines[1]).toContain("src/legacy/ledger-sync.ts");
  });

  it("second hop over its budget: hop 1's records are served alone", async () => {
    const vec = new Array(1536).fill(0);
    mockGenerateEmbedding.mockReset();
    mockGenerateEmbedding.mockResolvedValueOnce(vec).mockImplementation(() => new Promise(() => {}));
    const out = await buildPromptRecall(
      hopDb(() => ({ data: [], error: null })),
      USER,
      null,
      { prompt: PROMPT, repo: "acme/app", clientBudgetMs: EXT },
      { now: NOW, secondHopBudgetMs: 20 },
    );
    expect(out.record_ids).toEqual(["queue"]);
    expect(out.hops).toBe(1);
    expect(out.lines[0]).toBe(PROMPT_RECALL_HEADER);
  });

  /**
   * Wraps a fake db so the follow-up read (its select list is unique) records each builder call and settles with
   * `settle`; every other read goes to the fake.
   */
  const interceptFollowUps = (db: Db, settle: () => Promise<unknown>) => {
    const calls: [string, unknown[]][] = [];
    const chain: Record<string, unknown> = {};
    for (const m of ["eq", "in", "is", "limit", "order"]) {
      chain[m] = (...args: unknown[]) => {
        calls.push([m, args]);
        return chain;
      };
    }
    // biome-ignore lint/suspicious/noThenProperty: a thenable stands in for the awaited query builder.
    chain.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => settle().then(res, rej);
    const wrapped = new Proxy(db as object, {
      get(target, prop, receiver) {
        if (prop !== "from") return Reflect.get(target, prop, receiver);
        return (table: string) => {
          const b = (target as Db).from(table as never) as unknown as Record<string, unknown>;
          if (table !== "session_memories") return b;
          return new Proxy(b, {
            get(bt, bp) {
              if (bp === "select") {
                return (cols: string, ...rest: unknown[]) =>
                  cols === "id, code_session_id, text, turn_idx, ref, paths"
                    ? chain
                    : (bt.select as (...a: unknown[]) => unknown).call(bt, cols, ...rest);
              }
              const v = Reflect.get(bt, bp);
              return typeof v === "function" ? v.bind(bt) : v;
            },
          });
        };
      },
    }) as Db;
    return { db: wrapped, calls };
  };

  it("follow-up read past its budget: the records are served without follow-ups", async () => {
    const { db } = interceptFollowUps(setup([exception]), () => new Promise(() => {}));
    const out = await buildPromptRecall(
      db,
      USER,
      null,
      { prompt: PROMPT, repo: "acme/app", clientBudgetMs: EXT },
      { now: NOW, followUpBudgetMs: 20 },
    );
    expect(out.record_ids).toEqual(["queue"]);
    expect(out.followup_ids).toEqual([]);
    expect(out.lines.some((l) => l.startsWith(PROMPT_RECALL_FOLLOW_UP_PREFIX))).toBe(false);
  });

  it("follow-up read is scoped to the caller's user_id and capped at 200 rows", async () => {
    const { db, calls } = interceptFollowUps(setup([exception]), async () => ({ data: [], error: null }));
    await buildPromptRecall(db, USER, null, { prompt: PROMPT, repo: "acme/app", clientBudgetMs: EXT }, { now: NOW });
    expect(calls).toContainEqual(["eq", ["user_id", USER]]);
    expect(calls).toContainEqual(["limit", [200]]);
    expect(calls).toContainEqual(["eq", ["kind", "outcome"]]);
  });

  it("past the budget -> empty, never an error", async () => {
    mockGenerateEmbedding.mockImplementation(() => new Promise(() => {}));
    const out = await buildPromptRecall(
      setup([exception]),
      USER,
      null,
      { prompt: PROMPT, repo: "acme/app", clientBudgetMs: EXT },
      { now: NOW, budgetMs: 20 },
    );
    expect(out).toMatchObject({ lines: [], record_ids: [], skipped: "timeout" });
    // The hung embedding is the stage in flight: named, and with no elapsed entry.
    expect(out.stage_at_timeout).toContain("hop1_search:embed_query");
    expect(out.stages_ms).not.toHaveProperty("embed_query");
  });

  it("a served answer reports numeric per-stage ms", async () => {
    const out = await buildPromptRecall(
      setup([exception]),
      USER,
      null,
      { prompt: PROMPT, repo: "acme/app" },
      { now: NOW },
    );
    expect(out.stages_ms).toMatchObject({
      resolve_project: expect.any(Number),
      embed_query: expect.any(Number),
      search_rpc: expect.any(Number),
      render: expect.any(Number),
    });
    expect(out.stage_at_timeout).toBeUndefined();
  });
});

describe("W4b serving changes (eval loop 2)", () => {
  const EXT = 4000;
  const QUEUE_PROMPT =
    "apps/cloud/src/lib/kg/queue.ts still reads process.env directly. Convert it to the accessors and run the tests.";
  const generic = (i: number) =>
    rec({
      id: `env-${i}`,
      text: `Cloud code reads env through the accessors, rule ${["one", "two", "three"][i - 1]} of the gate`,
      leg_score: 2 / (60 + i),
    });
  const ruling = rec({
    id: "ruling",
    text: "Leave the kg module file alone for the pending cleanup issue; do not edit anything under that directory",
    paths: ["apps/cloud/src/lib/kg/queue.ts"],
    created_at: "2026-10-01T12:00:00Z",
  });

  function db(searchRows: Row[], anchorRows: Row[] | null, anchorCalls: Record<string, unknown>[] = []) {
    const all = [...searchRows, ...(anchorRows ?? [])];
    return makeFakeSupabase(
      {
        session_memories: [],
        code_projects: [{ id: PROJECT, user_id: USER, display_name: null, repo_identity: "github.com/acme/app" }],
        code_session_turns: all.map((r) => ({ session_id: r.code_session_id, idx: 0, text: r.quote, props: {} })),
        memory_branch_state: [],
        conversations: [],
      },
      {
        rpc: {
          memory_search_scored: (args: Record<string, unknown>) => {
            rpcCalls.push(args);
            return { data: searchRows, error: null };
          },
          ...(anchorRows
            ? {
                memory_anchor_records: (args: Record<string, unknown>) => {
                  anchorCalls.push(args);
                  return { data: anchorRows, error: null };
                },
              }
            : {}),
        },
      },
    );
  }

  describe("path-anchor leg", () => {
    it("a prompt naming a file pulls the record whose paths carry it, ahead of the search results", async () => {
      const calls: Record<string, unknown>[] = [];
      const out = await buildPromptRecall(
        db([generic(1), generic(2), generic(3)], [ruling], calls),
        USER,
        null,
        { prompt: QUEUE_PROMPT, repo: "acme/app", clientBudgetMs: EXT },
        { now: NOW },
      );
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        p_user_id: USER,
        p_code_project_id: PROJECT,
        p_tokens: ["apps/cloud/src/lib/kg/queue.ts"],
        p_kinds: ["decision", "learning", "outcome", "blocker"],
        p_limit: 2,
      });
      expect(out.record_ids[0]).toBe("ruling");
      expect(out.lines[1]).toContain("Leave the kg module file alone");
    });

    it("a bare file name (route.ts) makes no anchor call", async () => {
      const calls: Record<string, unknown>[] = [];
      await buildPromptRecall(
        db([generic(1)], [ruling], calls),
        USER,
        null,
        {
          prompt: "route.ts still reads process.env directly, convert it please",
          repo: "acme/app",
          clientBudgetMs: EXT,
        },
        { now: NOW },
      );
      expect(calls).toHaveLength(0);
    });

    it("a partial path (lib/kg/queue.ts) is sent as a token", async () => {
      const calls: Record<string, unknown>[] = [];
      await buildPromptRecall(
        db([generic(1)], [], calls),
        USER,
        null,
        {
          prompt: "lib/kg/queue.ts still reads process.env directly, convert it",
          repo: "acme/app",
          clientBudgetMs: EXT,
        },
        { now: NOW },
      );
      expect(calls[0]?.p_tokens).toEqual(["lib/kg/queue.ts"]);
    });

    it("three path tokens still yield at most 2 anchor records", async () => {
      const anchors = [1, 2, 3, 4].map((i) =>
        rec({
          id: `anc-${i}`,
          text: `Ruling number ${["one", "two", "three", "four"][i - 1]} about the module layout that must be kept`,
          paths: [`apps/cloud/src/lib/m${i}/x.ts`],
        }),
      );
      const calls: Record<string, unknown>[] = [];
      const out = await buildPromptRecall(
        db([generic(1), generic(2), generic(3)], anchors, calls),
        USER,
        null,
        {
          prompt: "change apps/cloud/src/lib/a/x.ts and apps/cloud/src/lib/b/y.ts and apps/cloud/src/lib/c/z.ts now",
          repo: "acme/app",
          clientBudgetMs: EXT,
        },
        { now: NOW },
      );
      expect(calls[0]?.p_limit).toBe(2);
      expect(out.record_ids.filter((id) => id.startsWith("anc-")).length).toBeLessThanOrEqual(2);
    });

    it("a prompt with no path skips the leg", async () => {
      const calls: Record<string, unknown>[] = [];
      await buildPromptRecall(
        db([generic(1)], [ruling], calls),
        USER,
        null,
        { prompt: "how do we read env vars in the cloud app these days", repo: "acme/app", clientBudgetMs: EXT },
        { now: NOW },
      );
      expect(calls).toHaveLength(0);
    });

    it("an anchor read error serves the search results alone", async () => {
      const out = await buildPromptRecall(
        db([generic(1)], null),
        USER,
        null,
        { prompt: QUEUE_PROMPT, repo: "acme/app", clientBudgetMs: EXT },
        { now: NOW },
      );
      expect(out.record_ids).toEqual(["env-1"]);
    });

    it("legacy client (no budget_ms): no anchor read, same answer as before", async () => {
      const calls: Record<string, unknown>[] = [];
      const out = await buildPromptRecall(
        db([generic(1), generic(2)], [ruling], calls),
        USER,
        null,
        { prompt: QUEUE_PROMPT, repo: "acme/app" },
        { now: NOW },
      );
      expect(calls).toHaveLength(0);
      expect(out.record_ids).not.toContain("ruling");
      expect(out.record_ids[0]).toBe("env-1");
    });
  });

  describe("same-ref outcome dedupe", () => {
    const sr = (o: Partial<ServedRecord> & { id: string; text: string }): ServedRecord =>
      ({
        kind: "outcome",
        ref: "#370",
        session_id: `sess-${o.id}`,
        turn_idx: 1,
        when: "2026-10-02T09:25:00Z",
        ...o,
      }) as ServedRecord;

    it("three rewordings of one merge collapse to one line (seen in 3 sessions)", () => {
      const out = collapsePromptRecallDuplicates([
        sr({ id: "a", text: "PR #370 merged, closing #361; recall logging now records the surface of each event" }),
        sr({ id: "b", text: "Merged PR #370 which closes #361 and adds surface logging for recall events" }),
        sr({
          id: "c",
          text: "#361 closed by merging PR #370: recall events now log their surface",
          when: "2026-10-02T09:28:00Z",
        }),
      ]);
      expect(out.records.map((r) => r.id)).toEqual(["c"]);
      expect(out.seenIn.get("c")).toBe(3);
      expect(renderPromptRecallLine(out.records[0], NOW.getTime(), out.seenIn.get("c"))).toContain(
        "(seen in 3 sessions)",
      );
    });

    it("other identifiers must still match: a different migration number stays apart", () => {
      const out = collapsePromptRecallDuplicates([
        sr({ id: "a", text: "PR #370 merged with migration 113, closing #361 for recall logging" }),
        sr({ id: "b", text: "PR #370 merged with migration 114, closing #361 for recall logging" }),
      ]);
      expect(out.records).toHaveLength(2);
    });

    it("different lifecycle verbs on one ref stay apart (opened vs reverted)", () => {
      const out = collapsePromptRecallDuplicates([
        sr({ id: "a", text: "Opened PR #370 to add recall logging with the surface of each event, for #361" }),
        sr({ id: "b", text: "Reverted PR #370 which adds recall logging with the surface of each event, for #361" }),
      ]);
      expect(out.records).toHaveLength(2);
    });

    it("three rewordings of Merged PR #370 still collapse", () => {
      const out = collapsePromptRecallDuplicates([
        sr({ id: "a", text: "Merged PR #370 for #361; recall logging now records the surface of each event" }),
        sr({ id: "b", text: "PR #370 merged, #361 done: surface logging for recall events was added" }),
        sr({
          id: "c",
          text: "Recall events now log their surface; merged PR #370 for #361",
          when: "2026-10-02T09:28:00Z",
        }),
      ]);
      expect(out.records).toHaveLength(1);
    });

    it("decisions on one ref keep the 0.6 bar", () => {
      const out = collapsePromptRecallDuplicates([
        sr({ id: "a", kind: "decision", text: "PR #370 merged, closing #361; recall logging records the surface" }),
        sr({ id: "b", kind: "decision", text: "Merged PR #370 which closes #361 and adds surface logging for recall" }),
      ]);
      expect(out.records).toHaveLength(2);
    });
  });

  describe("relevance guards", () => {
    const s = (o: Partial<ServedRecord> & { id: string }): ServedRecord =>
      ({
        kind: "decision",
        text: "t",
        ref: null,
        paths: [],
        session_id: `x-${o.id}`,
        turn_idx: 0,
        ...o,
      }) as ServedRecord;

    it("hop 2 keeps a record sharing a ref, a path or a thread with a served record, and drops the rest", () => {
      const served = [s({ id: "a", ref: "#12", paths: ["packages/cli/src/import.ts"] })];
      const threads = new Map<string, string | null>([
        ["a", "Import retry policy"],
        ["t", "import retry policy"],
        ["n", "Chrome extension"],
      ]);
      expect(relatedToServed(s({ id: "r", ref: "#12" }), served, threads)).toBe(true);
      expect(relatedToServed(s({ id: "p", paths: ["src/import.ts"] }), served, threads)).toBe(true);
      expect(relatedToServed(s({ id: "t" }), served, threads)).toBe(true);
      expect(relatedToServed(s({ id: "n", ref: "#13", paths: ["src/importer.ts"] }), served, threads)).toBe(false);
    });

    it("hop 2 end to end: an unrelated record does not pad the empty slots", async () => {
      const first = rec({ id: "first", text: "Imports never retry on a 504 from the server", ref: "#12" });
      const unrelated = rec({ id: "pad", text: "The browser extension is blocked by policy here", ref: "#99" });
      const related = rec({ id: "rel", text: "A 504 re-send would pay for extraction twice", ref: "#12" });
      const base = makeFakeSupabase(
        {
          session_memories: [],
          code_projects: [{ id: PROJECT, user_id: USER, display_name: null, repo_identity: "github.com/acme/app" }],
          code_session_turns: [first, unrelated, related].map((r) => ({
            session_id: r.code_session_id,
            idx: 0,
            text: r.quote,
            props: {},
          })),
          memory_branch_state: [],
          conversations: [],
        },
        {
          rpc: {
            memory_search_scored: (args: Record<string, unknown>) => {
              rpcCalls.push(args);
              return { data: rpcCalls.length === 1 ? [first] : [first, unrelated, related], error: null };
            },
          },
        },
      );
      const out = await buildPromptRecall(
        base,
        USER,
        null,
        {
          prompt: "the import client gives up on a 504, make it retry the batch",
          repo: "acme/app",
          clientBudgetMs: EXT,
        },
        { now: NOW },
      );
      expect(out.hops).toBe(2);
      expect(out.record_ids).toEqual(["first", "rel"]);
    });

    it("pathsShare matches equal paths and path-boundary suffixes only", () => {
      expect(pathsShare(["apps/cloud/src/lib/kg/queue.ts"], ["lib/kg/queue.ts"])).toBe(true);
      expect(pathsShare(["queue.ts"], ["apps/x/queue.ts"])).toBe(true);
      expect(pathsShare(["apps/x/extraction-queue.ts"], ["queue.ts"])).toBe(false);
      expect(pathsShare([], ["queue.ts"])).toBe(false);
    });

    it("a follow-up is shown only when the outcome shares a ref or a path with its record", async () => {
      const served = [
        s({ id: "r1", ref: "#12", session_id: "S1", turn_idx: 1 }),
        s({ id: "r2", paths: ["packages/cli/src/import.ts"], session_id: "S2", turn_idx: 1 }),
        s({ id: "r3", ref: "#12", session_id: "S3", turn_idx: 1 }),
      ];
      const o = (id: string, session: string, extra: Partial<Row>): Row => ({
        id,
        user_id: USER,
        code_session_id: session,
        kind: "outcome",
        verified: true,
        retired_at: null,
        turn_idx: 5,
        text: `outcome ${id}`,
        ref: null,
        paths: [],
        ...extra,
      });
      const fake = makeFakeSupabase({
        session_memories: [
          o("same-ref", "S1", { ref: "#12", turn_idx: 4 }),
          o("deploy", "S1", { text: "Deployed main to prod", turn_idx: 9 }),
          o("same-path", "S2", { paths: ["src/import.ts"] }),
          o("unrelated", "S3", { ref: "#40", paths: ["docs/x.md"] }),
        ],
      });
      const out = await loadPromptRecallFollowUps(fake, USER, served);
      expect(out.get("r1")?.id).toBe("same-ref");
      expect(out.get("r2")?.id).toBe("same-path");
      expect(out.has("r3")).toBe(false);
    });
  });
});

describe("W4b loop 3: title anchors, verb subsets, hop-2 titles", () => {
  const EXT = 4000;
  // A fictional programme: the session's short title names it, its records do not.
  const PICKUP = "Continue the ledger and sync work from last time. Which parts are merged, deployed, and still open?";
  const variant = (i: number, text: string) =>
    rec({ id: `v-${i}`, kind: "outcome", ref: "#370", text, leg_score: 2 / (60 + i) });
  const searchRows = [
    variant(1, "PR #370 merged, closing #361; migration 113 applied with surface logging at 4f00d12"),
    variant(2, "PR #370 merged for #361: migration 113 applied, 4f00d12 deployed to prod"),
    rec({ id: "dec-1", text: "The session-start block leads with the last seven days of work, grouped by issue" }),
  ];
  const deploy = rec({
    id: "deploy",
    kind: "outcome",
    code_session_id: "sess-ledger",
    ref: "dpl_TestDeploy1",
    text: "Deployed main a1b2c3d to prod as dpl_TestDeploy1 after migrations 115 to 119",
    created_at: "2026-10-04T12:00:00Z",
  });
  const held = rec({
    id: "held",
    kind: "decision",
    code_session_id: "sess-ledger",
    text: "The goal is held until the deploy and seven days of measurement",
    created_at: "2026-10-04T11:00:00Z",
  });
  const titles: Record<string, string> = { "sess-ledger": "W9 ledger and sync upgrade: D7 PR" };

  /** Fake memory_title_anchor_records: a session matches when its title carries two distinct tokens as words. */
  function titleDb(calls: Record<string, unknown>[], rows: typeof searchRows = searchRows) {
    const all = [...rows, deploy, held];
    return makeFakeSupabase(
      {
        session_memories: [],
        code_projects: [{ id: PROJECT, user_id: USER, display_name: null, repo_identity: "github.com/acme/app" }],
        code_session_turns: all.map((r) => ({ session_id: r.code_session_id, idx: 0, text: r.quote, props: {} })),
        memory_branch_state: [],
        conversations: [],
      },
      {
        rpc: {
          memory_search_scored: (args: Record<string, unknown>) => {
            rpcCalls.push(args);
            return { data: rows, error: null };
          },
          memory_title_anchor_records: (args: Record<string, unknown>) => {
            calls.push(args);
            const toks = args.p_tokens as string[];
            const data = [deploy, held].filter((r) => {
              const title = titles[r.code_session_id as string] ?? "";
              return toks.filter((t) => new RegExp(`\\b${t}\\b`, "i").test(title)).length >= 2;
            });
            return { data: data.slice(0, args.p_limit as number), error: null };
          },
        },
      },
    );
  }

  describe("title-anchor leg", () => {
    it("a prompt naming the programme yields the titled session's deploy outcome, ahead of the search", async () => {
      const calls: Record<string, unknown>[] = [];
      const out = await buildPromptRecall(
        titleDb(calls),
        USER,
        null,
        { prompt: PICKUP, repo: "acme/app", clientBudgetMs: EXT },
        { now: NOW },
      );
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ p_user_id: USER, p_project_id: PROJECT, p_limit: 2 });
      expect(calls[0].p_tokens).toEqual(expect.arrayContaining(["ledger", "sync"]));
      expect(calls[0].p_tokens).not.toContain("what");
      expect(out.record_ids.slice(0, 2).sort()).toEqual(["deploy", "held"]);
      expect(out.lines.join("\n")).toContain("Deployed main a1b2c3d to prod");
      // The two #370 variants ({merge} and {merge, deploy}) take one slot.
      expect(out.record_ids.filter((id) => id.startsWith("v-"))).toHaveLength(1);
    });

    it("a prompt sharing only one title token (sync) yields nothing from the leg", async () => {
      const calls: Record<string, unknown>[] = [];
      const out = await buildPromptRecall(
        titleDb(calls),
        USER,
        null,
        {
          prompt: "Continue the sync work from last time. Which parts are merged and still open?",
          repo: "acme/app",
          clientBudgetMs: EXT,
        },
        { now: NOW },
      );
      expect(calls).toHaveLength(1);
      expect(out.record_ids).not.toContain("deploy");
      expect(out.record_ids).not.toContain("held");
    });

    it("L5: hosted default family keeps title-anchored records when the floored search is empty", async () => {
      vi.stubEnv("MEMBRAL_EMBEDDING_MODEL", "text-embedding-3-small");
      try {
        const out = await buildPromptRecall(
          titleDb([], []),
          USER,
          null,
          { prompt: PICKUP, repo: "acme/app", clientBudgetMs: EXT },
          { now: NOW },
        );
        expect(out.record_ids.sort()).toEqual(["deploy", "held"]);
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it("L5: calibrated family (nomic): title anchors never create an answer, nothing cleared the floor so none serve", async () => {
      vi.stubEnv("MEMBRAL_EMBEDDING_MODEL", "nomic-embed-text");
      try {
        await nomicEmptyCase();
      } finally {
        vi.unstubAllEnvs();
      }
    });

    async function nomicEmptyCase() {
      const calls: Record<string, unknown>[] = [];
      const out = await buildPromptRecall(
        titleDb(calls, []),
        USER,
        null,
        { prompt: PICKUP, repo: "acme/app", clientBudgetMs: EXT },
        { now: NOW },
      );
      expect(calls).toHaveLength(1); // the leg ran and found the titled session ...
      expect(out.record_ids).toEqual([]); // ... but without a floored search hit it adds nothing
      expect(out.skipped).toBe("no_match");
    }

    it("legacy client (no budget_ms): no title-anchor read", async () => {
      const calls: Record<string, unknown>[] = [];
      const out = await buildPromptRecall(
        titleDb(calls),
        USER,
        null,
        { prompt: PICKUP, repo: "acme/app" },
        { now: NOW },
      );
      expect(calls).toHaveLength(0);
      expect(out.record_ids).not.toContain("deploy");
    });

    it("titleTokens keeps letter runs of four or more, minus stopwords", () => {
      expect([...titleTokens(PICKUP)].sort()).toEqual([
        "continue",
        "deployed",
        "last",
        "ledger",
        "merged",
        "open",
        "parts",
        "sync",
        "time",
        "work",
      ]);
    });
  });

  describe("verb-subset dedupe", () => {
    const sr = (o: Partial<ServedRecord> & { id: string; text: string }): ServedRecord =>
      ({
        kind: "outcome",
        ref: "#370",
        session_id: `sess-${o.id}`,
        turn_idx: 1,
        when: "2026-10-02T09:25:00Z",
        ...o,
      }) as ServedRecord;

    it("{merge} and {merge, deploy} on one ref collapse", () => {
      const out = collapsePromptRecallDuplicates([
        sr({ id: "a", text: "PR #370 merged, closing #361; migration 113 applied with surface logging at 4f00d12" }),
        sr({
          id: "b",
          text: "PR #370 merged for #361: migration 113 applied, 4f00d12 deployed to prod",
          when: "2026-10-02T09:28:00Z",
        }),
      ]);
      expect(out.records.map((r) => r.id)).toEqual(["b"]);
      expect(out.seenIn.get("b")).toBe(2);
    });

    // Containment 4/10 = 0.4 (Jaccard would be 4/17); identifiers {#361} within {#361, 113, 4f00d12}.
    it("same-ref outcomes: a subset identifier set collapses ({} vs {113, 4f00d12})", () => {
      const out = collapsePromptRecallDuplicates([
        sr({ id: "a", text: "PR #370 merged, closing #361: logs preamble recall events with a surface field" }),
        sr({
          id: "b",
          text: "PR #370 merged for #361: migration 113 applied, 4f00d12 deployed to prod",
          when: "2026-10-02T09:28:00Z",
        }),
      ]);
      expect(out.records.map((r) => r.id)).toEqual(["b"]);
      expect(renderPromptRecallLine(out.records[0], NOW.getTime(), out.seenIn.get("b"))).toContain(
        "(seen in 2 sessions)",
      );
    });

    it("same-ref outcomes: disjoint identifiers stay apart (migration 118 vs 119)", () => {
      const out = collapsePromptRecallDuplicates([
        sr({ id: "a", ref: "#500", text: "Migration 118 applied to prod after backup" }),
        sr({ id: "b", ref: "#500", text: "Migration 119 applied to prod after backup" }),
      ]);
      expect(out.records).toHaveLength(2);
    });

    it("{open} and {revert} on one ref stay apart", () => {
      const out = collapsePromptRecallDuplicates([
        sr({ id: "a", text: "Opened PR #370 to add recall logging with the surface of each event, for #361" }),
        sr({ id: "b", text: "Reverted PR #370 which adds recall logging with the surface of each event, for #361" }),
      ]);
      expect(out.records).toHaveLength(2);
    });

    it("{merge, revert} and {merge, deploy} stay apart (each has a verb the other lacks)", () => {
      const out = collapsePromptRecallDuplicates([
        sr({ id: "a", text: "PR #370 merged for #361 then reverted: surface logging for recall events at 4f00d12" }),
        sr({ id: "b", text: "PR #370 merged for #361 then deployed: surface logging for recall events at 4f00d12" }),
      ]);
      expect(out.records).toHaveLength(2);
    });

    it("{merge} vs {merge, revert} stay apart (a reversal is never absorbed)", () => {
      const out = collapsePromptRecallDuplicates([
        sr({ id: "a", ref: "#12", text: "PR #12 merged into main after review approval" }),
        sr({ id: "b", ref: "#12", text: "PR #12 merged into main then reverted after review found a regression" }),
      ]);
      expect(out.records).toHaveLength(2);
    });

    it("a decision and its reversal stay apart ({} vs {revert})", () => {
      const out = collapsePromptRecallDuplicates([
        sr({
          id: "a",
          kind: "decision",
          ref: undefined,
          text: "Keep the thirty day extraction recency window for every backfill run",
        }),
        sr({
          id: "b",
          kind: "decision",
          ref: undefined,
          text: "Reverted the thirty day extraction recency window for every backfill run",
        }),
      ]);
      expect(out.records).toHaveLength(2);
    });

    it("environment words differ: staging vs production stay apart", () => {
      const out = collapsePromptRecallDuplicates([
        sr({ id: "a", ref: "#12", text: "Deployed #12 to staging after checks" }),
        sr({ id: "b", ref: "#12", text: "Deployed #12 to production after checks" }),
      ]);
      expect(out.records).toHaveLength(2);
    });
  });

  describe("hop 2 by session title", () => {
    const s = (o: Partial<ServedRecord> & { id: string }): ServedRecord =>
      ({
        kind: "decision",
        text: "t",
        ref: null,
        paths: [],
        session_id: `x-${o.id}`,
        turn_idx: 0,
        ...o,
      }) as ServedRecord;

    it("keeps a candidate whose session title shares two prompt tokens, drops one sharing one", () => {
      const served = [s({ id: "a", ref: "#12" })];
      const threads = new Map<string, string | null>();
      const sessionTitles = new Map<string, string | null>([
        ["kept", "W9 ledger and sync upgrade"],
        ["dropped", "W9 ledger cleanup"],
      ]);
      const promptTokens = titleTokens(PICKUP);
      expect(relatedToServed(s({ id: "kept" }), served, threads, { titles: sessionTitles, promptTokens })).toBe(true);
      expect(relatedToServed(s({ id: "dropped" }), served, threads, { titles: sessionTitles, promptTokens })).toBe(
        false,
      );
      expect(relatedToServed(s({ id: "kept" }), served, threads)).toBe(false);
    });
  });
});

describe("line_max: legacy and new clients", () => {
  const url = "https://github.com/acme/codehub/pull/1234";
  const r500 = {
    id: "r",
    kind: "decision",
    text: `${"Keep the inline vendor call in the sync worker; ".repeat(12)}`.slice(0, 500).trimEnd(),
    ref: "#1234",
    ref_url: url,
    session_id: "abcd1234-ffff-4fff-8fff-ffffffffffff",
    when: "2026-10-06T12:00:00Z",
  } as ServedRecord;

  it("a legacy request (no line_max) never yields a line over 420 or a half URL for a 500-char record", () => {
    const line = renderPromptRecallLine(r500, NOW.getTime());
    expect(line.length).toBeLessThanOrEqual(420);
    expect(line.includes("→") ? line.includes(url) : true).toBe(true);
    expect(line).toMatch(/… \(open: abcd1234\)$/);
    // A 300-char record with a URL fits whole by dropping the URL, never by slicing it.
    const mid = renderPromptRecallLine({ ...r500, text: r500.text.slice(0, 300) }, NOW.getTime());
    expect(mid.length).toBeLessThanOrEqual(420);
    expect(mid.includes("→") ? mid.includes(url) : true).toBe(true);
  });

  it("the word-boundary cut never splits a surrogate pair", () => {
    const text = `${"a".repeat(380)}😀${"b".repeat(50)}`;
    for (let n = 0; n < 40; n++) {
      const line = renderPromptRecallLine({ ...r500, text: text.slice(n) }, NOW.getTime());
      expect(line).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
      expect(line.length).toBeLessThanOrEqual(420);
    }
  });

  it("a new request (line_max 720) keeps the whole 500-char text, ref and URL", () => {
    const line = renderPromptRecallLine(r500, NOW.getTime(), 1, 720);
    expect(line.length).toBeLessThanOrEqual(PROMPT_RECALL_LINE_MAX_CEILING);
    expect(line).toContain(r500.text);
    expect(line).toContain(url);
  });

  it("clamps line_max and scales block totals from the legacy 3,000 / 3,600", () => {
    expect(resolveLineMax(undefined)).toBe(420);
    expect(resolveLineMax(100)).toBe(300);
    expect(resolveLineMax(9000)).toBe(720);
    expect(scaleTotal(3_000, 420)).toBe(3_000);
    expect(scaleTotal(3_000, 720)).toBe(5_143);
  });
});

describe("hop 2 after a skipped embedding", () => {
  it("is not run when hop 1 gave up on the embedding (one embedding call, hops 1)", async () => {
    vi.stubEnv("MEMBRAL_PROMPT_RECALL_EMBED_DEADLINE_MS", "50");
    mockGenerateEmbedding.mockImplementation(() => new Promise(() => {}));
    const row = rec({
      id: "queue",
      text: "Keep src/legacy/ledger-sync.ts as the single inline-call exception: #157 removes the ledger module",
      ref: "#157",
      lex_hits: 8,
      query_lexemes: 12,
      leg_score: 1 / 70,
    });
    const out = await buildPromptRecall(
      setup([row]),
      USER,
      null,
      { prompt: PROMPT, repo: "acme/app", clientBudgetMs: 4000 },
      { now: NOW },
    );
    expect(out.record_ids).toEqual(["queue"]);
    expect(out.embedding_skipped).toBe(true);
    expect(out.hops).toBe(1);
    expect(mockGenerateEmbedding).toHaveBeenCalledTimes(1);
    expect(rpcCalls.every((a) => a.p_query_embedding === null)).toBe(true);
  });
});
