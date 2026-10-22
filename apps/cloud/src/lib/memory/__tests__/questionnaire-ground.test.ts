import { describe, expect, it } from "vitest";
import { groundAndRedact, groundSelfReport } from "../questionnaire-ground";

const empty = { q1: [], q2: [], q3: [], q4: [] };
const TURN = "I switched the retries to exponential backoff after the 504";

describe("groundAndRedact", () => {
  it("drops items whose turn is not in the session and keeps grounded ones", () => {
    const r = groundAndRedact(
      {
        ...empty,
        q1: [
          { line: "- retries use backoff", turn: "switched the retries to exponential backoff" },
          { line: "- other", turn: "this text was never said anywhere" },
        ],
      },
      [TURN],
    );
    expect(r.kept).toBe(1);
    expect(r.dropped).toBe(1);
    expect(r.answers.q1).toHaveLength(1);
  });

  it("redacts emails and secrets in line, turn and worked_out", () => {
    const t = "mail me at jo@example.com with key AKIAIOSFODNN7EXAMPLE";
    const r = groundAndRedact(
      {
        ...empty,
        q4: [{ line: "ask jo@example.com", turn: "mail me at jo@example.com", worked_out: "x jo@example.com" }],
      },
      [t],
    );
    const item = r.answers.q4[0];
    expect(item?.line).not.toContain("jo@example.com");
    expect(item?.turn).not.toContain("jo@example.com");
    expect(item?.worked_out).not.toContain("jo@example.com");
  });

  it("an unuploaded session grounds nothing", () => {
    const r = groundAndRedact({ ...empty, q1: [{ line: "l", turn: "some long turn excerpt" }] }, []);
    expect(r.kept).toBe(0);
  });
});

describe("groundSelfReport", () => {
  function fake(sessionRows: unknown[], turnRows: unknown[]) {
    const chain = (rows: unknown[]) => {
      const p: Promise<unknown> & Record<string, unknown> = Object.assign(
        Promise.resolve({ data: rows, error: null }),
        {} as Record<string, unknown>,
      );
      for (const m of ["select", "eq", "order", "limit"]) p[m] = () => p;
      p.range = () => Promise.resolve({ data: rows, error: null });
      return p;
    };
    return { from: (t: string) => chain(t === "code_sessions" ? sessionRows : turnRows) } as never;
  }
  it("grounds against the uploaded turns of the user's session", async () => {
    const r = await groundSelfReport(fake([{ id: "s1" }], [{ idx: 0, text: TURN }]), "u", "src", {
      ...empty,
      q1: [{ line: "l", turn: "switched the retries to exponential backoff" }],
    });
    expect(r.kept).toBe(1);
  });
  it("drops everything when the session is not uploaded", async () => {
    const r = await groundSelfReport(fake([], []), "u", "src", {
      ...empty,
      q1: [{ line: "l", turn: "switched the retries to exponential backoff" }],
    });
    expect(r.kept).toBe(0);
  });
});
