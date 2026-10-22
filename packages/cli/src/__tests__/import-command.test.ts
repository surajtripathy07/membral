// `membral import` — mocks global fetch (POST /api/import) and uses tiny
// real ChatGPT/Claude export fixtures on disk (temp dir) so detectExportProvider
// + parseChatGptExport/parseClaudeExport run for real.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { importCommand } from "../import-command.js";

function chatGptExportFixture() {
  return [
    {
      id: "conv-1",
      title: "Trip planning",
      create_time: 1700000000,
      update_time: 1700000100,
      current_node: "node-2",
      mapping: {
        "node-1": {
          id: "node-1",
          message: {
            id: "msg-1",
            author: { role: "user" },
            content: { content_type: "text", parts: ["Where should I go?"] },
            create_time: 1700000000,
          },
          parent: null,
          children: ["node-2"],
        },
        "node-2": {
          id: "node-2",
          message: {
            id: "msg-2",
            author: { role: "assistant" },
            content: { content_type: "text", parts: ["Try Japan."] },
            create_time: 1700000050,
          },
          parent: "node-1",
          children: [],
        },
      },
    },
  ];
}

describe("importCommand", () => {
  let dir: string;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "membral-import-"));
    // Keep the developer's real ~/.membral/credentials.json and env key out of these tests.
    vi.stubEnv("HOME", dir);
    vi.stubEnv("MEMBRAL_API_KEY", "");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    process.exitCode = 0;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    process.exitCode = 0;
  });

  it("prints usage and exits 1 when no file is given", async () => {
    await importCommand({});
    expect(process.exitCode).toBe(1);
  });

  it("prints unzip instructions and exits 1 for a .zip file (no zip dependency in this build)", async () => {
    const errorSpy = vi.spyOn(console, "error");
    await importCommand({ file: "export.zip" });
    expect(process.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("unzip"));
  });

  it("exits 1 for a missing file", async () => {
    await importCommand({ file: join(dir, "does-not-exist.json") });
    expect(process.exitCode).toBe(1);
  });

  it("exits 1 for invalid JSON", async () => {
    const file = join(dir, "conversations.json");
    writeFileSync(file, "not json");
    await importCommand({ file });
    expect(process.exitCode).toBe(1);
  });

  it("exits 1 when the export format can't be detected", async () => {
    const file = join(dir, "conversations.json");
    writeFileSync(file, JSON.stringify([{ foo: "bar" }]));
    await importCommand({ file, apiKey: "k" });
    expect(process.exitCode).toBe(1);
  });

  it("exits 1 with no API key even for a valid export", async () => {
    const file = join(dir, "conversations.json");
    writeFileSync(file, JSON.stringify(chatGptExportFixture()));
    await importCommand({ file, apiUrl: "http://localhost:3000", apiKey: "" });
    expect(process.exitCode).toBe(1);
  });

  it("detects, parses, and POSTs a ChatGPT export in one batch, printing imported/skipped counts", async () => {
    const file = join(dir, "conversations.json");
    writeFileSync(file, JSON.stringify(chatGptExportFixture()));

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ imported: 1, total: 1, errors: [] }),
      text: async () => JSON.stringify({ imported: 1, total: 1, errors: [] }),
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await importCommand({ file, apiUrl: "http://localhost:3000", apiKey: "lls_key" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost:3000/api/import");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.conversations).toHaveLength(1);
    expect(body.conversations[0].source).toBe("chatgpt");
    expect(process.exitCode).toBe(0);
  });

  it("splits into multiple batches of 100 conversations", async () => {
    const many = Array.from({ length: 150 }, (_, i) => ({
      ...chatGptExportFixture()[0],
      id: `conv-${i}`,
    }));
    const file = join(dir, "conversations.json");
    writeFileSync(file, JSON.stringify(many));

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ imported: 100, total: 150, errors: [] }),
      text: async () => JSON.stringify({ imported: 100, total: 150, errors: [] }),
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await importCommand({ file, apiUrl: "http://localhost:3000", apiKey: "lls_key" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("exits 1 and reports the error on a 401", async () => {
    const file = join(dir, "conversations.json");
    writeFileSync(file, JSON.stringify(chatGptExportFixture()));

    globalThis.fetch = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 401, text: async () => "unauthorized" }) as unknown as typeof fetch;

    await importCommand({ file, apiUrl: "http://localhost:3000", apiKey: "bad-key" });
    expect(process.exitCode).toBe(1);
  });

  it("403 (scoped key): no retry, exits 1 with the Settings hint", async () => {
    const file = join(dir, "conversations.json");
    writeFileSync(file, JSON.stringify(chatGptExportFixture()));
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => JSON.stringify({ error: "Scoped API keys cannot import conversations" }),
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await importCommand({ file, apiUrl: "http://localhost:3000", apiKey: "lls_scoped" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);
    const printed = JSON.stringify((console.error as ReturnType<typeof vi.fn>).mock.calls);
    expect(printed).toContain("Scoped API keys cannot import (403)");
    expect(printed).toContain("All of my memories");
  });

  it("402 (conversation limit): no retry, exits 1 with the limit from the server body", async () => {
    const file = join(dir, "conversations.json");
    writeFileSync(file, JSON.stringify(chatGptExportFixture()));
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 402,
      text: async () => JSON.stringify({ error: "conversation_limit", limit: 500, count: 500 }),
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await importCommand({ file, apiUrl: "http://localhost:3000", apiKey: "lls_key" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);
    expect(JSON.stringify((console.error as ReturnType<typeof vi.fn>).mock.calls)).toContain(
      "Conversation limit reached (402): 500 of 500 conversations stored",
    );
  });
});
