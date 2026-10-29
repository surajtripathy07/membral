import { describe, expect, it } from "vitest";
import {
  claudeMemImportBodySchema,
  cleanText,
  coarseTurnIdx,
  contentHashFor,
  findAnchor,
  kindForType,
  mapObservation,
  type SessionRef,
  type StoredTurn,
} from "../import-claude-mem";

const session: SessionRef = {
  id: "sess-1",
  code_project_id: "proj-1",
  source_session_id: "cs-1",
  short_title: "Queue fixes",
  title: null,
};
const NARRATIVE = "The retry queue drops jobs when the worker restarts before the ack is written.";
const turns: StoredTurn[] = [
  { idx: 0, role: "user", kind: "prose", text: "first prompt" },
  { idx: 1, role: "assistant", kind: "prose", text: "looking" },
  { idx: 4, role: "user", kind: "prose", text: "second prompt" },
  { idx: 5, role: "assistant", kind: "prose", text: `Found it. ${NARRATIVE} Fixing now.` },
];
const ctx = { kind: "learning" as const, text: `Retry queue loses jobs: ${NARRATIVE}`, citedIdx: 4 };
const obs = (over: Record<string, unknown> = {}) => ({
  contentSessionId: "cs-1",
  type: "bugfix",
  title: "Retry queue loses jobs",
  narrative: NARRATIVE,
  body: null,
  promptNumber: 2,
  createdAt: "2026-10-01T10:00:00.000Z",
  ...over,
});

describe("kindForType", () => {
  it("maps known types, unknown to learning, never outcome or preference", () => {
    expect(kindForType("decision")).toBe("decision");
    expect(kindForType("bugfix")).toBe("learning");
    expect(kindForType("DISCOVERY")).toBe("learning");
    expect(kindForType("gotcha-from-a-newer-version")).toBe("learning");
  });
});

describe("findAnchor", () => {
  it("returns the verbatim text with its turn when it appears exactly", () => {
    expect(findAnchor({ narrative: NARRATIVE, body: null }, turns, ctx)).toEqual({
      quote: NARRATIVE,
      idx: 5,
      role: "assistant",
    });
  });
  it("returns null for a paraphrase or a too-short phrase", () => {
    expect(
      findAnchor({ narrative: "The retry queue loses jobs on restart because acks are late.", body: null }, turns, ctx),
    ).toBeNull();
    expect(findAnchor({ narrative: "second prompt", body: null }, turns, ctx)).toBeNull();
  });
  it("skips a non-owner user turn (compaction summary, shell output) and tool turns", () => {
    const only: StoredTurn[] = [
      { idx: 2, role: "user", kind: "prose", text: `Summary: ${NARRATIVE}`, props: { nonOwner: true } },
      { idx: 3, role: "assistant", kind: "tool_result", text: NARRATIVE },
    ];
    expect(findAnchor({ narrative: NARRATIVE, body: null }, only, ctx)).toBeNull();
  });
  it("records a user-voiced turn as user, but a sub-agent's user turn (the parent's brief) as assistant", () => {
    const said: StoredTurn[] = [{ idx: 2, role: "user", kind: "prose", text: `Please note: ${NARRATIVE}` }];
    expect(findAnchor({ narrative: NARRATIVE, body: null }, said, ctx)?.role).toBe("user");
    expect(findAnchor({ narrative: NARRATIVE, body: null }, said, { ...ctx, subAgent: true })?.role).toBe("assistant");
  });
  it("applies the shared specificity gate: an off-topic quote does not ground a learning", () => {
    const offTopic = "Completely unrelated sentence about lunch plans and the weather today.";
    const t: StoredTurn[] = [{ idx: 1, role: "assistant", kind: "prose", text: offTopic }];
    expect(
      findAnchor({ narrative: offTopic, body: null }, t, { kind: "learning", text: "queue retry bug", citedIdx: 1 }),
    ).toBeNull();
  });
});

describe("bounded work", () => {
  it("maps 100 non-matching observations over 3,000 prose turns in well under 2s", () => {
    const big: StoredTurn[] = Array.from({ length: 3000 }, (_, i) => ({
      idx: i,
      role: i % 2 ? "assistant" : "user",
      kind: "prose",
      text: `Working through step ${i}: the worker pool, the ack path, and the retry queue settings were reviewed again.`,
    }));
    const t0 = performance.now();
    for (let n = 0; n < 100; n++) {
      const row = mapObservation(
        "user-1",
        session,
        big,
        obs({ narrative: `Summary ${n}: the pipeline was reorganised so that failed deliveries are replayed later.` }),
      );
      expect(row?.quote).toBeNull();
    }
    expect(performance.now() - t0).toBeLessThan(2000);
  });

  it("skips a candidate carrying a redaction marker", () => {
    const marked = "The key was [REDACTED] and the retry queue drops jobs on restart.";
    const t: StoredTurn[] = [{ idx: 1, role: "assistant", kind: "prose", text: marked }];
    expect(findAnchor({ narrative: marked, body: null }, t, ctx)).toBeNull();
  });

  it("clamps createdAt to [2000-01-01, now] and reads zoneless as UTC", () => {
    const now = new Date("2026-10-25T00:00:00.000Z");
    const at = (createdAt: string) => mapObservation("user-1", session, turns, obs({ createdAt }), now)?.created_at;
    expect(at("1970-01-01T00:00:00Z")).toBe("2000-01-01T00:00:00.000Z");
    expect(at("2026-10-01 10:00:00")).toBe("2026-10-01T10:00:00.000Z");
  });

  it("clamps a future createdAt to now", () => {
    const now = new Date("2026-10-25T00:00:00.000Z");
    expect(mapObservation("user-1", session, turns, obs({ createdAt: "2030-01-01T00:00:00Z" }), now)?.created_at).toBe(
      now.toISOString(),
    );
  });
});

describe("coarseTurnIdx", () => {
  it("maps prompt_number N to the Nth owner prose user turn, 0 when unknown", () => {
    expect(coarseTurnIdx(2, turns)).toBe(4);
    expect(coarseTurnIdx(1, turns)).toBe(0);
    expect(coarseTurnIdx(9, turns)).toBe(0);
    expect(coarseTurnIdx(null, turns)).toBe(0);
  });
  it("ignores user tool_result turns and non-owner user turns", () => {
    const mixed: StoredTurn[] = [
      { idx: 0, role: "user", kind: "prose", text: "real first" },
      { idx: 1, role: "user", kind: "tool_result", text: "output" },
      { idx: 2, role: "user", kind: "prose", text: "compaction summary", props: { nonOwner: true } },
      { idx: 3, role: "user", kind: "prose", text: "real second" },
    ];
    expect(coarseTurnIdx(2, mixed)).toBe(3);
  });
});

describe("mapObservation", () => {
  it("quotes and verifies an exact match, positioned at the matching turn", () => {
    const row = mapObservation("user-1", session, turns, obs());
    expect(row).toMatchObject({
      user_id: "user-1",
      code_session_id: "sess-1",
      code_project_id: "proj-1",
      source: "claude-mem",
      kind: "learning",
      quote: NARRATIVE,
      turn_idx: 5,
      turn_role: "assistant",
      verified: true,
      session_title: "Queue fixes",
      created_at: "2026-10-01T10:00:00.000Z",
    });
    expect(row?.text).toBe(`Retry queue loses jobs: ${NARRATIVE}`);
  });
  it("leaves quote null and uses prompt_number position when nothing matches", () => {
    const row = mapObservation(
      "user-1",
      session,
      turns,
      obs({ narrative: "Something never said in the transcript at all." }),
    );
    expect(row).toMatchObject({ quote: null, verified: false, turn_idx: 4, turn_role: "assistant" });
  });
  it("returns null for an observation with no text", () => {
    expect(mapObservation("user-1", session, turns, obs({ title: null, narrative: null }))).toBeNull();
  });
  it("hashes the same content to the same value (idempotency key)", () => {
    const a = mapObservation("user-1", session, turns, obs());
    const b = mapObservation("user-1", session, [], obs({ promptNumber: 7 }));
    expect(a?.content_hash).toBe(b?.content_hash);
    expect(a?.content_hash).toBe(contentHashFor("learning", `Retry queue loses jobs: ${NARRATIVE}`));
  });
});

describe("claudeMemImportBodySchema", () => {
  it("rejects empty, oversized batches and unknown shapes", () => {
    expect(claudeMemImportBodySchema.safeParse({ observations: [] }).success).toBe(false);
    expect(
      claudeMemImportBodySchema.safeParse({ observations: Array.from({ length: 101 }, () => obs()) }).success,
    ).toBe(false);
    expect(claudeMemImportBodySchema.safeParse({ observations: [{ type: "x" }] }).success).toBe(false);
    expect(claudeMemImportBodySchema.safeParse({ observations: [obs()] }).success).toBe(true);
  });
});

describe("redaction and caps", () => {
  // Built by concatenation so no scanner sees a token-shaped literal in the source.
  const fakeKey = `sk-${"A1b2C3d4".repeat(5)}`;
  it("redacts secrets and phone/email shapes and truncates instead of rejecting", () => {
    const parsed = claudeMemImportBodySchema.parse({
      observations: [
        obs({
          title: `T ${"t".repeat(900)}`,
          narrative: `Used key ${fakeKey} and mailed ${"dev"}@${"example"}.com then ${"x".repeat(6000)}`,
        }),
      ],
    });
    const o = parsed.observations[0];
    expect(o?.title).toHaveLength(500);
    expect(o?.narrative).toHaveLength(4000);
    expect(o?.narrative).not.toContain(fakeKey);
    expect(o?.narrative).not.toContain("@example.com");
    expect(cleanText(`password: ${"hunter"}${"22"}`, 100)).not.toContain("hunter22");
  });
  it("does not anchor a redacted narrative to the unredacted turn (nothing secret is stored as a quote)", () => {
    const secretTurn: StoredTurn[] = [
      {
        idx: 1,
        role: "assistant",
        kind: "prose",
        text: `Rotated the retry queue key ${fakeKey} after the restart bug.`,
      },
    ];
    const parsed = claudeMemImportBodySchema.parse({
      observations: [obs({ narrative: `Rotated the retry queue key ${fakeKey} after the restart bug.` })],
    });
    const row = mapObservation("user-1", session, secretTurn, parsed.observations[0] as never);
    expect(row?.text).not.toContain(fakeKey);
    expect(row?.quote ?? "").not.toContain(fakeKey);
  });
  it("rejects a request spanning too many sessions", () => {
    const many = Array.from({ length: 26 }, (_, i) => obs({ contentSessionId: `cs-${i}` }));
    expect(claudeMemImportBodySchema.safeParse({ observations: many }).success).toBe(false);
  });
});
