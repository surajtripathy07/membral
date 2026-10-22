// Record/replay double for the OpenAI-shaped transport that
// apps/cloud/src/lib/kg/llm.ts `LlmClient` accepts as `opts.client`
// (its `OpenAILike` interface). The types below are structural copies, so
// this package never imports app code.
//
// - Chat completions are keyed by sha256 of the WHOLE request body as
//   canonical JSON (sorted keys): model, every message, response_format,
//   temperature, max_tokens, reasoning and any other option. A key seen more
//   than once (extract.ts's retry-on-empty) replays its recorded responses in
//   call order.
// - `replay` never touches the network. A missing key throws and is also
//   pushed onto `misses`, because callers such as extract.ts catch LLM errors
//   and degrade to zero records: a golden must assert `misses` is empty.
// - `record` forwards each chat call to `upstream` and keeps the response.
// - Embeddings are never recorded or sent anywhere, in either mode: each input
//   text gets a deterministic unit vector derived from sha256(text), so cosine
//   comparisons are stable and identical texts still match exactly.

import { createHash } from "node:crypto";

export interface ReplayChatBody {
  model: string;
  messages: Array<{ role: "system" | "user"; content: string }>;
  response_format?: { type: "json_object" };
  temperature?: number;
  max_tokens?: number;
  reasoning?: { effort: "low" | "medium" | "high" } | { enabled: boolean };
}

export interface ReplayUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  completion_tokens_details?: { reasoning_tokens?: number };
}

export interface ReplayChatCompletion {
  choices: Array<{ message: { content: string | null } }>;
  usage?: ReplayUsage | null;
}

export interface ReplayEmbeddingResponse {
  data: Array<{ embedding: number[] }>;
  usage?: { prompt_tokens?: number } | null;
}

/** Structurally the `OpenAILike` transport of apps/cloud/src/lib/kg/llm.ts. */
export interface ReplayTransport {
  chat: { completions: { create(body: ReplayChatBody): Promise<ReplayChatCompletion> } };
  embeddings: {
    create(body: { model: string; input: string | string[]; dimensions?: number }): Promise<ReplayEmbeddingResponse>;
  };
}

/** What `record` mode forwards chat calls to (a real client's chat surface). */
export interface ChatUpstream {
  chat: { completions: { create(body: ReplayChatBody): Promise<ReplayChatCompletion> } };
}

/** One recorded chat call: one line of `llm.jsonl`. */
export interface LlmRecording {
  key: string;
  /** 0 for the first call with this key, 1 for the second, ... */
  n: number;
  model: string;
  /** First 120 chars of each prompt, for humans reading a diff or a miss. */
  system_head: string;
  user_head: string;
  content: string | null;
  usage: ReplayUsage | null;
}

export type ReplayMode = "record" | "replay";

const HEAD = 120;

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x !== undefined) out[k] = canonical(x);
    }
    return out;
  }
  return v;
}

/** sha256 of the full request body as canonical JSON (keys sorted, undefined dropped). */
export function llmRequestKey(body: ReplayChatBody): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(body)))
    .digest("hex");
}

/** A unit vector of `dims` floats derived only from `text` (values rounded to 6 decimals). */
export function hashEmbedding(text: string, dims: number): number[] {
  const raw: number[] = [];
  for (let block = 0; raw.length < dims; block++) {
    const digest = createHash("sha256").update(`${block}\u0000${text}`).digest();
    for (let i = 0; i + 1 < digest.length && raw.length < dims; i += 2) {
      raw.push(digest.readUInt16BE(i) / 32767.5 - 1);
    }
  }
  const norm = Math.sqrt(raw.reduce((s, v) => s + v * v, 0)) || 1;
  return raw.map((v) => Math.round((v / norm) * 1e6) / 1e6);
}

export function parseLlmJsonl(text: string): LlmRecording[] {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as LlmRecording);
}

export function toLlmJsonl(recordings: readonly LlmRecording[]): string {
  return recordings.map((r) => JSON.stringify(r)).join("\n") + (recordings.length ? "\n" : "");
}

export interface LlmReplayOptions {
  mode: ReplayMode;
  /** Recordings to serve (replay mode). */
  recordings?: readonly LlmRecording[];
  /** Real chat client (record mode). */
  upstream?: ChatUpstream;
}

export class LlmReplay {
  readonly mode: ReplayMode;
  /** Every chat call made, in call order, as it was served or recorded. */
  readonly calls: LlmRecording[] = [];
  /** One message per replay cache miss. */
  readonly misses: string[] = [];
  private readonly byKey = new Map<string, LlmRecording[]>();
  private readonly seen = new Map<string, number>();
  private readonly upstream?: ChatUpstream;

  constructor(opts: LlmReplayOptions) {
    this.mode = opts.mode;
    this.upstream = opts.upstream;
    if (this.mode === "record" && !this.upstream) throw new Error("llm-replay: record mode needs an upstream client");
    for (const r of opts.recordings ?? []) {
      const list = this.byKey.get(r.key) ?? [];
      list[r.n] = r;
      this.byKey.set(r.key, list);
    }
  }

  /** Recordings that no call asked for (a stale recording set). */
  unused(): LlmRecording[] {
    const out: LlmRecording[] = [];
    for (const [key, list] of this.byKey) {
      const used = this.seen.get(key) ?? 0;
      for (const r of list.slice(used)) if (r) out.push(r);
    }
    return out;
  }

  readonly client: ReplayTransport = {
    chat: {
      completions: {
        create: (body) => this.chat(body),
      },
    },
    embeddings: {
      create: async (body) => {
        const inputs = Array.isArray(body.input) ? body.input : [body.input];
        const dims = body.dimensions ?? 1536;
        return {
          data: inputs.map((t) => ({ embedding: hashEmbedding(t, dims) })),
          usage: { prompt_tokens: inputs.reduce((s, t) => s + Math.ceil(t.length / 4), 0) },
        };
      },
    },
  };

  private async chat(body: ReplayChatBody): Promise<ReplayChatCompletion> {
    const system = body.messages.find((m) => m.role === "system")?.content ?? "";
    const user = body.messages.find((m) => m.role === "user")?.content ?? "";
    const key = llmRequestKey(body);
    const n = this.seen.get(key) ?? 0;
    this.seen.set(key, n + 1);

    if (this.mode === "replay") {
      const hit = this.byKey.get(key)?.[n];
      if (!hit) {
        const msg = `llm-replay: no recording for key ${key} (model ${body.model}, call #${n}); user prompt head: ${JSON.stringify(user.slice(0, HEAD))}`;
        this.misses.push(msg);
        throw new Error(msg);
      }
      this.calls.push(hit);
      return { choices: [{ message: { content: hit.content } }], usage: hit.usage };
    }

    const res = await (this.upstream as ChatUpstream).chat.completions.create(body);
    const u = res.usage ?? null;
    const usage: ReplayUsage | null = u
      ? {
          prompt_tokens: u.prompt_tokens,
          completion_tokens: u.completion_tokens,
          ...(u.completion_tokens_details?.reasoning_tokens !== undefined
            ? { completion_tokens_details: { reasoning_tokens: u.completion_tokens_details.reasoning_tokens } }
            : {}),
        }
      : null;
    const rec: LlmRecording = {
      key,
      n,
      model: body.model,
      system_head: system.slice(0, HEAD),
      user_head: user.slice(0, HEAD),
      content: res.choices[0]?.message.content ?? null,
      usage,
    };
    this.calls.push(rec);
    const list = this.byKey.get(key) ?? [];
    list[n] = rec;
    this.byKey.set(key, list);
    return { choices: [{ message: { content: rec.content } }], usage };
  }
}
