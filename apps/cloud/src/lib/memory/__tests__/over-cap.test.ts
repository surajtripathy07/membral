// Over-cap repair: text/statement past HARD is cut and kept, never dropped for length.
import { describe, expect, it, vi } from "vitest";
import { LlmClient, type OpenAILike } from "@/lib/llm/client";
import type { ModelConfig } from "@/lib/llm/config";
import { extractUserTurnPass, extractWindow } from "../extract";
import { MEMORY_TEXT_MAX_HARD as HARD } from "../memory-limits";
import { OVER_CAP_TRIM, trimOverCap, trimToCap } from "../over-cap";
import { renderTurnLines, type TurnRow } from "../render";
import { buildWindows } from "../windows";

const CONFIG: ModelConfig = {
  model: "gpt-4o-mini",
  baseURL: undefined,
  apiKey: "test",
  embedModel: "text-embedding-3-small",
  embedDimensions: 1536,
};

function llmReplying(records: unknown[]) {
  const create = vi.fn().mockResolvedValue({
    choices: [{ message: { content: JSON.stringify({ records }) } }],
    usage: { prompt_tokens: 10, completion_tokens: 10 },
  });
  const client: OpenAILike = { chat: { completions: { create } }, embeddings: { create: vi.fn() } };
  return new LlmClient(CONFIG, { client });
}

function oneWindow() {
  const turns: TurnRow[] = [
    {
      idx: 0,
      role: "user",
      kind: "prose",
      text: "always run the migrations before deploying",
      tool_name: null,
      file_path: null,
      ts: null,
      props: null,
    },
  ];
  return buildWindows(renderTurnLines(turns))[0];
}

const SENT = "Switched the retry backoff to exponential in src/queue.ts after run 4412 timed out.";
const long = (n: number) => `${SENT} ${"word ".repeat(200)}`.slice(0, n);

describe("trimToCap", () => {
  it("leaves text at the cap and one below untouched", () => {
    expect(trimToCap("x".repeat(HARD))).toHaveLength(HARD);
    expect(trimToCap("x".repeat(HARD - 1))).toHaveLength(HARD - 1);
  });

  it("cuts HARD+1 characters to within the cap, at a word boundary with an ellipsis", () => {
    const out = trimToCap(`${"word ".repeat(120)}`.trim().slice(0, HARD + 1));
    expect(out.length).toBeLessThanOrEqual(HARD);
    expect(out.endsWith("…")).toBe(true);
    expect(out.slice(0, -1)).toMatch(/word$/);
  });

  it("cuts at the last sentence boundary when it keeps most of the text", () => {
    const text = `${SENT} ${"Then ".repeat(10).trim()}. ${"filler ".repeat(120)}`;
    const out = trimToCap(text);
    expect(out.endsWith(".")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(HARD);
    expect(out).toContain("src/queue.ts");
  });

  it("does not treat a dot inside a path as a sentence end", () => {
    const text = `Edited packages/core/src/index.ts and ${"more ".repeat(160)}`;
    const out = trimToCap(text);
    expect(out).toContain("packages/core/src/index.ts");
    expect(out.length).toBeLessThanOrEqual(HARD);
  });

  it("handles a single unbroken token", () => {
    const out = trimToCap("a".repeat(HARD + 100));
    expect(out).toHaveLength(HARD);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("trimOverCap", () => {
  it("boundary: 500 untouched, 501 trimmed", () => {
    expect(trimOverCap({ kind: "decision", text: "x".repeat(HARD) }).trimmed).toBe(false);
    expect(trimOverCap({ kind: "decision", text: long(HARD + 1) }).trimmed).toBe(true);
  });
  it("reads a preference's statement, not text", () => {
    const out = trimOverCap({ kind: "Preference ", statement: long(HARD + 100) });
    expect(out.trimmed).toBe(true);
    expect((out.record.statement as string).length).toBeLessThanOrEqual(HARD);
  });
  it("leaves non-string fields to the schema", () => {
    expect(trimOverCap({ kind: "decision", text: 5 }).trimmed).toBe(false);
  });
});

describe("extraction keeps an over-cap record", () => {
  const base = {
    kind: "decision",
    quote: "always run the migrations before deploying",
    turn_idx: 0,
    turn_role: "user",
  };

  it("main pass: a text over the hard cap is kept, trimmed, not dropped; siblings unaffected", async () => {
    const llm = llmReplying([
      { ...base, text: long(HARD + 1), durable: true },
      { ...base, text: "Run migrations before every deploy", durable: true },
    ]);
    const { result } = await extractWindow(llm, "header", [], oneWindow(), "s1");
    expect(result.records).toHaveLength(2);
    expect(result.records[0].text.length).toBeLessThanOrEqual(HARD);
    expect(result.records[0].text).toContain("src/queue.ts");
  });

  it("main pass: exactly the hard cap is kept unchanged", async () => {
    const text = long(HARD);
    const llm = llmReplying([{ ...base, text, durable: true }]);
    const { result } = await extractWindow(llm, "header", [], oneWindow(), "s1");
    expect(result.records[0].text).toBe(text.trim());
  });

  it("user pass: a long preference statement is kept", async () => {
    const llm = llmReplying([
      {
        kind: "preference",
        statement: long(HARD + 150),
        owner_quote: "always run the migrations before deploying",
        turn_idx: 0,
        turn_role: "user",
        durable: true,
      },
    ]);
    const out = await extractUserTurnPass(llm, "header", oneWindow(), "s1");
    expect(out.records).toHaveLength(1);
    expect(out.records[0].text.length).toBeLessThanOrEqual(HARD);
  });

  it("logs repaired:over_cap_trim and never a drop for length", async () => {
    const { log } = await import("@/lib/log");
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const llm = llmReplying([{ ...base, text: long(HARD + 50), durable: true }]);
    await extractWindow(llm, "header", [], oneWindow(), "s1");
    const lines = warn.mock.calls.filter((c) => String(c[0]).startsWith("memory-extract:"));
    expect(lines.some((c) => (c[1] as { reason?: string })?.reason === OVER_CAP_TRIM)).toBe(true);
    expect(lines.some((c) => String(c[0]).includes("dropped"))).toBe(false);
    warn.mockRestore();
  });
});

describe("trimToCap never splits an identifier, path or number", () => {
  // Filler sized so the hard limit falls inside the token; the token must be whole or absent.
  const withTokenAtLimit = (token: string, inside: number) => {
    const filler = "word ".repeat(200);
    const head = filler.slice(0, HARD - inside);
    const headAtWord = head.slice(0, head.lastIndexOf(" ") + 1);
    return `${headAtWord}${" ".repeat(HARD - inside - headAtWord.length)}${token} and the rest of the sentence follows here.`;
  };
  for (const token of ["bedHolders()", "agreement-beds.mjs", "scripts/pdf-render.mjs", "1.03"]) {
    it(`keeps ${token} whole or drops it whole`, () => {
      const out = trimToCap(withTokenAtLimit(token, Math.max(2, Math.floor(token.length / 2))));
      expect(out.length).toBeLessThanOrEqual(HARD);
      const stem = token.slice(0, 3);
      const present = out.includes(token);
      const partial = !present && out.includes(stem);
      expect(partial).toBe(false);
    });
  }
});

describe("trimToCap edge cases", () => {
  it("never splits a surrogate pair in the unbroken-token cut", () => {
    const out = trimToCap(`${"a".repeat(HARD - 2)}😀${"b".repeat(10)}`);
    expect(out.length).toBeLessThanOrEqual(HARD);
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it("never returns a stub the schema minimum would drop", () => {
    const out = trimToCap(`${"-".repeat(HARD - 1)} ${"-".repeat(HARD)}`);
    expect(out).not.toBe("…");
    expect(out.length).toBeGreaterThanOrEqual(8);
    expect(out.length).toBeLessThanOrEqual(HARD);
  });
});
