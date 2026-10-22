// L6 store precision (docs/design/current-truth-recall.md section "L6"; issues #162, #161, #307).
import { describe, expect, it, vi } from "vitest";
import type { LlmClient } from "@/lib/llm/client";
import { sameFactByVector } from "../dedupe";
import { extractWindow } from "../extract";
import { deepRelativePathRef, groundAgainstTurns, refInTurn } from "../grounding";
import { relativizeRefPath, toRepoRelativePath } from "../paths";
import type { TurnRow } from "../render";
import { dropReasonCode, MEMORY_KINDS, parseMemoryRecord, repairWireRecord } from "../schema";
import { groupSameFact, type SameFactRow } from "../serve-filter";
import type { MemoryWindow } from "../windows";

const logWarn = vi.hoisted(() => vi.fn());
vi.mock("@/lib/log", () => ({ log: { warn: logWarn, info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const GOOD = {
  kind: "decision",
  text: "Retries use jitter so a burst of failures does not retry in lockstep",
  quote: "retries should use jitter so they do not all retry together",
  turn_idx: 1,
  turn_role: "assistant",
};

describe("#162 field repair (repairWireRecord / parseMemoryRecord)", () => {
  it("repairs kind case, stray whitespace, confidence out of range, a lone path string and string booleans", () => {
    const { record, repairs } = repairWireRecord({
      ...GOOD,
      kind: " Decision ",
      turn_role: "ASSISTANT",
      quote: `  ${GOOD.quote}\n`,
      confidence: 85,
      paths: "src/a.ts",
      durable: "true",
    });
    expect(record).toMatchObject({
      kind: "decision",
      turn_role: "assistant",
      quote: GOOD.quote,
      confidence: 0.5,
      paths: ["src/a.ts"],
      durable: true,
    });
    expect(repairs.sort()).toEqual(["bool_string", "confidence_range", "kind_case", "paths_shape", "string_trim"]);
  });

  it("an out-of-range confidence falls back to 0.5 (never clamped to 1, never read as a percentage); a numeric string is read", () => {
    expect((repairWireRecord({ confidence: 400 }).record as { confidence: number }).confidence).toBe(0.5);
    expect((repairWireRecord({ confidence: 2 }).record as { confidence: number }).confidence).toBe(0.5);
    expect((repairWireRecord({ confidence: -2 }).record as { confidence: number }).confidence).toBe(0.5);
    expect(repairWireRecord({ confidence: Number.POSITIVE_INFINITY }).repairs).toEqual([]);
    expect((repairWireRecord({ confidence: "0.7" }).record as { confidence: number }).confidence).toBe(0.7);
    expect(repairWireRecord({ confidence: 0.4 }).repairs).toEqual([]);
  });

  it("a record the old schema dropped is now kept, and says what was repaired", () => {
    const parsed = parseMemoryRecord({ ...GOOD, kind: "Decision", confidence: 90 });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.kind).toBe("decision");
      expect(parsed.data.confidence).toBe(0.5);
      expect(parsed.repairs).toEqual(["kind_case", "confidence_range"]);
    }
  });

  it("an already-valid record carries no repairs", () => {
    const parsed = parseMemoryRecord(GOOD);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.repairs).toBeUndefined();
  });

  it("paths: a comma list of paths is split; prose or a mixed list is left as sent", () => {
    expect(repairWireRecord({ paths: "a.ts, b/c.ts" }).record).toMatchObject({ paths: ["a.ts", "b/c.ts"] });
    expect(repairWireRecord({ paths: "see a.ts, b.ts" }).repairs).toEqual([]);
    expect(repairWireRecord({ paths: "all of them" }).repairs).toEqual([]);
  });

  it("never invents content: a missing text, an unknown kind and non-objects still fail", () => {
    expect(parseMemoryRecord({ ...GOOD, text: undefined }).success).toBe(false);
    expect(parseMemoryRecord({ ...GOOD, kind: "rumour" }).success).toBe(false);
    expect(parseMemoryRecord("nope").success).toBe(false);
    expect(parseMemoryRecord(null).success).toBe(false);
  });

  it("dropReasonCode names the field and issue code, never record text", () => {
    const parsed = parseMemoryRecord({ ...GOOD, text: "short" });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const code = dropReasonCode(parsed.error);
      expect(code).toBe("text:too_small");
      expect(code).not.toContain("short");
    }
  });
});

describe("#162 every extraction drop is logged with a reason code and no record text", () => {
  const turns = [
    {
      idx: 0,
      role: "user",
      kind: "prose",
      text: "hello there",
      tool_name: null,
      file_path: null,
      ts: null,
      props: null,
    },
    { idx: 1, role: "assistant", kind: "prose", text: "ok", tool_name: null, file_path: null, ts: null, props: null },
  ] as TurnRow[];
  const window = { windowIndex: 3, turns: turns.map((t) => ({ ...t, line: `#${t.idx} ${t.role}: ${t.text}` })) };

  it("a malformed record logs one dropped line (kind, reason, session id, window) and the rest survives", async () => {
    logWarn.mockClear();
    const secret = "SECRET-RECORD-TEXT-THAT-MUST-NOT-APPEAR";
    const reply = {
      records: [
        { ...GOOD, text: secret.slice(0, 4) },
        { kind: "decision", text: secret },
      ],
      issues: [],
    };
    const llm = {
      callJson: vi.fn(async () => ({ data: reply, record: { cost_usd: 0 } })),
      overBudget: () => false,
    } as unknown as LlmClient;
    await extractWindow(llm, "header", [], window as unknown as MemoryWindow, "sess-42");
    const dropped = logWarn.mock.calls.filter(([msg]) => msg === "memory-extract: dropped");
    expect(dropped).toHaveLength(2);
    for (const [, fields] of dropped) {
      expect(fields).toMatchObject({
        action: "dropped",
        conversation_id: "sess-42",
        window_index: 3,
        kind: "decision",
      });
      expect(typeof fields.reason).toBe("string");
      expect(JSON.stringify(fields)).not.toContain(secret);
    }
    expect(dropped[0][1].reason).toBe("text:too_small");
  });

  it("a repaired record logs a repaired line and is kept", async () => {
    logWarn.mockClear();
    const reply = { records: [{ ...GOOD, kind: "Decision", quote: undefined, confidence: 80 }], issues: [] };
    const llm = {
      callJson: vi.fn(async () => ({ data: reply, record: { cost_usd: 0 } })),
      overBudget: () => false,
    } as unknown as LlmClient;
    await extractWindow(llm, "header", [], window as unknown as MemoryWindow, "sess-42");
    const repaired = logWarn.mock.calls.filter(([msg]) => msg === "memory-extract: repaired").map(([, f]) => f.reason);
    expect(repaired.sort()).toEqual(["confidence_range", "kind_case"]);
  });
});

describe("#161 repo-relative refs ground against absolute tool paths", () => {
  const ref = "apps/cloud/src/lib/memory/search.ts";
  const editTurn = {
    idx: 7,
    role: "assistant",
    text: null,
    file_path: `/Users/dev/wt-feature/${ref}`,
    props: { inputDigest: "" },
  };

  it("deepRelativePathRef accepts only >= 3-segment relative paths", () => {
    expect(deepRelativePathRef(ref)).toBe(ref);
    expect(deepRelativePathRef(`./${ref}`)).toBe(ref);
    expect(deepRelativePathRef("src/index.ts")).toBeNull();
    expect(deepRelativePathRef(`/abs/${ref}`)).toBeNull();
    expect(deepRelativePathRef(`~/${ref}`)).toBeNull();
    expect(deepRelativePathRef("../a/b/c.ts")).toBeNull();
    expect(deepRelativePathRef("https://host/a/b/c")).toBeNull();
  });

  it("matches the tail of an absolute touched-file path in another turn, in any worktree", () => {
    expect(refInTurn(ref, editTurn, false)).toBe(true);
    expect(refInTurn(ref, { ...editTurn, file_path: `/Users/dev/other-clone/${ref}` }, false)).toBe(true);
  });

  it("matches inside a shell command's tool-input digest", () => {
    const t = {
      idx: 2,
      role: "assistant",
      text: null,
      props: { inputDigest: `git diff /Users/dev/wt-a/${ref} | head` },
    };
    expect(refInTurn(ref, t, false)).toBe(true);
  });

  it("does not match a longer, different path, a shorter ref, or free text", () => {
    expect(refInTurn(ref, { ...editTurn, file_path: `/Users/dev/wt/${ref}x` }, false)).toBe(false);
    expect(refInTurn(ref, { ...editTurn, file_path: `/Users/dev/wt/x${ref}` }, false)).toBe(false);
    expect(refInTurn("src/index.ts", { ...editTurn, file_path: "/r/packages/other/src/index.ts" }, false)).toBe(false);
    expect(refInTurn(ref, { idx: 1, role: "assistant", text: `see /Users/dev/wt/${ref}`, props: null }, false)).toBe(
      false,
    );
  });

  it("does not match another repo's path inside a URL, nor a longer file name", () => {
    const url = {
      idx: 3,
      role: "assistant",
      text: null,
      props: { inputDigest: `WebFetch https://github.com/other/repo/blob/main/${ref}` },
    };
    expect(refInTurn(ref, url, false)).toBe(false);
    expect(refInTurn(ref, { ...editTurn, file_path: `/Users/dev/wt/${ref}.orig` }, false)).toBe(false);
    expect(refInTurn(ref, { ...editTurn, file_path: `/Users/dev/wt/${ref}` }, false)).toBe(true);
  });

  it("a quote-less outcome retired as ref_not_found now verifies when the edit turn is elsewhere", () => {
    const turns = [{ idx: 1, role: "assistant", text: "done", props: null }, editTurn];
    const rec = { kind: "outcome" as const, text: "Edited the search module", quote: null, ref, turn_idx: 1 };
    expect(groundAgainstTurns(rec, turns).verified).toBe(true);
    expect(groundAgainstTurns(rec, [turns[0]]).reason).toBe("ref_not_found");
  });

  it("a leading ./ is stripped from paths and refs", () => {
    expect(toRepoRelativePath("./src/a.ts", "/r")).toBe("src/a.ts");
    expect(relativizeRefPath("./src/a.ts", "/r")).toBe("src/a.ts");
    expect(relativizeRefPath("/r/src/a.ts", "/r")).toBe("src/a.ts");
    expect(relativizeRefPath("https://x.y/./z", "/r")).toBe("https://x.y/./z");
  });
});

describe("#307 dedupe keying: same session and turn, cosine at the calibrated cut, collapse to one", () => {
  const base: SameFactRow = {
    id: "a",
    kind: "decision",
    text: "Stop the kicker before any exclusion run on the second stack",
    ref: null,
    code_project_id: "p1",
    code_session_id: "s1",
    created_at: "2026-10-01T00:00:00Z",
  };
  const twin: SameFactRow = {
    ...base,
    id: "b",
    text: "Stop the extraction kicker before an exclusion run on the other stack",
  };
  const cosineOf = (cos: number) => (x: SameFactRow, y: SameFactRow) => sameFactByVector(x, y, cos, 0.86);

  it("two paraphrases from one session and turn collapse to one group; the vector rule needs the cut", () => {
    expect(groupSameFact([base, twin], cosineOf(0.9))).toHaveLength(1);
    expect(groupSameFact([base, twin], cosineOf(0.86))).toHaveLength(1);
    expect(sameFactByVector(base, twin, 0.85, 0.86)).toBe(false);
  });

  it("the same-session key does not merge different identifiers or kinds", () => {
    expect(groupSameFact([base, { ...twin, text: `${twin.text} migration 119` }], cosineOf(0.99))).toHaveLength(2);
    expect(groupSameFact([base, { ...twin, kind: "learning" }], cosineOf(0.99))).toHaveLength(2);
  });
});

describe("#307 meta-commentary about Membral never lands in a served memory kind", () => {
  const turns = [
    {
      idx: 0,
      role: "user",
      kind: "prose",
      text: "that recall was wrong and stale",
      tool_name: null,
      file_path: null,
      ts: null,
      props: null,
    },
  ] as TurnRow[];
  const window = { windowIndex: 0, turns: turns.map((t) => ({ ...t, line: `#${t.idx} ${t.role}: ${t.text}` })) };

  it("'feedback' is not a memory kind, in any casing the model writes it", async () => {
    expect(MEMORY_KINDS).not.toContain("feedback");
    for (const kind of ["feedback", "Feedback", " FEEDBACK "]) {
      expect(parseMemoryRecord({ ...GOOD, kind }).success).toBe(false);
    }
    const reply = {
      records: ["feedback", "Feedback", " FEEDBACK "].map((kind) => ({
        kind,
        sentiment: "stale",
        text: "The recalled line was out of date.",
        quote: "that recall was wrong and stale",
        turn_idx: 0,
        turn_role: "user",
      })),
      issues: [],
    };
    const llm = {
      callJson: vi.fn(async () => ({ data: reply, record: { cost_usd: 0 } })),
      overBudget: () => false,
    } as unknown as LlmClient;
    const r = await extractWindow(llm, "header", [], window as unknown as MemoryWindow, "s1");
    expect(r.result.records).toEqual([]);
    expect(r.result.feedback).toHaveLength(3);
    expect(r.result.feedback.every((f) => f.sentiment === "stale")).toBe(true);
  });
});
