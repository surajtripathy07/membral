import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatAgreementLine, parseDogfood, renderDigest } from "../dogfood.js";
import type { ApiClient } from "../lib/api-client.js";
import { preambleHook } from "../preamble-hook.js";
import { promptHook } from "../prompt-hook.js";
import {
  buildQuestionnaireEnv,
  buildQuestionnairePrompt,
  defaultClaudeRunner,
  diagnoseNoAnswer,
  extractInjectedLines,
  isQuestionnaireSession,
  parseAnswers,
  parseClaudeOutput,
  QUESTION_IDS,
  QUESTIONS,
  questionnaireClaudeArgs,
  questionnaireForkRefusal,
  runQuestionnaireChild,
  shuffleOrder,
} from "../questionnaire.js";
import { sessionEndHook } from "../session-end-hook.js";

const runChild = (o: Parameters<typeof runQuestionnaireChild>[0]) => runQuestionnaireChild({ env: {}, ...o });
const SID = "44444444-4444-4444-8444-444444444444";

function attachment(content: string[]): string {
  return JSON.stringify({ type: "attachment", attachment: { type: "hook_additional_context", content } });
}
const PREAMBLE = attachment([
  "Membral memory for acme (harness-injected context, not a user message).\n- [decision] Queue retries use exponential backoff capped at 30 s\nTools: memory_search, memory_recall, session_summary.\nrecall_token: v1.abc",
]);
const PROMPT = attachment([
  "Membral: past work related to this prompt (true when recorded; check live state yourself):\n- [outcome] The import route returns 504 after 10 s on large files\n  ↳ later that session: fixed\nOpen a record's source: get_code_session abc turn=3",
]);
const OTHER = attachment(["Some other plugin context\n- unrelated line"]);

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "membral-questionnaire-"));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(root, { recursive: true, force: true });
});

describe("extractInjectedLines", () => {
  it("keeps content lines of this CLI's injected blocks only, minus header and boilerplate", () => {
    const text = [PREAMBLE, "not json", PROMPT, OTHER, PREAMBLE].join("\n");
    expect(extractInjectedLines(text)).toEqual([
      "- [decision] Queue retries use exponential backoff capped at 30 s",
      "- [outcome] The import route returns 504 after 10 s on large files",
    ]);
  });
});

describe("questions and prompt", () => {
  it("never names the tool and never asks whether it was useful", () => {
    const prompt = buildQuestionnairePrompt(shuffleOrder(), ["- a line"]);
    for (const q of Object.values(QUESTIONS)) {
      expect(q).not.toMatch(/membral/i);
      expect(q).not.toMatch(/useful/i);
    }
    expect(prompt).not.toMatch(/membral/i);
    expect(prompt).not.toMatch(/useful/i);
  });

  it("asks in the shuffled order, each question once", () => {
    const order = shuffleOrder(() => 0);
    expect([...order].sort()).toEqual([...QUESTION_IDS]);
    expect(order).not.toEqual([...QUESTION_IDS]);
    const prompt = buildQuestionnairePrompt(order, ["- x"]);
    const at = order.map((q) => prompt.indexOf(`${q}. `));
    expect(at).toEqual([...at].sort((a, b) => a - b));
  });
});

describe("parseAnswers (turn-pointer rule)", () => {
  it("drops items without a turn pointer and keeps the rest", () => {
    const a = parseAnswers({
      q1: [
        { line: "- [decision] Queue retries", turn: "I switched the retry to backoff" },
        { line: "- no pointer" },
        { line: "- short pointer", turn: "ok" },
      ],
      q4: [{ line: "- x", turn: "worked out the 504 cause", worked_out: "504 after 10 s" }],
    });
    expect(a?.q1).toEqual([{ line: "- [decision] Queue retries", turn: "I switched the retry to backoff" }]);
    expect(a?.q2).toEqual([]);
    expect(a?.q4[0]?.worked_out).toBe("504 after 10 s");
  });
  it("is null for a malformed answer", () => {
    expect(parseAnswers(null)).toBeNull();
    expect(parseAnswers({ q1: "nope" })).toBeNull();
    expect(parseAnswers({ other: [] })).toBeNull();
    expect(parseClaudeOutput("not json")).toBeNull();
    expect(parseClaudeOutput(JSON.stringify({ is_error: true, result: "{}" }))).toBeNull();
    expect(parseClaudeOutput(JSON.stringify({ result: '```json\n{"q1":[]}\n```' }))).toEqual({ q1: [] });
  });
});

describe("runQuestionnaireChild", () => {
  const answer = {
    q1: [
      {
        line: "- [decision] Queue retries use exponential backoff capped at 30 s",
        turn: "switching retries to backoff",
      },
    ],
    q2: [],
    q3: [{ line: "- [outcome] The import route returns 504" }],
    q4: [],
  };
  async function setup(): Promise<{ transcript: string; log: string }> {
    const transcript = join(root, `${SID}.jsonl`);
    await writeFile(transcript, [PREAMBLE, PROMPT].join("\n"));
    return { transcript, log: join(root, "hook.log") };
  }

  it("forks the session, records the order, drops pointerless items and uploads", async () => {
    const { transcript, log } = await setup();
    const runClaude = vi.fn(async () => JSON.stringify({ type: "result", result: JSON.stringify(answer) }));
    const call = vi.fn(async () => ({ ok: true, status: 200, data: { stored: true } }));
    const reason = await runChild({
      sessionId: SID,
      transcriptPath: transcript,
      cwd: "/home/dev/acme",
      hookLogPath: log,
      syncAllowlistPath: join(root, "no-sync.json"),
      runClaude,
      client: { call } as unknown as ApiClient,
      rng: () => 0,
    });
    expect(runClaude.mock.calls[0]?.[0]).toEqual(questionnaireClaudeArgs(SID));
    expect(runClaude.mock.calls[0]?.[2]).toBe("/home/dev/acme");
    expect(runClaude.mock.calls[0]?.[3]).toBe(120_000);
    const body = (call.mock.calls[0] as unknown as [string, { json: Record<string, unknown> }])[1].json;
    expect(body.order).toEqual(shuffleOrder(() => 0));
    expect((body.answers as Record<string, unknown[]>).q1).toHaveLength(1);
    expect((body.answers as Record<string, unknown[]>).q3).toEqual([]);
    expect(reason).toBe(`stored 1 item(s) order ${shuffleOrder(() => 0).join(",")}`);
    expect(await readFile(log, "utf8")).toContain('"hook":"questionnaire"');
  });

  it("is silent on an old server's 404 and stores nothing on a malformed answer", async () => {
    const { transcript, log } = await setup();
    const call = vi.fn(async () => ({ ok: false, kind: "http", status: 404, detail: "" }));
    const ok = vi.fn(async () => JSON.stringify({ result: JSON.stringify(answer) }));
    expect(
      await runChild({
        sessionId: SID,
        transcriptPath: transcript,
        cwd: "/home/dev/acme",
        hookLogPath: log,
        syncAllowlistPath: join(root, "no-sync.json"),
        runClaude: ok,
        client: { call } as unknown as ApiClient,
      }),
    ).toBe("skipped server_has_no_route");
    call.mockClear();
    const bad = vi.fn(async () => JSON.stringify({ result: "I acted on the first line." }));
    expect(
      await runChild({
        sessionId: SID,
        transcriptPath: transcript,
        cwd: "/home/dev/acme",
        hookLogPath: log,
        syncAllowlistPath: join(root, "no-sync.json"),
        runClaude: bad,
        client: { call } as unknown as ApiClient,
      }),
    ).toBe("malformed answer — nothing stored");
    expect(call).not.toHaveBeenCalled();
  });

  it("the fork is never persisted and runs locked down: no tools, no MCP, one turn", () => {
    expect(questionnaireClaudeArgs(SID)).toEqual([
      "-p",
      "--resume",
      SID,
      "--fork-session",
      "--no-session-persistence",
      "--tools",
      "",
      "--setting-sources",
      "",
      "--strict-mcp-config",
      "--model",
      "sonnet",
      "--max-turns",
      "1",
      "--output-format",
      "json",
    ]);
    expect(questionnaireClaudeArgs(SID)).not.toContain("--mcp-config");
  });

  it("refuses to fork nested, headless or API-billed sessions", () => {
    expect(questionnaireForkRefusal({})).toBeNull();
    expect(questionnaireForkRefusal({ CLAUDE_CODE_ENTRYPOINT: "cli" })).toBeNull();
    expect(questionnaireForkRefusal({ MEMBRAL_QUESTIONNAIRE: "1" })).toBe("nested_questionnaire");
    expect(questionnaireForkRefusal({ CLAUDE_CODE_CHILD_SESSION: "1" })).toBe("nested_session");
    expect(questionnaireForkRefusal({ CLAUDE_CODE_ENTRYPOINT: "sdk-cli" })).toBe("headless_session");
    expect(questionnaireForkRefusal({ ANTHROPIC_API_KEY: "sk-x" })).toBe("billing_env_anthropic_api_key");
    expect(questionnaireForkRefusal({ CLAUDE_CODE_USE_BEDROCK: "1" })).toBe("billing_env_claude_code_use_bedrock");
  });

  it("the fork env is an allowlist and always carries the recursion guard", () => {
    const env = buildQuestionnaireEnv({
      PATH: "/bin",
      HOME: "/h",
      LC_ALL: "C",
      ANTHROPIC_API_KEY: "sk-x",
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_CODE_ENTRYPOINT: "cli",
      AWS_SECRET_ACCESS_KEY: "s",
      MEMBRAL_API_KEY: "lls_k",
    });
    expect(env).toEqual({ PATH: "/bin", HOME: "/h", LC_ALL: "C", MEMBRAL_QUESTIONNAIRE: "1" });
  });

  it("defaultClaudeRunner spawns claude with MEMBRAL_QUESTIONNAIRE=1 and no foreign env", async () => {
    const bin = join(root, "bin");
    await mkdir(bin, { recursive: true });
    await writeFile(
      join(bin, "claude"),
      '#!/bin/sh\necho "guard=$MEMBRAL_QUESTIONNAIRE key=${ANTHROPIC_API_KEY:-none} mk=${MEMBRAL_API_KEY:-none}"\n',
      { mode: 0o755 },
    );
    const saved = { ...process.env };
    process.env.PATH = `${bin}:${process.env.PATH}`;
    process.env.ANTHROPIC_API_KEY = "sk-should-not-leak";
    process.env.MEMBRAL_API_KEY = "lls_should-not-leak";
    try {
      const out = await defaultClaudeRunner(["-p"], "in", root, 5000);
      expect(out.trim()).toBe("guard=1 key=none mk=none");
    } finally {
      process.env = saved;
    }
  });

  it("the child skips with a reason when the environment forbids a fork", async () => {
    const { transcript, log } = await setup();
    const runClaude = vi.fn();
    const reason = await runQuestionnaireChild({
      sessionId: SID,
      transcriptPath: transcript,
      cwd: "/home/dev/acme",
      hookLogPath: log,
      runClaude,
      env: { ANTHROPIC_API_KEY: "sk-x" },
    });
    expect(reason).toBe("skipped billing_env_anthropic_api_key");
    expect(runClaude).not.toHaveBeenCalled();
  });

  it("names the real reason when nothing came back", () => {
    expect(diagnoseNoAnswer("")).toContain("no_output");
    expect(diagnoseNoAnswer(JSON.stringify({ is_error: true, result: "No conversation found" }))).toContain(
      "No conversation found",
    );
    expect(diagnoseNoAnswer("not json")).toContain("unparsable");
  });

  it("recognises a questionnaire fork by its prompt on any user turn, so imports skip it", () => {
    const prompt = buildQuestionnairePrompt(
      shuffleOrder(() => 0),
      ["a line"],
    );
    const fork = {
      turns: [
        { role: "user", kind: "prose", text: "fix the import route" },
        { role: "assistant", kind: "prose", text: "done" },
        { role: "user", kind: "prose", text: prompt },
      ],
    };
    expect(isQuestionnaireSession(fork)).toBe(true);
    expect(isQuestionnaireSession({ turns: fork.turns.slice(0, 2) })).toBe(false);
    expect(isQuestionnaireSession({ turns: [{ role: "assistant", kind: "prose", text: prompt }] })).toBe(false);
    // a fork answered once is still a fork
    expect(isQuestionnaireSession({ turns: [...fork.turns, { role: "assistant", kind: "prose", text: "{}" }] })).toBe(
      true,
    );
  });

  it("uploads a genuine session that pasted the prompt earlier and kept working", () => {
    const prompt = buildQuestionnairePrompt(
      shuffleOrder(() => 0),
      ["a line"],
    );
    const t = (role: string, text: string) => ({ role, kind: "prose", text });
    expect(
      isQuestionnaireSession({
        turns: [t("user", prompt), t("assistant", "a"), t("user", "now fix the route"), t("assistant", "ok")],
      }),
    ).toBe(false);
    expect(isQuestionnaireSession({ turns: [t("user", prompt), t("assistant", "a"), t("assistant", "b")] })).toBe(
      false,
    );
  });

  it("does not fail open on the allowlist: uses the transcript's own cwd, and skips with none", async () => {
    const sync = join(root, "sync.json");
    await writeFile(
      sync,
      JSON.stringify({
        version: 1,
        defaultNewProjects: true,
        harnesses: { "claude-code": { projects: [{ path: "/home/dev/acme", enabled: false }] } },
      }),
    );
    const log = join(root, "hook.log");
    const withCwd = join(root, "with-cwd.jsonl");
    await writeFile(
      withCwd,
      [
        JSON.stringify({ type: "user", cwd: "/home/dev/acme", message: { role: "user", content: "hi" } }),
        PREAMBLE,
      ].join("\n"),
    );
    const runClaude = vi.fn();
    const base = { sessionId: SID, hookLogPath: log, syncAllowlistPath: sync, runClaude };
    expect(await runChild({ ...base, transcriptPath: withCwd })).toBe("skipped project_disabled");
    const noCwd = join(root, "no-cwd.jsonl");
    await writeFile(noCwd, PREAMBLE);
    expect(await runChild({ ...base, transcriptPath: noCwd })).toBe("skipped no_cwd");
    expect(runClaude).not.toHaveBeenCalled();
  });

  it("skips a project disabled in sync.json before running claude, and logs it", async () => {
    const { transcript, log } = await setup();
    const sync = join(root, "sync.json");
    await writeFile(
      sync,
      JSON.stringify({
        version: 1,
        defaultNewProjects: true,
        harnesses: { "claude-code": { projects: [{ path: "/home/dev/acme", enabled: false }] } },
      }),
    );
    const runClaude = vi.fn();
    expect(
      await runChild({
        sessionId: SID,
        transcriptPath: transcript,
        cwd: "/home/dev/acme",
        hookLogPath: log,
        syncAllowlistPath: sync,
        runClaude,
      }),
    ).toBe("skipped project_disabled");
    expect(runClaude).not.toHaveBeenCalled();
    expect(await readFile(log, "utf8")).toContain("skipped project_disabled");
  });

  it("does not run claude when nothing was injected", async () => {
    const transcript = join(root, "plain.jsonl");
    await writeFile(transcript, OTHER);
    const runClaude = vi.fn();
    expect(
      await runChild({
        sessionId: SID,
        transcriptPath: transcript,
        hookLogPath: join(root, "h"),
        syncAllowlistPath: join(root, "no-sync.json"),
        runClaude,
      }),
    ).toBe("skipped no_injected_lines");
    expect(runClaude).not.toHaveBeenCalled();
  });
});

describe("session-end hook trigger and recursion guard", () => {
  const input = (transcript: string) =>
    Readable.from([JSON.stringify({ session_id: SID, transcript_path: transcript, cwd: "/home/dev/acme" })]);

  it("spawns a detached questionnaire child next to the upload when enabled, and returns fast", async () => {
    const cfg = join(root, "config.json");
    await writeFile(cfg, JSON.stringify({ dogfood: { questionnaire: true } }));
    const transcript = join(root, `${SID}.jsonl`);
    await writeFile(transcript, PREAMBLE);
    const spawnDeferred = vi.fn();
    const t0 = performance.now();
    await sessionEndHook({
      stdin: input(transcript),
      hookLogPath: join(root, "hook.log"),
      cliConfigPath: cfg,
      spawnDeferred,
      env: {},
    });
    expect(performance.now() - t0).toBeLessThan(500);
    const calls = spawnDeferred.mock.calls.map((c) => c[0] as string[]);
    expect(calls).toContainEqual([
      "session-end-hook",
      "--questionnaire",
      SID,
      "--deferred-path",
      transcript,
      "--cwd",
      "/home/dev/acme",
    ]);
    expect(calls).toContainEqual(["session-end-hook", "--deferred-path", transcript]);
  });

  it("does not spawn the questionnaire in a headless session or for another harness", async () => {
    const cfg = join(root, "config.json");
    await writeFile(cfg, JSON.stringify({ dogfood: { questionnaire: true } }));
    const transcript = join(root, `${SID}.jsonl`);
    await writeFile(transcript, PREAMBLE);
    const spawnDeferred = vi.fn();
    await sessionEndHook({
      stdin: input(transcript),
      hookLogPath: join(root, "hook.log"),
      cliConfigPath: cfg,
      spawnDeferred,
      env: { CLAUDE_CODE_ENTRYPOINT: "sdk-cli" },
    });
    expect(spawnDeferred.mock.calls.map((c) => (c[0] as string[])[1])).toEqual(["--deferred-path"]);
  });

  it("does not spawn the questionnaire when off (default)", async () => {
    const transcript = join(root, `${SID}.jsonl`);
    await writeFile(transcript, PREAMBLE);
    const spawnDeferred = vi.fn();
    await sessionEndHook({
      stdin: input(transcript),
      hookLogPath: join(root, "hook.log"),
      cliConfigPath: join(root, "missing.json"),
      spawnDeferred,
      env: {},
    });
    expect(spawnDeferred.mock.calls.map((c) => (c[0] as string[])[1])).toEqual(["--deferred-path"]);
  });

  it("does nothing at all inside the questionnaire's own run (no upload, no questionnaire, no log)", async () => {
    const cfg = join(root, "config.json");
    await writeFile(cfg, JSON.stringify({ dogfood: { questionnaire: true } }));
    const transcript = join(root, `${SID}.jsonl`);
    const spawnDeferred = vi.fn();
    const log = join(root, "hook.log");
    const env = { MEMBRAL_QUESTIONNAIRE: "1" };
    await sessionEndHook({ stdin: input(transcript), hookLogPath: log, cliConfigPath: cfg, spawnDeferred, env });
    expect(spawnDeferred).not.toHaveBeenCalled();
    const write = vi.fn();
    const fetchImpl = vi.fn();
    await promptHook({ stdin: Readable.from(["{}"]), hookLogPath: log, env, write, fetchImpl } as never);
    await preambleHook({ hookLogPath: log, env, fetchImpl } as never);
    expect(write).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(readFile(log, "utf8")).rejects.toThrow();
  });

  it("the child flag runs the questionnaire body, not an upload", async () => {
    const runQuestionnaire = vi.fn(async () => "ok");
    await sessionEndHook({
      questionnaireSession: SID,
      deferredPath: "/x.jsonl",
      cwd: "/home/dev/acme",
      hookLogPath: join(root, "hook.log"),
      runQuestionnaire,
      env: { MEMBRAL_QUESTIONNAIRE: "1" },
    });
    expect(runQuestionnaire).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: SID, transcriptPath: "/x.jsonl", cwd: "/home/dev/acme" }),
    );
  });
});

describe("digest agreement line", () => {
  it("renders per-question agreement and the session count", () => {
    const d = parseDogfood({
      days: 7,
      totals: {},
      quotes: [],
      agreement: { totals: { sessions: 3, q1: 0.5, q2: 1, q3: null, q4: 0.333 } },
    });
    expect(formatAgreementLine(d?.agreement)).toBe(
      "Self-report vs judge agreement: q1 50% · q2 100% · q3 n/a · q4 33% (3 sessions)",
    );
    expect(renderDigest(d as NonNullable<typeof d>, { appUrl: "https://x", week: "2026-W41" })).toContain(
      "Self-report vs judge agreement: q1 50%",
    );
    expect(formatAgreementLine(undefined)).toBe("Self-report vs judge agreement: n/a (0 sessions)");
  });
});
