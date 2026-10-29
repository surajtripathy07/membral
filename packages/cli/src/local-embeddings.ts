// `membral local up --embeddings ollama|none`: local embeddings through the
// host's Ollama. The app reads MEMBRAL_EMBEDDINGS_BASE_URL and
// MEMBRAL_EMBEDDING_MODEL from ~/.membral/local/.env (the compose file passes
// both through), so enabling embeddings is two .env lines plus a reachability
// check that fails fast with the exact command to run.
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { EnvMap, LocalPaths } from "./local-stack.js";

export const DEFAULT_EMBEDDING_MODEL = "nomic-embed-text";
export const EMBEDDINGS_BASE_KEY = "MEMBRAL_EMBEDDINGS_BASE_URL";
export const EMBEDDINGS_MODEL_KEY = "MEMBRAL_EMBEDDING_MODEL";
/** Nothing configured: the app's bundled ONNX model (local mode default; downloads on first use, ~137 MB). */
export const EMBEDDINGS_BUNDLED_LINE =
  "Embeddings: nomic-embed-text-v1.5-onnx-q8 (bundled; downloads on first use, ~137 MB). Ollama instead: membral local up --embeddings ollama";
const OLLAMA_TIMEOUT_MS = 3000;
const DEFAULT_OLLAMA_PORT = 11434;

export type EmbeddingsMode = "ollama" | "none";

export function parseEmbeddingsMode(value: string | undefined): EmbeddingsMode | undefined | string {
  if (value === undefined) return undefined;
  if (value === "ollama" || value === "none") return value;
  return `Invalid --embeddings "${value}" — use "ollama" or "none".`;
}

interface OllamaEndpoint {
  /** Where this CLI (on the host) reaches Ollama. */
  hostUrl: string;
  /** Where the app container reaches it. */
  containerUrl: string;
}

/**
 * OLLAMA_HOST is "host", "host:port", ":port" or a full URL; a wildcard bind
 * address (0.0.0.0, ::) is how a server listens, not where a client connects.
 */
export function ollamaEndpoint(ollamaHost: string | undefined): OllamaEndpoint {
  let raw = (ollamaHost ?? "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "");
  let port = DEFAULT_OLLAMA_PORT;
  let host = "127.0.0.1";
  if (raw) {
    const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(raw);
    if (v6) {
      host = `[${v6[1]}]`;
      if (v6[2]) port = Number(v6[2]);
    } else {
      const idx = raw.lastIndexOf(":");
      if (idx !== -1 && /^\d+$/.test(raw.slice(idx + 1))) {
        port = Number(raw.slice(idx + 1));
        raw = raw.slice(0, idx);
      }
      if (raw) host = raw;
    }
  }
  const wildcard = host === "0.0.0.0" || host === "[::]" || host === "::";
  const loopback = wildcard || host === "127.0.0.1" || host === "localhost" || host === "[::1]";
  const clientHost = wildcard ? "127.0.0.1" : host;
  return {
    hostUrl: `http://${clientHost}:${port}`,
    containerUrl: `http://${loopback ? "host.docker.internal" : host}:${port}/v1`,
  };
}

export type OllamaCheck = { ok: true; baseUrl: string } | { ok: false; message: string };

/** Is Ollama answering on the host, and has it pulled `model`? On failure, `message` says what to run. */
export async function checkOllama(
  model: string,
  fetchImpl: typeof fetch,
  ollamaHost: string | undefined,
): Promise<OllamaCheck> {
  const ep = ollamaEndpoint(ollamaHost);
  let names: string[];
  try {
    const res = await fetchImpl(`${ep.hostUrl}/api/tags`, { signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { models?: Array<{ name?: string; model?: string }> };
    names = (body.models ?? []).map((m) => m.name ?? m.model ?? "").filter(Boolean);
  } catch {
    return {
      ok: false,
      message:
        `Ollama is not answering at ${ep.hostUrl}. Install it (\`brew install ollama\` or https://ollama.com/download), ` +
        `start it (\`ollama serve\`), then run this again. (OLLAMA_HOST overrides the address.)`,
    };
  }
  if (!names.some((n) => n === model || n === `${model}:latest`)) {
    return { ok: false, message: `Ollama has no model "${model}". Run: ollama pull ${model}` };
  }
  return { ok: true, baseUrl: ep.containerUrl };
}

/** Remove `keys` from .env, keeping every other line. Atomic, mode 600; no write when nothing matches. */
export function removeEnvKeys(paths: LocalPaths, keys: readonly string[]): boolean {
  if (!existsSync(paths.env)) return false;
  const text = readFileSync(paths.env, "utf8");
  const drop = new RegExp(`^(?:export\\s+)?(?:${keys.join("|")})\\s*=`);
  const kept = text.split("\n").filter((line) => !drop.test(line.trim()));
  const next = kept.join("\n");
  if (next === text) return false;
  const tmp = `${paths.env}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, next, { encoding: "utf8", mode: 0o600, flag: "wx" });
  renameSync(tmp, paths.env);
  chmodSync(paths.env, 0o600);
  return true;
}

/** The one-line embedding state for `local up` and `local status`, from the stored .env. */
export function embeddingsLine(env: EnvMap): string {
  const base = env[EMBEDDINGS_BASE_KEY]?.trim();
  const model = env[EMBEDDINGS_MODEL_KEY]?.trim();
  if (base) {
    const name = model || "text-embedding-3-small";
    return /^https?:\/\/host\.docker\.internal:\d+\/v1\/?$/i.test(base)
      ? `Embeddings: ${name} (Ollama)`
      : `Embeddings: ${name} via ${base}`;
  }
  if (env.MEMBRAL_MODEL_BASE_URL?.trim()) {
    return `Embeddings: ${model || "text-embedding-3-small"} via ${env.MEMBRAL_MODEL_BASE_URL.trim()}`;
  }
  if (env.OPENAI_API_KEY?.trim()) return `Embeddings: ${model || "text-embedding-3-small"} via OpenAI`;
  if (env.OPENROUTER_API_KEY?.trim()) return `Embeddings: ${model || "openai/text-embedding-3-small"} via OpenRouter`;
  return EMBEDDINGS_BUNDLED_LINE;
}
