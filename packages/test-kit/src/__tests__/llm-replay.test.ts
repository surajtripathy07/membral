import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  type ChatUpstream,
  hashEmbedding,
  type LlmRecording,
  LlmReplay,
  llmRequestKey,
  parseLlmJsonl,
  type ReplayChatBody,
  toLlmJsonl,
} from "../index.js";

const BASE: ReplayChatBody = {
  model: "google/gemma-4-31b-it",
  messages: [
    { role: "system", content: "You extract records." },
    { role: "user", content: "Repo: dev/acme-webapp" },
  ],
};

describe("llmRequestKey", () => {
  it("is stable across property order", () => {
    const a: ReplayChatBody = { ...BASE, temperature: 0.2, max_tokens: 100 };
    const b: ReplayChatBody = { max_tokens: 100, temperature: 0.2, ...BASE };
    expect(llmRequestKey(a)).toBe(llmRequestKey(b));
  });

  it("is a 64-char hex sha256 digest", () => {
    expect(llmRequestKey(BASE)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when temperature changes", () => {
    const key1 = llmRequestKey({ ...BASE, temperature: 0.2 });
    const key2 = llmRequestKey({ ...BASE, temperature: 0.7 });
    expect(key1).not.toBe(key2);
  });

  it("changes when response_format changes", () => {
    const key1 = llmRequestKey(BASE);
    const key2 = llmRequestKey({ ...BASE, response_format: { type: "json_object" } });
    expect(key1).not.toBe(key2);
  });

  it("changes when max_tokens changes", () => {
    const key1 = llmRequestKey({ ...BASE, max_tokens: 100 });
    const key2 = llmRequestKey({ ...BASE, max_tokens: 200 });
    expect(key1).not.toBe(key2);
  });

  it("changes when reasoning changes", () => {
    const key1 = llmRequestKey({ ...BASE, reasoning: { effort: "low" } });
    const key2 = llmRequestKey({ ...BASE, reasoning: { effort: "high" } });
    expect(key1).not.toBe(key2);
  });

  it("changes when an extra message is added", () => {
    const key1 = llmRequestKey(BASE);
    const key2 = llmRequestKey({
      ...BASE,
      messages: [...BASE.messages, { role: "user", content: "one more thing" }],
    });
    expect(key1).not.toBe(key2);
  });

  it("ignores undefined optional properties (canonical drops them)", () => {
    const key1 = llmRequestKey(BASE);
    const key2 = llmRequestKey({ ...BASE, temperature: undefined, max_tokens: undefined });
    expect(key1).toBe(key2);
  });

  it("is stable for identical bodies", () => {
    expect(llmRequestKey(BASE)).toBe(llmRequestKey({ ...BASE }));
  });
});

describe("hashEmbedding", () => {
  it("is deterministic for the same text and dims", () => {
    expect(hashEmbedding("hello world", 8)).toEqual(hashEmbedding("hello world", 8));
  });

  it("differs for different texts", () => {
    expect(hashEmbedding("hello", 8)).not.toEqual(hashEmbedding("goodbye", 8));
  });

  it("returns a unit vector of the requested length", () => {
    const v = hashEmbedding("some text", 16);
    expect(v).toHaveLength(16);
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 3);
  });
});

describe("parseLlmJsonl / toLlmJsonl", () => {
  const recordings: LlmRecording[] = [
    {
      key: "k1",
      n: 0,
      model: "m",
      system_head: "sys",
      user_head: "usr",
      content: "hello",
      usage: { prompt_tokens: 1, completion_tokens: 2 },
    },
    { key: "k2", n: 0, model: "m", system_head: "sys2", user_head: "usr2", content: null, usage: null },
  ];

  it("round-trips through toLlmJsonl/parseLlmJsonl", () => {
    const text = toLlmJsonl(recordings);
    expect(parseLlmJsonl(text)).toEqual(recordings);
  });

  it("produces one trailing newline, empty string for an empty list", () => {
    expect(toLlmJsonl(recordings).endsWith("\n")).toBe(true);
    expect(toLlmJsonl([])).toBe("");
    expect(parseLlmJsonl("")).toEqual([]);
  });

  it("skips blank lines when parsing", () => {
    expect(parseLlmJsonl(`${JSON.stringify(recordings[0])}\n\n`)).toEqual([recordings[0]]);
  });

  it("matches the shape of a committed pipeline fixture line", async () => {
    const goldenPath = fileURLToPath(
      new URL("../../../../apps/cloud/src/__golden__/pipeline/claude-code-small/llm.jsonl", import.meta.url),
    );
    const text = await readFile(goldenPath, "utf8");
    const firstLine = text.split("\n").find((l) => l.trim() !== "");
    expect(firstLine).toBeDefined();
    const [parsed] = parseLlmJsonl(firstLine as string);
    expect(Object.keys(parsed).sort()).toEqual(
      ["content", "key", "model", "n", "system_head", "usage", "user_head"].sort(),
    );
    expect(typeof parsed.key).toBe("string");
    expect(typeof parsed.n).toBe("number");
  });

  it("round-trips a store file through a temp directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "llm-replay-test-"));
    const file = join(dir, "llm.jsonl");
    try {
      await writeFile(file, toLlmJsonl(recordings), "utf8");
      const loaded = parseLlmJsonl(await readFile(file, "utf8"));
      expect(loaded).toEqual(recordings);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("LlmReplay replay mode", () => {
  it("returns the recorded response for a known key", async () => {
    const key = llmRequestKey(BASE);
    const rec: LlmRecording = {
      key,
      n: 0,
      model: BASE.model,
      system_head: "sys",
      user_head: "usr",
      content: "recorded answer",
      usage: { prompt_tokens: 5, completion_tokens: 6 },
    };
    const replay = new LlmReplay({ mode: "replay", recordings: [rec] });
    const res = await replay.client.chat.completions.create(BASE);
    expect(res.choices[0].message.content).toBe("recorded answer");
    expect(res.usage).toEqual(rec.usage);
    expect(replay.misses).toEqual([]);
  });

  it("throws on a cache miss with the prompt head in the message, and records the miss", async () => {
    const replay = new LlmReplay({ mode: "replay", recordings: [] });
    await expect(replay.client.chat.completions.create(BASE)).rejects.toThrow(/no recording for key/);
    expect(replay.misses).toHaveLength(1);
    expect(replay.misses[0]).toContain("Repo: dev/acme-webapp");
  });

  it("serves two recordings for the same key in call order, then throws on exhaustion", async () => {
    const key = llmRequestKey(BASE);
    const rec0: LlmRecording = {
      key,
      n: 0,
      model: BASE.model,
      system_head: "s",
      user_head: "u",
      content: "first",
      usage: null,
    };
    const rec1: LlmRecording = {
      key,
      n: 1,
      model: BASE.model,
      system_head: "s",
      user_head: "u",
      content: "second",
      usage: null,
    };
    const replay = new LlmReplay({ mode: "replay", recordings: [rec0, rec1] });
    const first = await replay.client.chat.completions.create(BASE);
    const second = await replay.client.chat.completions.create(BASE);
    expect(first.choices[0].message.content).toBe("first");
    expect(second.choices[0].message.content).toBe("second");
    await expect(replay.client.chat.completions.create(BASE)).rejects.toThrow(/call #2/);
    expect(replay.misses).toHaveLength(1);
    expect(replay.calls.map((c) => c.content)).toEqual(["first", "second"]);
  });

  it("unused() reports recordings no call consumed", async () => {
    const key = llmRequestKey(BASE);
    const rec0: LlmRecording = {
      key,
      n: 0,
      model: BASE.model,
      system_head: "s",
      user_head: "u",
      content: "first",
      usage: null,
    };
    const rec1: LlmRecording = {
      key,
      n: 1,
      model: BASE.model,
      system_head: "s",
      user_head: "u",
      content: "second",
      usage: null,
    };
    const replay = new LlmReplay({ mode: "replay", recordings: [rec0, rec1] });
    expect(replay.unused()).toEqual([rec0, rec1]);
    await replay.client.chat.completions.create(BASE);
    expect(replay.unused()).toEqual([rec1]);
  });

  it("serves deterministic hash embeddings and never records or forwards them", async () => {
    const replay = new LlmReplay({ mode: "replay", recordings: [] });
    const res = await replay.client.embeddings.create({ model: "m", input: ["a", "b"], dimensions: 4 });
    expect(res.data).toHaveLength(2);
    expect(res.data[0].embedding).toHaveLength(4);
    expect(res.data[0].embedding).toEqual(hashEmbedding("a", 4));
    expect(replay.calls).toEqual([]);
  });
});

describe("LlmReplay record mode", () => {
  it("throws when constructed without an upstream", () => {
    expect(() => new LlmReplay({ mode: "record" })).toThrow(/needs an upstream client/);
  });

  it("forwards chat calls to the injected upstream and records the response", async () => {
    const upstream: ChatUpstream = {
      chat: {
        completions: {
          create: async () => ({
            choices: [{ message: { content: "from upstream" } }],
            usage: { prompt_tokens: 10, completion_tokens: 3, completion_tokens_details: { reasoning_tokens: 1 } },
          }),
        },
      },
    };
    const replay = new LlmReplay({ mode: "record", upstream });
    const res = await replay.client.chat.completions.create(BASE);
    expect(res.choices[0].message.content).toBe("from upstream");
    expect(replay.calls).toHaveLength(1);
    const rec = replay.calls[0];
    expect(rec.key).toBe(llmRequestKey(BASE));
    expect(rec.n).toBe(0);
    expect(rec.model).toBe(BASE.model);
    expect(rec.system_head).toBe("You extract records.");
    expect(rec.user_head).toBe("Repo: dev/acme-webapp");
    expect(rec.usage).toEqual({
      prompt_tokens: 10,
      completion_tokens: 3,
      completion_tokens_details: { reasoning_tokens: 1 },
    });
    expect(Object.keys(rec).sort()).toEqual(
      ["content", "key", "model", "n", "system_head", "usage", "user_head"].sort(),
    );
  });

  it("omits completion_tokens_details when the upstream doesn't provide reasoning_tokens", async () => {
    const upstream: ChatUpstream = {
      chat: {
        completions: {
          create: async () => ({
            choices: [{ message: { content: "x" } }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          }),
        },
      },
    };
    const replay = new LlmReplay({ mode: "record", upstream });
    await replay.client.chat.completions.create(BASE);
    expect(replay.calls[0].usage).toEqual({ prompt_tokens: 1, completion_tokens: 1 });
  });

  it("handles a null usage and null content from the upstream", async () => {
    const upstream: ChatUpstream = {
      chat: { completions: { create: async () => ({ choices: [{ message: { content: null } }], usage: null }) } },
    };
    const replay = new LlmReplay({ mode: "record", upstream });
    const res = await replay.client.chat.completions.create(BASE);
    expect(res.choices[0].message.content).toBeNull();
    expect(replay.calls[0].usage).toBeNull();
  });

  it("increments n for a second call with the same key", async () => {
    let calls = 0;
    const upstream: ChatUpstream = {
      chat: {
        completions: {
          create: async () => {
            calls += 1;
            return { choices: [{ message: { content: `reply-${calls}` } }], usage: null };
          },
        },
      },
    };
    const replay = new LlmReplay({ mode: "record", upstream });
    await replay.client.chat.completions.create(BASE);
    await replay.client.chat.completions.create(BASE);
    expect(replay.calls.map((c) => c.n)).toEqual([0, 1]);
    expect(replay.calls.map((c) => c.content)).toEqual(["reply-1", "reply-2"]);
  });

  it("writes recordings that a fresh replay LlmReplay can serve back exactly (record -> jsonl -> replay round trip)", async () => {
    const upstream: ChatUpstream = {
      chat: {
        completions: {
          create: async () => ({
            choices: [{ message: { content: "roundtrip" } }],
            usage: { prompt_tokens: 2, completion_tokens: 2 },
          }),
        },
      },
    };
    const recorder = new LlmReplay({ mode: "record", upstream });
    await recorder.client.chat.completions.create(BASE);
    const text = toLlmJsonl(recorder.calls);
    const loaded = parseLlmJsonl(text);
    const player = new LlmReplay({ mode: "replay", recordings: loaded });
    const res = await player.client.chat.completions.create(BASE);
    expect(res.choices[0].message.content).toBe("roundtrip");
    expect(player.misses).toEqual([]);
  });
});
