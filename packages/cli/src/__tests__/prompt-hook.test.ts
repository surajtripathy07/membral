import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_LINE_CHARS } from "../preamble-hook.js";
import {
  buildPromptHookOutput,
  CONTINUATION_FOCUS_MAX_CHARS,
  CONTINUATION_PREFIX,
  continuationFocusText,
  continuationSessionId,
  isContinuationPrompt,
  MAX_PROMPT_LINE_CHARS,
  PROMPT_HOOK_TIMEOUT_MS,
  promptHook,
  promptSkipReason,
} from "../prompt-hook.js";

const PROMPT = "src/legacy/ledger-sync.ts still calls the vendor API inline. Wrap it in the client helper.";
const HEADER = "Membral: past work related to this prompt (true when recorded; check live state yourself):";

// Field set of Claude Code's UserPromptSubmit hook input.
function hookInput(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    session_id: "sess-1",
    transcript_path: "/tmp/t.jsonl",
    cwd: "/tmp/nonexistent-repo",
    permission_mode: "default",
    hook_event_name: "UserPromptSubmit",
    prompt: PROMPT,
    ...overrides,
  });
}

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe("promptSkipReason", () => {
  it("skips slash commands and prompts under four words", () => {
    expect(promptSkipReason("/compact")).toBe("slash_command");
    expect(promptSkipReason("yes go ahead")).toBe("short_prompt");
    expect(promptSkipReason(PROMPT)).toBeNull();
  });
});

describe("promptHook", () => {
  let out: string;
  let root: string;
  const originalEnv = { ...process.env };
  const write = (s: string) => {
    out += s;
  };

  beforeEach(async () => {
    out = "";
    vi.spyOn(console, "error").mockImplementation(() => {});
    // resolveUploadConfig falls back to ~/.membral/credentials.json: isolate HOME.
    root = await mkdtemp(join(tmpdir(), "membral-prompt-hook-"));
    process.env.HOME = root;
    delete process.env.MEMBRAL_API_KEY;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  const run = (stdin: string, fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) =>
    promptHook({
      stdin: Readable.from([stdin]),
      apiKey: "lls_x",
      apiUrl: "https://membral.example",
      fetchImpl,
      hookLogPath: join(root, "hook.log"),
      write,
      ...extra,
    });

  it("POSTs prompt, repo and session, and prints UserPromptSubmit additionalContext", async () => {
    const lines = [
      HEADER,
      "[decision · 2d ago · session abcd1234] Keep src/legacy/ledger-sync.ts as the inline-call exception (#157)",
    ];
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ lines, record_ids: ["r1"] }));
    await run(hookInput(), fetchMock);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe("https://membral.example/api/memory/prompt-recall");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      prompt: PROMPT,
      repo: "/tmp/nonexistent-repo",
      session: "sess-1",
      budget_ms: PROMPT_HOOK_TIMEOUT_MS,
      line_max: MAX_PROMPT_LINE_CHARS,
    });
    expect(JSON.parse(out)).toEqual({
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: lines.join("\n") },
    });
  });

  it("sends at most 2,000 characters of the prompt", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ lines: [], record_ids: [] }));
    await run(hookInput({ prompt: `${PROMPT} ${"word ".repeat(2_000)}` }), fetchMock);
    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body.prompt).toHaveLength(2_000);
  });

  it("never sends slash commands or short prompts", async () => {
    const fetchMock = vi.fn();
    await run(hookInput({ prompt: "/review 12 please now" }), fetchMock);
    await run(hookInput({ prompt: "ok do it" }), fetchMock);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(out).toBe("");
  });

  it("prints nothing on an empty answer, a 500, bad JSON, a missing key or a malformed payload", async () => {
    await run(hookInput(), vi.fn().mockResolvedValue(jsonResponse({ lines: [], record_ids: [] })));
    await run(hookInput(), vi.fn().mockResolvedValue(jsonResponse({ error: "x" }, 500)));
    await run(hookInput(), vi.fn().mockResolvedValue(jsonResponse({ lines: "nope" })));
    await run("{not json", vi.fn());
    await run(hookInput({ prompt: 42 }), vi.fn());
    await promptHook({ stdin: Readable.from([hookInput()]), fetchImpl: vi.fn(), write, hookLogPath: join(root, "h") });
    expect(out).toBe("");
  });

  it("past its budget it resolves with nothing, never waiting on the server", async () => {
    const hang = vi.fn(
      (_u: unknown, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    const started = Date.now();
    await run(hookInput(), hang as unknown as typeof fetch, { timeoutMs: 150 });
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(out).toBe("");
  });

  it("caps the injected lines at MAX_PROMPT_LINES (header, 5 records + follow-ups, note, footer) and each line at MAX_PROMPT_LINE_CHARS", async () => {
    const lines = [
      HEADER,
      "x".repeat(MAX_PROMPT_LINE_CHARS + 50),
      "y".repeat(MAX_PROMPT_LINE_CHARS),
      ...Array.from({ length: 9 }, (_, i) => `r${i}`),
      "footer",
      "e",
    ];
    await run(hookInput(), vi.fn().mockResolvedValue(jsonResponse({ lines, record_ids: [] })));
    const ctx = (JSON.parse(out) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput
      .additionalContext;
    const injected = ctx.split("\n");
    expect(injected).toHaveLength(13);
    expect(injected[12]).toBe("footer");
    expect(injected[1]).toHaveLength(MAX_PROMPT_LINE_CHARS);
    expect(injected[1].endsWith("…")).toBe(true);
    // A full 420-char line (240-char record text + prefix, ref and URL) survives intact, past the preamble's cut.
    expect(MAX_PROMPT_LINE_CHARS).toBeGreaterThan(MAX_LINE_CHARS);
    expect(injected[2]).toBe("y".repeat(MAX_PROMPT_LINE_CHARS));
  });

  describe("hook.log outcome line", () => {
    const logLines = async () =>
      (await readFile(join(root, "hook.log"), "utf8"))
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as { hook: string; reason: string });

    it("logs served records with a duration", async () => {
      const lines = [HEADER, "a", "b", "c", "footer"];
      await run(hookInput(), vi.fn().mockResolvedValue(jsonResponse({ lines, record_ids: ["r1", "r2", "r3"] })));
      const logged = await logLines();
      expect(logged).toHaveLength(1);
      expect(logged[0].hook).toBe("prompt");
      expect(logged[0].reason).toMatch(/^prompt-recall: served 3 records in \d+ ms$/);
    });

    it("without record_ids, counts lines minus the header, follow-ups, the note and the footer", async () => {
      const lines = [
        HEADER,
        "a",
        "  ↳ later that session: shipped",
        "b",
        "These came from a memory_search on this prompt; a new search needs different terms, or open a source turn.",
        "Open a record's source: get_code_session id=x turn=1",
      ];
      await run(hookInput(), vi.fn().mockResolvedValue(jsonResponse({ lines })));
      expect((await logLines())[0].reason).toMatch(/^prompt-recall: served 2 records in \d+ ms$/);
    });

    it("logs the server's skip reason on an empty answer, no_match when it gives none", async () => {
      await run(
        hookInput(),
        vi.fn().mockResolvedValue(jsonResponse({ lines: [], record_ids: [], skipped: "unknown_repo", duration_ms: 5 })),
      );
      await run(hookInput(), vi.fn().mockResolvedValue(jsonResponse({ lines: [], record_ids: [] })));
      const logged = await logLines();
      expect(logged.map((l) => l.reason.replace(/\d+ ms/, "N ms"))).toEqual([
        "prompt-recall: unknown_repo in N ms",
        "prompt-recall: no_match in N ms",
      ]);
      expect(out).toBe("");
    });

    it("logs an http error with its status", async () => {
      await run(hookInput(), vi.fn().mockResolvedValue(jsonResponse({ error: "bad" }, 400)));
      const logged = await logLines();
      expect(logged.at(-1)?.reason).toMatch(/^prompt-recall: http 400 in \d+ ms$/);
      expect(out).toBe("");
    });

    it("logs a timeout with the budget", async () => {
      const hang = vi.fn(
        (_u: unknown, init?: RequestInit) =>
          new Promise<Response>((_, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          }),
      );
      await run(hookInput(), hang as unknown as typeof fetch, { timeoutMs: 150 });
      const logged = await logLines();
      // The 150 ms hook deadline beats the 3 s request timeout: a deferred cut with the request already sent.
      expect(logged.at(-1)?.reason).toMatch(/^prompt-recall: deferred after \d+ ms \(budget 150 ms, sent=true\)$/);
      expect(out).toBe("");
    });

    it("logs the request timeout kind with real elapsed time", async () => {
      const client = { call: vi.fn().mockResolvedValue({ ok: false, kind: "timeout", message: "t", attempts: 1 }) };
      await run(hookInput(), vi.fn(), { client });
      const logged = await logLines();
      expect(logged.at(-1)?.reason).toMatch(/^prompt-recall: timeout in \d+ ms \(request sent, no response\)$/);
      expect(out).toBe("");
    });

    it("logs a deferred cut before any request as sent=false", async () => {
      const client = { call: vi.fn().mockResolvedValue({ ok: false, kind: "deferred", waitMs: 0, sent: false }) };
      await run(hookInput(), vi.fn(), { client });
      const logged = await logLines();
      expect(logged.at(-1)?.reason).toMatch(/^prompt-recall: deferred after \d+ ms \(budget 4000 ms, sent=false\)$/);
      expect(out).toBe("");
    });

    it("logs a local skip and never the prompt text or the key", async () => {
      await run(hookInput({ prompt: "ok do it" }), vi.fn());
      await run(hookInput(), vi.fn().mockResolvedValue(jsonResponse({ lines: [HEADER, "a"], record_ids: ["r1"] })));
      const raw = await readFile(join(root, "hook.log"), "utf8");
      expect(raw).not.toContain("ok do it");
      expect(raw).not.toContain("Convert it");
      expect(raw).not.toContain("lls_x");
      const logged = await logLines();
      expect(logged[0].reason).toBe("prompt-recall: skipped short_prompt");
      expect(logged[1].reason).toMatch(/^prompt-recall: served 1 record in \d+ ms$/);
    });
  });

  it("buildPromptHookOutput is Claude Code's UserPromptSubmit shape", () => {
    expect(buildPromptHookOutput("ctx")).toEqual({
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "ctx" },
    });
  });
});

const CONTINUED = "0a1b2c3d-1111-4222-8333-444455556666";
const OTHER_UUID = "9f8e7d6c-aaaa-4bbb-8ccc-dddddddddddd";
/** A synthetic compaction summary in Claude Code's section layout (no real session content). */
function summary(opts: { pointer?: boolean; sections?: boolean } = {}): string {
  const { pointer = true, sections = true } = opts;
  return [
    `${CONTINUATION_PREFIX} The summary below covers the earlier portion of the conversation.`,
    "",
    "Summary:",
    ...(sections
      ? [
          "1. Goal:",
          "   Rename the widget store and keep the API stable.",
          "2. Reading:",
          `   - Read /home/dev/.claude/projects/-home-dev-app/${OTHER_UUID}.jsonl for an older run`,
          "4. Pending items:",
          "   - Port the cache layer to the new store",
          "5. Current work in hand:",
          "   Was editing src/widgets/store.ts to drop the legacy adapter.",
          "6. Next step:",
          "   Run the widget store tests and fix the adapter import.",
        ]
      : ["Worked on the widget store rename; the adapter import still fails in the store tests."]),
    "",
    ...(pointer
      ? [
          `If you need specific details from before compaction, read the full transcript at: /home/dev/.claude/projects/-home-dev-app/${CONTINUED}.jsonl`,
        ]
      : []),
    "Continue the conversation from where it left off without asking the user any further questions.",
  ].join("\n");
}

describe("continuation detection", () => {
  it("matches only Claude Code's compaction opener", () => {
    expect(isContinuationPrompt(summary())).toBe(true);
    expect(isContinuationPrompt(`  ${summary()}`)).toBe(true);
    expect(isContinuationPrompt(PROMPT)).toBe(false);
    expect(isContinuationPrompt(`Quoting: ${CONTINUATION_PREFIX}`)).toBe(false);
  });

  it("takes the uuid from the 'full transcript at:' pointer over other transcript paths", () => {
    expect(continuationSessionId(summary(), "hook-session")).toBe(CONTINUED);
  });

  it("without the pointer, the hook's session_id (a path named in the summary is ignored); with neither, null", () => {
    expect(continuationSessionId(summary({ pointer: false }), "hook-session")).toBe("hook-session");
    expect(continuationSessionId(summary({ pointer: false }))).toBeNull();
    expect(continuationSessionId(summary({ pointer: false, sections: false }), "hook-session")).toBe("hook-session");
    expect(continuationSessionId(summary({ pointer: false, sections: false }), "bad id with spaces")).toBeNull();
    expect(continuationSessionId(summary({ pointer: false, sections: false }))).toBeNull();
  });
});

describe("continuation pointer and focus: last wins", () => {
  const OTHER = "11111111-2222-4333-8444-555555555555";
  it("takes the LAST 'full transcript at:' pointer, not a quoted earlier one", () => {
    const text = [
      CONTINUATION_PREFIX,
      `The user pasted: read the full transcript at: /x/${OTHER}.jsonl`,
      `If you need specific details from before compaction, read the full transcript at: /x/${CONTINUED}.jsonl`,
    ].join("\n");
    expect(continuationSessionId(text, "hook-session")).toBe(CONTINUED);
  });

  it("uses the LAST next-step section and keeps text after a quoted pointer", () => {
    const text = [
      CONTINUATION_PREFIX,
      "## Next steps",
      "Old quoted plan.",
      `Quoted: read the full transcript at: /x/${OTHER}.jsonl`,
      "## Next steps",
      "Real plan: run the store tests.",
      `read the full transcript at: /x/${CONTINUED}.jsonl`,
      "Continue the conversation from where it left off.",
    ].join("\n");
    expect(continuationFocusText(text)).toBe("Real plan: run the store tests.");
  });
});

describe("continuationFocusText", () => {
  it("keeps the next-step, pending and current-work bodies, in that order, and nothing else", () => {
    const focus = continuationFocusText(summary());
    expect(focus.indexOf("Run the widget store tests")).toBe(0);
    expect(focus).toContain("Port the cache layer");
    expect(focus).toContain("src/widgets/store.ts");
    expect(focus.indexOf("Port the cache layer")).toBeLessThan(focus.indexOf("src/widgets/store.ts"));
    expect(focus).not.toContain("Rename the widget store");
    expect(focus).not.toContain("full transcript at");
    expect(focus).not.toContain(CONTINUATION_PREFIX);
  });

  it("without those headings, the last 800 chars before the closing instructions", () => {
    const long = summary({ sections: false }).replace("Summary:", `Summary:\n${"filler words here ".repeat(100)}`);
    const focus = continuationFocusText(long);
    expect(focus.length).toBeLessThanOrEqual(CONTINUATION_FOCUS_MAX_CHARS);
    expect(focus.endsWith("the adapter import still fails in the store tests.")).toBe(true);
    expect(focus).not.toContain("Continue the conversation");
  });

  it("is idempotent on its own output", () => {
    const once = continuationFocusText(summary());
    expect(continuationFocusText(once)).toBe(once);
  });
});

describe("promptHook continuation", () => {
  let root: string;
  let out: string;
  const originalEnv = { ...process.env };
  beforeEach(async () => {
    out = "";
    vi.spyOn(console, "error").mockImplementation(() => {});
    root = await mkdtemp(join(tmpdir(), "membral-prompt-hook-cont-"));
    process.env.HOME = root;
    delete process.env.MEMBRAL_API_KEY;
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
  });
  const run = (stdin: string, fetchImpl: typeof fetch) =>
    promptHook({
      stdin: Readable.from([stdin]),
      apiKey: "lls_x",
      apiUrl: "https://membral.example",
      fetchImpl,
      hookLogPath: join(root, "hook.log"),
      write: (s: string) => {
        out += s;
      },
    });

  it("sends the focus text and continuation {source_session_id, harness}, and logs the continuation path", async () => {
    const lines = ["Membral: what this session recorded…", "[decision · 1d ago · session 0a1b2c3d] Keep the API"];
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ lines, record_ids: ["r1"], mode: "continuation", self_records: 1 }));
    await run(hookInput({ prompt: summary() }), fetchMock);
    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body.continuation).toEqual({ source_session_id: CONTINUED, harness: "claude-code" });
    expect(body.prompt).toBe(continuationFocusText(summary()));
    expect(body.prompt).not.toContain(CONTINUATION_PREFIX);
    expect(body.session).toBe("sess-1");
    expect(JSON.parse(out).hookSpecificOutput.additionalContext).toBe(lines.join("\n"));
    const log = await readFile(join(root, "hook.log"), "utf8");
    expect(log).toMatch(/prompt-recall: continuation served 1 record in \d+ ms/);
  });

  it("a same-session compaction with no path in the summary uses the hook's session_id", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ lines: [], record_ids: [], skipped: "no_session_records" }));
    await run(hookInput({ prompt: summary({ pointer: false, sections: false }) }), fetchMock);
    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body.continuation).toEqual({ source_session_id: "sess-1", harness: "claude-code" });
    expect(out).toBe("");
    expect(await readFile(join(root, "hook.log"), "utf8")).toMatch(/prompt-recall: continuation no_session_records/);
  });

  it("normal prompts send no continuation field", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ lines: [], record_ids: [] }));
    await run(hookInput(), fetchMock);
    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body.continuation).toBeUndefined();
  });
});

describe("promptHook dedupe across a session's prompts", () => {
  let out: string;
  let root: string;
  const originalEnv = { ...process.env };
  const ID_A = "0a1b2c3d-1111-4222-8333-444455556666";
  const ID_B = "9f8e7d6c-aaaa-4bbb-8ccc-dddddddddddd";
  const ID_C = "11111111-2222-4333-8444-555555555555";
  const LINES = [HEADER, "[decision · 2d ago · session abcd1234] Keep the inline-call exception (#157)"];
  const stateDir = () => join(root, "hook-state", "prompt-recall");

  beforeEach(async () => {
    out = "";
    vi.spyOn(console, "error").mockImplementation(() => {});
    root = await mkdtemp(join(tmpdir(), "membral-prompt-dedupe-"));
    process.env.HOME = root;
    delete process.env.MEMBRAL_API_KEY;
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  const run = (stdin: string, fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) =>
    promptHook({
      stdin: Readable.from([stdin]),
      apiKey: "lls_x",
      apiUrl: "https://membral.example",
      fetchImpl,
      hookLogPath: join(root, "hook.log"),
      write: (s: string) => {
        out += s;
      },
      ...extra,
    });
  const bodyOf = (fetchMock: ReturnType<typeof vi.fn>, n: number) =>
    JSON.parse(String((fetchMock.mock.calls[n] as [string, RequestInit])[1].body));

  it("the second prompt of a session carries the first call's ids; the first carries none", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ lines: LINES, record_ids: [ID_A, ID_B] }))
      .mockResolvedValueOnce(jsonResponse({ lines: LINES, record_ids: [ID_C] }));
    await run(hookInput(), fetchMock);
    // The first prompt prints the served lines.
    expect(JSON.parse(out).hookSpecificOutput.additionalContext).toBe(LINES.join("\n"));
    out = "";
    await run(hookInput(), fetchMock);
    expect(bodyOf(fetchMock, 0)).not.toHaveProperty("exclude_record_ids");
    expect(bodyOf(fetchMock, 1).exclude_record_ids).toEqual([ID_A, ID_B]);
    out = "";
    await run(hookInput(), fetchMock.mockResolvedValueOnce(jsonResponse({ lines: [], record_ids: [] })));
    expect(bodyOf(fetchMock, 2).exclude_record_ids).toEqual([ID_A, ID_B, ID_C]);
    // Every candidate already sent: the server answers empty and nothing is printed.
    expect(out).toBe("");
  });

  it("a response with fresh records and a pointer line stores only the fresh ids and counts the pointer as no record", async () => {
    const pointer = `Also relevant, shown earlier this session: Keep the older ruling (#${ID_B.slice(0, 8)})`;
    const lines = [HEADER, LINES[1], pointer];
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ lines, record_ids: [ID_A] }));
    await run(hookInput(), fetchMock);
    expect(JSON.parse(out).hookSpecificOutput.additionalContext).toBe(lines.join("\n"));
    expect(JSON.parse(await readFile(join(stateDir(), "sess-1.json"), "utf8"))).toEqual({ ids: [ID_A] });
    // Without record_ids the count falls back to the lines: header and pointer are not records.
    await run(hookInput({ session_id: "sess-2" }), vi.fn().mockResolvedValue(jsonResponse({ lines })));
    const log = await readFile(join(root, "hook.log"), "utf8");
    expect(log.match(/served 1 record /g)).toHaveLength(2);
  });

  it("a different session is unaffected", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ lines: LINES, record_ids: [ID_A] }));
    await run(hookInput({ session_id: "sess-1" }), fetchMock);
    await run(hookInput({ session_id: "sess-2" }), fetchMock);
    expect(bodyOf(fetchMock, 1)).not.toHaveProperty("exclude_record_ids");
  });

  it("writes no state for an empty answer, a failed request or a print that throws", async () => {
    await run(hookInput(), vi.fn().mockResolvedValue(jsonResponse({ lines: [], record_ids: [] })));
    await run(hookInput(), vi.fn().mockResolvedValue(jsonResponse({ error: "x" }, 500)));
    await run(hookInput(), vi.fn().mockResolvedValue(jsonResponse({ lines: LINES, record_ids: [ID_A] })), {
      write: () => {
        throw new Error("EPIPE");
      },
    });
    await expect(stat(stateDir())).rejects.toThrow();
    // The first two printed nothing; the third attempted a print that threw.
    expect(out).toBe("");
  });

  it("a corrupt or wrongly shaped state file behaves as no state", async () => {
    await mkdir(stateDir(), { recursive: true });
    const file = join(stateDir(), "sess-1.json");
    for (const content of ["{not json", JSON.stringify({ ids: "nope" }), JSON.stringify({ ids: [42, "x"] })]) {
      await writeFile(file, content);
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ lines: [], record_ids: [] }));
      await run(hookInput(), fetchMock);
      expect(bodyOf(fetchMock, 0)).not.toHaveProperty("exclude_record_ids");
    }
  });

  it("sanitises the session id into a file name and prunes state files older than seven days", async () => {
    await mkdir(stateDir(), { recursive: true });
    const old = join(stateDir(), "old-session.json");
    await writeFile(old, JSON.stringify({ ids: [ID_C] }));
    const eightDays = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await utimes(old, eightDays, eightDays);
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ lines: LINES, record_ids: [ID_A] }));
    await run(hookInput({ session_id: "../evil/sess:1" }), fetchMock);
    await expect(stat(old)).rejects.toThrow();
    const saved = JSON.parse(await readFile(join(stateDir(), "__evil_sess_1.json"), "utf8"));
    expect(saved).toEqual({ ids: [ID_A] });
  });
});
