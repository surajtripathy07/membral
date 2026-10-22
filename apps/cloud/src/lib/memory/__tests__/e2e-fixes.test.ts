// E2E fixes (2026-09-27), extraction side, on trimmed real transcripts from the e2e run:
//   C-4  email subjects the assistant quoted from a Gmail-shaped MCP never become thread rows
//   C-5  refs must be in the record's own quote; a decision needs the owner's own line
//   C-6  `priority` survives only on a user-turn preference/decision

import { makeMemoryFakeSupabase as makeFakeSupabase, type Row } from "@membral/test-kit";
import { describe, expect, it } from "vitest";
import { insertMemoryRecords } from "@/lib/memory/write";
import { groundSessionIssues, ownerGate, PROMPT_VERSION, refQuotedOrDropped } from "../extract";
import { groundRecord } from "../merge";
import type { TurnRow } from "../render";
import { type MemoryRecordParsed, parseMemoryRecord } from "../schema";

const INBOX = "/private/tmp/scratch-cwd/inbox"; // a non-git cwd: the project identity is the path

// Session d90f8e12 (N10), trimmed: turn 13 is the assistant quoting email subjects.
const N10_TURNS = [
  {
    idx: 0,
    role: "user",
    kind: "prose",
    text: "check my inbox for anything about the release, and what's on my calendar tomorrow",
    props: {},
  },
  { idx: 9, role: "assistant", kind: "tool_use", tool_name: "mcp__gmail__search_inbox", text: null, props: {} },
  {
    idx: 10,
    role: "user",
    kind: "tool_result",
    tool_name: "mcp__gmail__search_inbox",
    text: "[tool_result elided: ok]",
    props: {},
  },
  {
    idx: 13,
    role: "assistant",
    kind: "prose",
    text: '**Inbox — Release emails (3 found):**\n- **ci-bot** — "Release 2.4: PR #12 merged"\n- **tracker** — "issue #34 closed"',
    props: {},
  },
];

describe("C-4: a ref the assistant merely quoted from non-forge text is not a thread row", () => {
  it("drops PR #12 / issue #34 grounded only in the assistant's email summary", () => {
    const out = groundSessionIssues(
      [
        { ref: "#12", kind: "merge_request", evidence_quote: "Release 2.4: PR #12 merged" },
        { ref: "#34", kind: "issue", evidence_quote: "issue #34 closed" },
      ],
      N10_TURNS,
      INBOX,
      { actionsVersion: 1 },
    );
    expect(out).toEqual([]);
  });

  it("keeps the same ref when the owner's own line names it", () => {
    const turns = [
      ...N10_TURNS,
      { idx: 14, role: "user", kind: "prose", text: "ok, so is PR #12 merged for real?", props: {} },
    ];
    const out = groundSessionIssues(
      [{ ref: "#12", kind: "merge_request", evidence_quote: "is PR #12 merged for real" }],
      turns,
      INBOX,
      { actionsVersion: 1 },
    );
    // v4 item 7: kept, with its receipt; no verb → referenced.
    expect(out.map((i) => [i.ref, i.turn_idx, i.role])).toEqual([[`${INBOX}#12`, 14, "referenced"]]);
  });

  it("keeps a ref grounded in a forge tool call, and one the assistant qualifies to this repo", () => {
    const repo = "codehub.example/acme/app";
    const turns = [
      {
        idx: 2,
        role: "assistant",
        kind: "tool_use",
        tool_name: "Bash",
        text: null,
        props: {
          inputDigest: "gh pr view 77 --json state",
          action: { verb: "viewed", ref: "#77", refKind: "merge_request", source: "cli" },
        },
      },
      { idx: 4, role: "assistant", kind: "prose", text: "This overlaps acme/app#81 from last week.", props: {} },
    ];
    const out = groundSessionIssues(
      [
        { ref: "#77", kind: "merge_request", evidence_quote: "gh pr view 77 --json" },
        { ref: "acme/app#81", kind: "issue", evidence_quote: "overlaps acme/app#81 from" },
      ],
      turns,
      repo,
      { actionsVersion: 1 },
    );
    expect(out.map((i) => i.ref).sort()).toEqual([`${repo}#77`, `${repo}#81`]);
  });
});

const rec = (over: Partial<MemoryRecordParsed>): MemoryRecordParsed => ({
  kind: "outcome",
  text: "Test file docstring added.",
  quote: "5. `51bf0ba` - test docstring (#12)",
  turn_idx: 144,
  turn_role: "assistant",
  durable: true,
  paths: [],
  scope: "project",
  confidence: 0.9,
  ...over,
});

describe("C-5: a ref must be quoted", () => {
  it("drops the longhaul outcome whose ref #11 is not in its '(#12)' quote; keeps #12", () => {
    expect(refQuotedOrDropped(rec({ ref: "#11", ref_kind: "issue" }))).toBeNull();
    expect(refQuotedOrDropped(rec({ ref: "#12", ref_kind: "issue" }))?.ref).toBe("#12");
  });

  it("a non-outcome keeps the memory and loses the unquoted ref; non-issue refs pass through", () => {
    const pref = refQuotedOrDropped(
      rec({
        kind: "preference",
        turn_role: "user",
        quote: "keep the release notes short",
        ref: "#5",
        ref_kind: "issue",
      }),
    );
    expect(pref).not.toBeNull();
    expect(pref?.ref).toBeUndefined();
    expect(pref?.ref_kind).toBeUndefined();
    const sha = rec({ ref: "51bf0ba", ref_kind: "commit", quote: "pushed the docstring" });
    expect(refQuotedOrDropped(sha)).toBe(sha);
  });
});

describe("C-5 / review B1: the owner gate is on preferences and priority, not decisions", () => {
  const window = [
    { idx: 6, role: "assistant" as const, isProse: true },
    { idx: 7, role: "user" as const, isProse: true },
    { idx: 8, role: "user" as const, isProse: false }, // a tool_result row (e.g. CONTRIBUTING.md read back)
    { idx: 9, role: "user" as const, isProse: true, nonOwner: true }, // a compaction summary
  ];
  const decision = (turn_idx: number, turn_role: "user" | "assistant") =>
    rec({
      kind: "decision",
      text: "A dismissed thread is restored if a new commit lands on it.",
      quote: "A dismissed thread is restored if a new commit",
      turn_idx,
      turn_role,
      ref: undefined,
    });
  const preference = (turn_idx: number) => {
    const parsed = parseMemoryRecord({
      kind: "preference",
      statement: "Every commit message follows the conventional-commit format.",
      owner_quote: "Every commit message follows the conventional-commit format",
      turn_idx,
      turn_role: "user",
    });
    if (!parsed.success) throw new Error("expected a valid preference");
    return parsed.data;
  };

  it("keeps an assistant-quoted real decision (receipts may come from agent or user turns)", () => {
    expect(ownerGate(decision(6, "assistant"), window, false)).not.toBeNull();
    expect(ownerGate(decision(7, "user"), window, false)).not.toBeNull();
  });

  it("a CONTRIBUTING.md line (tool output) or a compaction summary never becomes a preference", () => {
    expect(ownerGate(preference(8), window, false)).toBeNull();
    expect(ownerGate(preference(9), window, false)).toBeNull();
    expect(ownerGate(preference(7), window, false)).not.toBeNull();
  });

  it("a sub-agent session's decisions are not gated (its user lines are the parent's brief)", () => {
    expect(ownerGate(decision(6, "assistant"), window, true)).not.toBeNull();
  });

  it("prompt v14", () => {
    expect(PROMPT_VERSION).toBe("memory-extract-v26");
  });
});

describe("C-6: priority is the owner's, on a preference or decision only", () => {
  const german = "ab jetzt ist Issue #5 die wichtigste Priorität, das muss diese Woche fertig werden";
  it("keeps priority on a user-turn preference (German quote, ref from the quote)", () => {
    const parsed = parseMemoryRecord({
      kind: "preference",
      statement: "Issue #5 is the highest priority and must be done this week.",
      owner_quote: german,
      turn_idx: 13,
      turn_role: "user",
      ref: "#5",
      ref_kind: "issue",
      priority: true,
    });
    expect(parsed.success && parsed.data.priority).toBe(true);
    if (!parsed.success) return;
    expect(refQuotedOrDropped(parsed.data)?.ref).toBe("#5");
    expect(ownerGate(parsed.data, [{ idx: 13, role: "user", isProse: true }], false)?.priority).toBe(true);
  });

  it("drops priority from an assistant decision, a learning, and a sub-agent brief line", () => {
    const base = { text: "Issue #5 goes first this week.", quote: german, turn_idx: 13, durable: false };
    const asst = parseMemoryRecord({ ...base, kind: "decision", turn_role: "assistant", priority: true });
    const learning = parseMemoryRecord({ ...base, kind: "learning", turn_role: "user", priority: true });
    expect(asst.success && asst.data.priority).toBe(undefined);
    expect(learning.success && learning.data.priority).toBe(undefined);
    const userDecision = parseMemoryRecord({ ...base, kind: "decision", turn_role: "user", priority: true });
    if (!userDecision.success) throw new Error("expected a valid decision");
    expect(ownerGate(userDecision.data, [{ idx: 13, role: "user", isProse: true }], true)?.priority).toBeUndefined();
  });
});

// Migration 108 (session_memories.priority): groundRecord/write.ts's DB write path, on top
// of C-6's extraction-side gate above.
describe("C-6: priority survives groundRecord -> insertMemoryRecords, gated on the ground-truth receipt turn", () => {
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

  it("a user-turn preference flagged priority is written with priority true", async () => {
    const quote = "Issue #5 is the highest priority and must be done this week.";
    const raw: MemoryRecordParsed = {
      kind: "preference",
      text: "Issue #5 goes first this week.",
      quote,
      turn_idx: 3,
      turn_role: "user",
      ref: "#5",
      ref_kind: "issue",
      durable: true,
      priority: true,
      paths: [],
      scope: "project",
      confidence: 0.9,
    };
    const grounded = groundRecord(raw, [turn(3, "user", quote)], PROMPT_VERSION, 0);
    expect(grounded?.priority).toBe(true);
    const rows: Row[] = [];
    await insertMemoryRecords(makeFakeSupabase({ session_memories: rows }), "u1", "p1", "s1", "main", [
      { ...grounded!, embedding: null },
    ]);
    expect(rows[0]?.priority).toBe(true);
  });

  it("the same record resolved against an ASSISTANT receipt turn is written with priority false", () => {
    const quote = "Issue #5 is the highest priority and must be done this week.";
    const raw: MemoryRecordParsed = {
      kind: "preference",
      text: "Issue #5 goes first this week.",
      quote,
      turn_idx: 3,
      turn_role: "user", // the model's own claim — groundRecord trusts the receipt turn instead
      ref: "#5",
      ref_kind: "issue",
      durable: true,
      priority: true,
      paths: [],
      scope: "project",
      confidence: 0.9,
    };
    // The resolved receipt turn (idx 3) is the assistant's — the DB check (kind <>
    // 'preference' or turn_role = 'user') would drop the whole record anyway, but a
    // decision in the same spot must still lose `priority`, not just preferences.
    const decision: MemoryRecordParsed = { ...raw, kind: "decision", ref: undefined, ref_kind: undefined };
    const grounded = groundRecord(decision, [turn(3, "assistant", quote)], PROMPT_VERSION, 0);
    expect(grounded?.priority).toBe(false);
  });

  it("a German user priority survives end-to-end through extract -> merge -> write", async () => {
    const german = "ab jetzt ist Issue #5 die wichtigste Priorität, das muss diese Woche fertig werden";
    const parsed = parseMemoryRecord({
      kind: "preference",
      statement: "Issue #5 is the highest priority and must be done this week.",
      owner_quote: german,
      turn_idx: 5,
      turn_role: "user",
      ref: "#5",
      ref_kind: "issue",
      priority: true,
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const gated = ownerGate(parsed.data, [{ idx: 5, role: "user", isProse: true }], false);
    expect(gated?.priority).toBe(true);
    if (!gated) throw new Error("expected the record to survive ownerGate");
    const grounded = groundRecord(gated, [turn(5, "user", german)], PROMPT_VERSION, 0);
    expect(grounded?.priority).toBe(true);
    const rows: Row[] = [];
    await insertMemoryRecords(makeFakeSupabase({ session_memories: rows }), "u1", "p1", "s1", "main", [
      { ...grounded!, embedding: null },
    ]);
    expect(rows[0]?.priority).toBe(true);
  });
});
