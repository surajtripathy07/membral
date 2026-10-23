// `membral local up --embeddings ollama|none`: the Ollama reachability check,
// the .env edits, and the one-line embedding state.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkOllama,
  EMBEDDINGS_NONE_LINE,
  embeddingsLine,
  ollamaEndpoint,
  parseEmbeddingsMode,
  removeEnvKeys,
} from "../local-embeddings.js";
import { localPaths, parseEnv } from "../local-stack.js";

const tags = (...names: string[]) =>
  vi.fn(async () => new Response(JSON.stringify({ models: names.map((name) => ({ name })) }), { status: 200 }));

describe("ollamaEndpoint", () => {
  it("defaults to 127.0.0.1:11434 on the host and host.docker.internal in the container", () => {
    expect(ollamaEndpoint(undefined)).toEqual({
      hostUrl: "http://127.0.0.1:11434",
      containerUrl: "http://host.docker.internal:11434/v1",
    });
  });

  it("honours OLLAMA_HOST forms: port only, wildcard bind, full URL, remote host", () => {
    expect(ollamaEndpoint(":11500").hostUrl).toBe("http://127.0.0.1:11500");
    expect(ollamaEndpoint("0.0.0.0:11434").hostUrl).toBe("http://127.0.0.1:11434");
    expect(ollamaEndpoint("http://localhost:9/").containerUrl).toBe("http://host.docker.internal:9/v1");
    expect(ollamaEndpoint("gpu-box")).toEqual({
      hostUrl: "http://gpu-box:11434",
      containerUrl: "http://gpu-box:11434/v1",
    });
  });
});

describe("checkOllama", () => {
  it("is ok when /api/tags lists the model (with or without :latest), and returns the container URL", async () => {
    const f = tags("nomic-embed-text:latest", "llama3:8b");
    const r = await checkOllama("nomic-embed-text", f as unknown as typeof fetch, undefined);
    expect(r).toEqual({ ok: true, baseUrl: "http://host.docker.internal:11434/v1" });
    expect(f.mock.calls[0][0]).toBe("http://127.0.0.1:11434/api/tags");
    expect((await checkOllama("llama3:8b", f as unknown as typeof fetch, undefined)).ok).toBe(true);
  });

  it("asks the host's OLLAMA_HOST", async () => {
    const f = tags("nomic-embed-text");
    await checkOllama("nomic-embed-text", f as unknown as typeof fetch, "127.0.0.1:11500");
    expect(f.mock.calls[0][0]).toBe("http://127.0.0.1:11500/api/tags");
  });

  it("explains how to install and start Ollama when it does not answer", async () => {
    const f = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const r = await checkOllama("nomic-embed-text", f as unknown as typeof fetch, undefined);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.message).toContain("brew install ollama");
    expect(r.ok === false && r.message).toContain("https://ollama.com/download");
    expect(r.ok === false && r.message).toContain("ollama serve");
  });

  it("treats a non-200 as unreachable", async () => {
    const f = vi.fn(async () => new Response("no", { status: 500 }));
    expect((await checkOllama("m", f as unknown as typeof fetch, undefined)).ok).toBe(false);
  });

  it("says to pull the model when it is missing", async () => {
    const r = await checkOllama("nomic-embed-text", tags("llama3:8b") as unknown as typeof fetch, undefined);
    expect(r).toEqual({
      ok: false,
      message: 'Ollama has no model "nomic-embed-text". Run: ollama pull nomic-embed-text',
    });
  });

  it("gives up after 3 s (the fetch is handed an abort signal)", async () => {
    const f = tags("nomic-embed-text");
    await checkOllama("nomic-embed-text", f as unknown as typeof fetch, undefined);
    const init = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(init[1].signal).toBeInstanceOf(AbortSignal);
  });
});

describe("parseEmbeddingsMode", () => {
  it("accepts ollama and none, passes undefined through, rejects the rest with a message", () => {
    expect(parseEmbeddingsMode(undefined)).toBeUndefined();
    expect(parseEmbeddingsMode("ollama")).toBe("ollama");
    expect(parseEmbeddingsMode("none")).toBe("none");
    expect(parseEmbeddingsMode("")).toContain('Invalid --embeddings ""');
    expect(parseEmbeddingsMode("openai")).toContain("use");
  });
});

describe("removeEnvKeys", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "membral-emb-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("drops only the named keys, keeps comments and other lines, stays mode 600", () => {
    const paths = localPaths(join(dir, "local"));
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(
      paths.env,
      "# header\n# MEMBRAL_EMBEDDINGS_BASE_URL=commented stays\nJWT_SECRET=abc\nMEMBRAL_EMBEDDINGS_BASE_URL=http://x/v1\nMEMBRAL_EMBEDDING_MODEL=m\nOPENAI_API_KEY=k\n",
    );
    expect(removeEnvKeys(paths, ["MEMBRAL_EMBEDDINGS_BASE_URL", "MEMBRAL_EMBEDDING_MODEL"])).toBe(true);
    const text = readFileSync(paths.env, "utf8");
    expect(text).toBe("# header\n# MEMBRAL_EMBEDDINGS_BASE_URL=commented stays\nJWT_SECRET=abc\nOPENAI_API_KEY=k\n");
    expect(statSync(paths.env).mode & 0o777).toBe(0o600);
    expect(removeEnvKeys(paths, ["MEMBRAL_EMBEDDINGS_BASE_URL"])).toBe(false);
  });

  it("does nothing when there is no .env", () => {
    expect(removeEnvKeys(localPaths(join(dir, "none")), ["X"])).toBe(false);
  });
});

describe("embeddingsLine", () => {
  it("names Ollama when the base URL is the host Ollama", () => {
    expect(
      embeddingsLine(
        parseEnv(
          "MEMBRAL_EMBEDDINGS_BASE_URL=http://host.docker.internal:11434/v1\nMEMBRAL_EMBEDDING_MODEL=nomic-embed-text",
        ),
      ),
    ).toBe("Embeddings: nomic-embed-text (Ollama)");
  });

  it("shows model and base URL for any other endpoint", () => {
    expect(
      embeddingsLine({ MEMBRAL_EMBEDDINGS_BASE_URL: "https://api.example/v1", MEMBRAL_EMBEDDING_MODEL: "emb-1" }),
    ).toBe("Embeddings: emb-1 via https://api.example/v1");
  });

  it("says embeddings come from a hosted key when only a key is set", () => {
    expect(embeddingsLine({ OPENAI_API_KEY: "k" })).toBe("Embeddings: text-embedding-3-small via OpenAI");
  });

  it("says none, with the command to fix it, when nothing is configured", () => {
    expect(embeddingsLine({})).toBe(EMBEDDINGS_NONE_LINE);
    expect(EMBEDDINGS_NONE_LINE).toBe(
      "Embeddings: none — search is keyword only. Run: membral local up --embeddings ollama",
    );
  });
});
