// D10 (W3): extraction may carry an issue/MR `ref_title` and, on an MR ref,
// the `ref_issue` it addresses. Both are quote-grounded: a title must sit
// verbatim in the receipt turn; an MR->issue edge needs ONE quote naming both
// numbers (maintainer ruling 2026-10-03; no meaning-based links, D-057 off).
// A failure drops the field, never the record.
import { makeMemoryFakeSupabase as makeFakeSupabase, type Row } from "@membral/test-kit";
import { describe, expect, it, vi } from "vitest";
import { LlmClient, type OpenAILike } from "@/lib/llm/client";
import type { ModelConfig } from "@/lib/llm/config";
import { insertMemoryRecords } from "@/lib/memory/write";
import { extractWindow, PROMPT_VERSION, refQuotedOrDropped } from "../extract";
import { groundRefIssue, groundRefTitle } from "../grounding";
import { applyDeterministicFixes, groundRecord, repairOutcomeRef } from "../merge";
import { renderTurnLines, type TurnRow } from "../render";
import { type MemoryRecordParsed, parseMemoryRecord } from "../schema";
import { buildWindows } from "../windows";

const CONFIG: ModelConfig = {
  model: "gpt-4o-mini",
  baseURL: undefined,
  apiKey: "test",
  embedModel: "text-embedding-3-small",
  embedDimensions: 1536,
};

function makeLlm(content: string): LlmClient {
  const create = vi.fn().mockResolvedValue({
    choices: [{ message: { content } }],
    usage: { prompt_tokens: 10, completion_tokens: 10 },
  });
  const client: OpenAILike = { chat: { completions: { create } }, embeddings: { create: vi.fn() } };
  return new LlmClient(CONFIG, { client });
}

const turn = (idx: number, role: "user" | "assistant", text: string): TurnRow => ({
  idx,
  role,
  kind: "prose",
  text,
  tool_name: null,
  file_path: null,
  ts: null,
  props: {},
});

const OPENED = "Opened CodeHub !14: Login fails on Safari";
const TURNS: TurnRow[] = [turn(0, "user", "please look at #12, the Safari login bug"), turn(1, "assistant", OPENED)];
const STATED = "Opened CodeHub !14 for #12 with the cookie fix";

function outcome(over: Partial<MemoryRecordParsed> = {}): MemoryRecordParsed {
  return {
    kind: "outcome",
    text: "MR !14 fixes the Safari login failure.",
    quote: OPENED,
    turn_idx: 1,
    turn_role: "assistant",
    ref: "!14",
    ref_kind: "mr",
    durable: true,
    paths: [],
    scope: "project",
    confidence: 0.9,
    ...over,
  };
}

async function extractOne(record: Record<string, unknown>) {
  const window = buildWindows(renderTurnLines(TURNS))[0];
  const llm = makeLlm(JSON.stringify({ records: [record] }));
  const { result, failed } = await extractWindow(llm, "header", [], window, "session-1");
  return { records: result.records, failed };
}

describe("D10: ref_title / ref_issue through extraction -> grounding -> writer", () => {
  it("prompt version is bumped for the new fields and the prompt names both", () => {
    expect(PROMPT_VERSION).toBe("memory-extract-v26");
  });

  it("keeps a title that is verbatim in the cited turn, and the writer stores it with the inferred edge", async () => {
    const { records } = await extractOne({
      ...outcome(),
      ref_title: "login FAILS   on safari", // case + whitespace differ
      ref_issue: "#12",
      ref_issue_basis: "inferred",
    });
    expect(records).toHaveLength(1);
    const grounded = groundRecord(records[0], TURNS, PROMPT_VERSION, 0);
    expect(grounded?.verified).toBe(true);
    // Finding 5: the stored title is the turn's own substring, not the model's casing/spacing.
    expect(grounded?.ref_title).toBe("Login fails on Safari");
    expect([grounded?.ref_issue, grounded?.ref_issue_basis]).toEqual(["#12", "inferred"]);
    const rows: Row[] = [];
    await insertMemoryRecords(makeFakeSupabase({ session_memories: rows }), "u1", "p1", "s1", "main", [
      { ...grounded!, embedding: null },
    ]);
    expect(rows[0]?.ref_title).toBe("Login fails on Safari");
    expect(rows[0]?.ref_issue).toBe("#12");
    expect(rows[0]?.ref_issue_basis).toBe("inferred");
  });

  it("drops a title that is not in the cited turn, and keeps the record", async () => {
    const { records } = await extractOne({ ...outcome(), ref_title: "Login fails on Firefox" });
    expect(records).toHaveLength(1);
    const grounded = groundRecord(records[0], TURNS, PROMPT_VERSION, 0);
    expect(grounded).not.toBeNull();
    expect(grounded?.verified).toBe(true);
    expect(grounded?.ref).toBe("!14");
    expect(grounded?.ref_title).toBeNull();
  });

  it("drops a title that only appears in ANOTHER turn of the session", () => {
    const turns = [...TURNS, turn(2, "assistant", "Title: Session cookie expires early")];
    const grounded = groundRecord(outcome({ ref_title: "Session cookie expires early" }), turns, PROMPT_VERSION, 0);
    expect(grounded?.verified).toBe(true);
    expect(grounded?.ref_title).toBeNull();
  });

  const edgeOf = (rec: MemoryRecordParsed, turns: TurnRow[]) => {
    const g = groundRecord(rec, turns, PROMPT_VERSION, 0);
    expect(g?.verified).toBe(true);
    return [g?.ref_issue, g?.ref_issue_basis];
  };
  const split: TurnRow[] = [turn(0, "user", "work on #12 please, the Safari login bug"), turn(1, "assistant", OPENED)];

  it("basis stated: kept when the quote names both", () => {
    const rec = outcome({ quote: STATED, ref_issue: "#12", ref_issue_basis: "stated" });
    expect(edgeOf(rec, [turn(1, "assistant", STATED)])).toEqual(["#12", "stated"]);
  });

  it("basis stated whose quote lacks the issue token: downgraded to inferred", () => {
    expect(edgeOf(outcome({ ref_issue: "#12", ref_issue_basis: "stated" }), split)).toEqual(["#12", "inferred"]);
    const sameTurn = [turn(1, "assistant", `${OPENED}. It addresses #12.`)];
    expect(edgeOf(outcome({ ref_issue: "#12", ref_issue_basis: "stated" }), sameTurn)).toEqual(["#12", "inferred"]);
  });

  it("basis inferred: kept when the issue appears in the session", () => {
    expect(edgeOf(outcome({ ref_issue: "#12", ref_issue_basis: "inferred" }), split)).toEqual(["#12", "inferred"]);
  });

  it("basis inferred: dropped when the issue is absent from the session (record kept)", () => {
    const none = [turn(0, "user", "fix the Safari login bug"), turn(1, "assistant", OPENED)];
    expect(edgeOf(outcome({ ref_issue: "#12", ref_issue_basis: "inferred" }), none)).toEqual([null, null]);
    const otherRepo = [turn(0, "user", "see other/repo#12 and 2012 notes"), turn(1, "assistant", OPENED)];
    expect(edgeOf(outcome({ ref_issue: "#12", ref_issue_basis: "inferred" }), otherRepo)).toEqual([null, null]);
  });

  it("basis inferred: never the MR itself (same number, same repo)", () => {
    const pr = "https://codehub.example/acme/web/pull/12";
    const turns = [turn(0, "user", "see #12 and acme/web#12 and https://codehub.example/acme/web/issues/12")];
    expect(groundRefIssue({ ref: pr, quote: null }, "#12", "inferred", turns)).toBeNull();
    expect(groundRefIssue({ ref: pr, quote: null }, "acme/web#12", "inferred", turns)).toBeNull();
    expect(
      groundRefIssue({ ref: pr, quote: null }, "https://codehub.example/acme/web/issues/12", "inferred", turns),
    ).toBeNull();
    expect(groundRefIssue({ ref: "!12", quote: null }, "#12", "inferred", turns)).toBeNull();
    const other = [turn(0, "user", "see other/repo#12")];
    expect(groundRefIssue({ ref: pr, quote: null }, "other/repo#12", "inferred", other)?.issue).toBe("other/repo#12");
  });

  it("missing or invalid basis: ref_issue dropped", async () => {
    expect(edgeOf(outcome({ ref_issue: "#12" }), split)).toEqual([null, null]);
    const { records } = await extractOne({ ...outcome(), ref_issue: "#12", ref_issue_basis: "maybe" });
    expect(records[0].ref_issue_basis).toBeUndefined();
    expect(edgeOf(records[0], TURNS)).toEqual([null, null]);
  });

  it("malformed LLM values for the new fields drop alone, never the record, never a throw", async () => {
    const { records, failed } = await extractOne({ ...outcome(), ref_title: 42, ref_issue: { n: 12 } });
    expect(failed).toBe(false);
    expect(records).toHaveLength(1);
    expect(records[0].ref_title).toBeUndefined();
    expect(records[0].ref_issue).toBeUndefined();

    const tooLong = parseMemoryRecord({ ...outcome(), ref_title: "x".repeat(301), ref_issue: "" });
    expect(tooLong.success).toBe(true);
    if (tooLong.success) {
      expect(tooLong.data.ref_title).toBeUndefined();
      expect(tooLong.data.ref_issue).toBeUndefined();
    }
  });

  it("an unquoted issue ref on a decision loses ref_title/ref_issue along with the ref", () => {
    const decision: MemoryRecordParsed = {
      ...outcome(),
      kind: "decision",
      text: "The Safari login fix ships behind a flag.",
      quote: "ship the Safari login fix behind a flag",
      ref_title: "Login fails on Safari",
      ref_issue: "#12",
    };
    const kept = refQuotedOrDropped(decision);
    expect(kept).not.toBeNull();
    expect(kept?.ref).toBeUndefined();
    expect(kept?.ref_title).toBeUndefined();
    expect(kept?.ref_issue).toBeUndefined();
  });

  it("an unverified record stores neither field", () => {
    const grounded = groundRecord(
      outcome({ quote: "nothing like this appears anywhere", ref_title: "Login fails on Safari", ref_issue: "#12" }),
      TURNS,
      PROMPT_VERSION,
      0,
    );
    expect(grounded?.verified).toBe(false);
    expect(grounded?.ref_title).toBeNull();
    expect(grounded?.ref_issue).toBeNull();
  });

  it("groundRefTitle refuses a one-word title", () => {
    expect(groundRefTitle("Flaky", "#12", { idx: 1, role: "assistant", text: "#12 Flaky", props: {} })).toBeNull();
  });
});

const listTurn = (text: string, digest = "") => ({ idx: 1, role: "assistant", text, props: { inputDigest: digest } });

describe("D10 finding 2: a title is tied to its ref's own number", () => {
  const LIST = "#12  Login fails on Safari  bug\n#15  Session cookie expires early  bug";

  it("list output: a title from another item's line is dropped", () => {
    expect(groundRefTitle("Session cookie expires early", "#12", listTurn(LIST, "gh issue list"))).toBeNull();
  });

  it("list output: the title on the ref's own line is kept", () => {
    expect(groundRefTitle("login fails on safari", "#12", listTurn(LIST, "gh issue list"))).toBe(
      "Login fails on Safari",
    );
  });

  it("single-item view: input names the number, output has no other item -> kept", () => {
    const view = "title:\tLogin fails on Safari\nstate:\tOPEN\nlabels:\tbug";
    expect(groundRefTitle("Login fails on Safari", "#12", listTurn(view, "gh issue view 12"))).toBe(
      "Login fails on Safari",
    );
  });

  it("one-line piped `gh issue list --json` output: another item's title is dropped", () => {
    const json = '[{"number":12,"title":"Login fails on Safari"},{"number":15,"title":"Session cookie expires early"}]';
    expect(
      groundRefTitle("Session cookie expires early", "#15", listTurn(json, "gh issue list --json number,title")),
    ).toBeNull();
    expect(
      groundRefTitle("Login fails on Safari", "#12", listTurn(json, "gh issue list --json number,title")),
    ).toBeNull();
  });

  it("one-line compact MCP list JSON: dropped", () => {
    const mcp =
      '{"items":[{"ref":"#12","title":"Login fails on Safari"},{"ref":"#15","title":"Session cookie expires early"}]}';
    expect(groundRefTitle("Session cookie expires early", "#12", listTurn(mcp))).toBeNull();
  });

  it('one-line prose "looked at #12 and #15: <title>": dropped', () => {
    const prose = "looked at #12 and #15: Session cookie expires early";
    expect(groundRefTitle("Session cookie expires early", "#12", listTurn(prose))).toBeNull();
  });

  it('pretty-printed JSON view: another item as "number": 15 or /issues/15 drops it', () => {
    const base = '{\n  "number": 12,\n  "title": "Login fails on Safari",\n  "state": "OPEN"';
    const input = "gh issue view 12 --json number,title,state";
    expect(groundRefTitle("Login fails on Safari", "#12", listTurn(`${base}\n}`, input))).toBe("Login fails on Safari");
    expect(
      groundRefTitle("Login fails on Safari", "#12", listTurn(`${base},\n  "related": {"number": 15}\n}`, input)),
    ).toBeNull();
    expect(
      groundRefTitle(
        "Login fails on Safari",
        "#12",
        listTurn(`${base},\n  "see": "https://codehub.example/a/b/issues/15"\n}`, input),
      ),
    ).toBeNull();
  });

  it("fallback needs the input to name the item in item form, not a bare digit run", () => {
    const view = "title:\tLogin fails on Safari\nstate:\tOPEN";
    expect(groundRefTitle("Login fails on Safari", "#12", listTurn(view, "sleep 12"))).toBeNull();
    expect(groundRefTitle("Login fails on Safari", "#12", listTurn(view, '{"issue_number": 12}'))).toBe(
      "Login fails on Safari",
    );
  });

  it("single-item view whose output names another item -> dropped", () => {
    const view = "title:\tLogin fails on Safari\nRelated: #15";
    expect(groundRefTitle("Login fails on Safari", "#12", listTurn(view, "gh issue view 12"))).toBeNull();
  });

  it("view of a different number -> dropped", () => {
    const view = "title:\tLogin fails on Safari\nstate:\tOPEN";
    expect(groundRefTitle("Login fails on Safari", "#12", listTurn(view, "gh issue view 15"))).toBeNull();
  });

  it("a number inside a longer digit run is not the ref's token", () => {
    expect(groundRefTitle("Login fails on Safari", "#12", listTurn("#123 Login fails on Safari"))).toBeNull();
  });
});

describe("D10 findings 3/4: the MR->issue edge needs both items as their own tokens", () => {
  const edge = (ref: string, quote: string, issue: string) =>
    groundRefIssue({ ref, quote }, issue, "stated", [])?.issue ?? null;

  it("kept: one quote names the MR and the issue as written", () => {
    expect(edge("!14", "opened !14 for #12", "#12")).toBe("#12");
    expect(edge("!12", "opened !12 for #12", "#12")).toBe("#12");
    expect(edge("acme/web!14", "opened acme/web!14 for acme/web#12", "acme/web#12")).toBe("acme/web#12");
    const url = "https://codehub.example/acme/web/pull/14";
    expect(edge(url, `opened ${url} for #12`, "#12")).toBe("#12");
    expect(
      edge(
        "!14",
        "opened !14 for https://codehub.example/acme/web/issues/12",
        "https://codehub.example/acme/web/issues/12",
      ),
    ).toBe("https://codehub.example/acme/web/issues/12");
  });

  it('dropped: "merged in 2026" does not name issue #2026', () => {
    expect(edge("!14", "!14 merged in 2026", "#2026")).toBeNull();
  });

  it('dropped: "adds 14 tests" does not name issue #14', () => {
    expect(edge("!9", "!9 adds 14 tests", "#14")).toBeNull();
  });

  it('dropped: "!12 … !12" names only the MR, never issue #12', () => {
    expect(edge("!12", "opened !12, then rebased !12", "#12")).toBeNull();
  });

  it("dropped: a qualified quote never satisfies a bare target (cross-repo)", () => {
    expect(edge("!14", "opened !14 for other/repo#12", "#12")).toBeNull();
  });

  it("dropped: a qualified target needs that exact repo (cross-repo)", () => {
    expect(edge("!14", "opened !14 for other/repo#12", "acme/web#12")).toBeNull();
    expect(edge("!14", "opened !14 for #12", "acme/web#12")).toBeNull();
  });

  it("dropped: the MR glued to another repo or a longer number is not its token", () => {
    expect(edge("!14", "opened other/repo!14 for #12", "#12")).toBeNull();
    expect(edge("!14", "opened !140 for #12", "#12")).toBeNull();
    expect(edge("!14", "opened !14 for #123", "#12")).toBeNull();
  });

  it("dropped: an MR-shaped target is never the issue", () => {
    expect(edge("!14", "!14 supersedes !12", "!12")).toBeNull();
  });

  it('finding 4: a decision with ref_kind "pr" on "#9" is not an MR by shape', () => {
    const quote = "Ship #9 for #12 behind the Safari login flag";
    const decision: MemoryRecordParsed = {
      kind: "decision",
      text: "Ship the Safari login fix behind a flag.",
      quote,
      turn_idx: 0,
      turn_role: "user",
      ref: "#9",
      ref_kind: "pr",
      ref_issue: "#12",
      ref_issue_basis: "stated",
      durable: true,
      paths: [],
      scope: "project",
      confidence: 0.9,
    };
    for (const basis of ["stated", "inferred"] as const) {
      const grounded = groundRecord(
        { ...decision, ref_issue_basis: basis },
        [turn(0, "user", quote)],
        PROMPT_VERSION,
        0,
      );
      expect(grounded?.ref).toBe("#9");
      expect(grounded?.ref_issue).toBeNull();
      expect(grounded?.ref_issue_basis).toBeNull();
    }
  });
});

describe("D10 finding 1: a swapped ref drops ref_title/ref_issue", () => {
  const withExtras = (ref: string, text: string): [MemoryRecordParsed, TurnRow[]] => [
    outcome({ ref, ref_kind: "issue", quote: undefined, ref_title: "Login fails on Safari", ref_issue: "#12" }),
    [turn(1, "assistant", text)],
  ];
  const extras = (rs: MemoryRecordParsed[]) => rs.map((r) => [r.ref, r.ref_title, r.ref_issue]);

  it("range split: every member loses the title", () => {
    const [raw, turns] = withExtras("#133-#135", "filed #133 #134 #135");
    expect(extras(repairOutcomeRef(raw, turns))).toEqual([
      ["#133", undefined, undefined],
      ["#134", undefined, undefined],
      ["#135", undefined, undefined],
    ]);
  });

  it("range not fully present: the first member loses the title", () => {
    const [raw, turns] = withExtras("#133-#135", "filed #133 only");
    expect(extras(repairOutcomeRef(raw, turns))).toEqual([["#133", undefined, undefined]]);
  });

  it("uncorroborated bare-integer ref repaired from the turn loses the title", () => {
    const [raw, turns] = withExtras("#77", "filed #12 today");
    expect(extras(repairOutcomeRef(raw, turns))).toEqual([["#12", undefined, undefined]]);
  });

  it("uncorroborated hex ref repaired from the turn loses the title", () => {
    const [raw, turns] = withExtras("abcdef1", "see https://codehub.example/acme/web/issues/12");
    expect(extras(repairOutcomeRef(raw, turns))).toEqual([
      ["https://codehub.example/acme/web/issues/12", undefined, undefined],
    ]);
  });

  it("other uncorroborated ref repaired from the turn's digest/text loses the title", () => {
    const [raw, turns] = withExtras("codehub.example/acme", "filed #12 today");
    expect(extras(repairOutcomeRef(raw, turns))).toEqual([["#12", undefined, undefined]]);
  });

  it("an unchanged ref keeps both through applyDeterministicFixes", () => {
    const [raw, turns] = withExtras("#12", "filed #12 today");
    const { records } = applyDeterministicFixes(raw, turns, undefined);
    expect(extras(records)).toEqual([["#12", "Login fails on Safari", "#12"]]);
  });

  it("a ref changed by applyDeterministicFixes loses both", () => {
    const [raw, turns] = withExtras("#77", "filed #12 today");
    const { records } = applyDeterministicFixes(raw, turns, undefined);
    expect(extras(records)).toEqual([["#12", undefined, undefined]]);
  });
});
