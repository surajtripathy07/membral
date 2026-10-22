// Persona corpus generator (bead membral-fwz).
//
// Reads seed-plan.json and synthesizes one full multi-turn conversation per entry
// via the OpenAI API, in Membral common-format JSON (packages/core Conversation).
//
// - Crash-safe + resumable: one file per conversation in corpus/, existing ids skipped.
// - Cost-tracked with a hard cap (aborts cleanly if spent or projected > cap).
// - Rate limiting per CLAUDE.md: no immediate 429 retry, low retry counts,
//   proportional backoff multipliers, 0.9x decay on success, transitions logged.
// - Every output is validated against apps/cloud sync-validator before writing.
//
// Run from the repo root:
//   npx tsx fixtures/persona/generate.ts
// Model override (repo convention): MEMBRAL_MODEL=gpt-4o-mini npx tsx fixtures/persona/generate.ts
// Reads OPENAI_API_KEY from apps/cloud/.env.local (like the kg scripts).

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import OpenAI from "openai";
import type { Conversation, Message } from "@membral/core";
import { validateConversations } from "../../apps/cloud/src/lib/sync-validator";

const HERE = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(HERE, "../../apps/cloud/.env.local") });

// ------------------------------------------------------------------
// Config
// ------------------------------------------------------------------

const MODEL = process.env.MEMBRAL_MODEL ?? "gpt-4o";
const COST_CAP_USD = 15;
const CONCURRENCY = 5;
const CORPUS_DIR = resolve(HERE, "corpus");
const SEED_PLAN = resolve(HERE, "seed-plan.json");
const FAILURES_FILE = resolve(HERE, "failures.json");
// Fixed synced_at so re-runs of unchanged entries stay byte-comparable.
const SYNCED_AT = "2026-07-01T00:00:00.000Z";

// Pricing per 1M tokens (USD) — same convention as apps/cloud/src/lib/kg/llm.ts.
// Unknown models fall back to gpt-4o rates so the cost cap stays meaningful.
const PRICING: Record<string, { in: number; out: number }> = {
  "gpt-4o": { in: 2.5, out: 10.0 },
  "gpt-4o-mini": { in: 0.15, out: 0.6 },
  "gpt-4.1": { in: 2.0, out: 8.0 },
  "gpt-4.1-mini": { in: 0.4, out: 1.6 },
};

function costUsd(model: string, tokensIn: number, tokensOut: number): number {
  const p = PRICING[model] ?? PRICING["gpt-4o"];
  return (tokensIn * p.in + tokensOut * p.out) / 1_000_000;
}

// ------------------------------------------------------------------
// Seed plan
// ------------------------------------------------------------------

interface SeedEntry {
  id: string;
  provider: "chatgpt" | "claude";
  date: string;
  title: string;
  life_areas: string[];
  purpose: string;
  depth: "quick" | "medium" | "deep";
  brief: string;
  arc_refs: string[];
}

const TURN_BANDS: Record<SeedEntry["depth"], { min: number; max: number; hardMin: number; hardMax: number }> = {
  quick: { min: 2, max: 6, hardMin: 2, hardMax: 8 },
  medium: { min: 6, max: 16, hardMin: 5, hardMax: 18 },
  deep: { min: 16, max: 40, hardMin: 12, hardMax: 42 },
};

const MAX_TOKENS: Record<SeedEntry["depth"], number> = { quick: 3000, medium: 9000, deep: 16000 };

// ------------------------------------------------------------------
// Deterministic per-id randomness (stable across resumed runs)
// ------------------------------------------------------------------

function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Even message count in the depth band (starts user, ends assistant). */
function targetTurns(entry: SeedEntry, rnd: () => number): number {
  const band = TURN_BANDS[entry.depth];
  const n = band.min + Math.floor(rnd() * (band.max - band.min + 1));
  return n % 2 === 0 ? n : n < band.max ? n + 1 : n - 1;
}

/** Time of day skewed to Tusk's hours: ~45% 00:00-04:59, ~20% 21:00-23:59, rest daytime. */
function startTime(entry: SeedEntry, rnd: () => number): Date {
  const r = rnd();
  let hour: number;
  if (r < 0.45) hour = Math.floor(rnd() * 5);
  else if (r < 0.65) hour = 21 + Math.floor(rnd() * 3);
  else hour = 8 + Math.floor(rnd() * 13);
  const minute = Math.floor(rnd() * 60);
  const second = Math.floor(rnd() * 60);
  return new Date(`${entry.date}T${pad(hour)}:${pad(minute)}:${pad(second)}.000Z`);
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

// ------------------------------------------------------------------
// Prompts
// ------------------------------------------------------------------

const ENTITY_SHEET = `Companies (exact spellings, all fictional parody):
- SpaceY (rockets; the "Leviathan" Mars ship; booster catch with "the Claw")
- Tusla (EVs; the "Cyberwedge" truck; the "Optimist" humanoid robot; production hell)
- The Dull Company (tunnel boring; novelty flamethrowers)
- Zapp (the social platform he impulse-bought; renamed to the glyph "Ƶ")
- MechaMind (AI lab; its chatbot is "Groak")
- NogginLink (brain-implant side venture)
- Vanguard Dynamics (the RIVAL company, run by Chad Vanguard)

People (exact spellings):
- Priya Chen — long-suffering Chief of Staff; sends "gentle reminders"; runs his life and his kids' calendar
- Gary Puddle — terrified CFO; the spreadsheet of doom; "we are burning cash"
- Dr. Renata Voss — SpaceY chief engineer; the competent one; his first-principles sparring partner
- Chip Halberd — VP of Engineering; yes-man; fired and rehired constantly
- Björn Kessler — Tusla factory production lead ("we are in production hell, Björn")
- Marisol Vega — Zapp head of Trust & Safety; quits repeatedly
- Dahlia Frost — Head of Comms; begs him to stop posting; author of the "HR-safe rewrite" requests
- Rex Mountain — personal trainer / biohacking guru
- Mimi Tusk — his mother; worried texts, quiet pride
- Chad Vanguard — rival CEO of Vanguard Dynamics; public-feud antagonist
- His kids have absurd symbol names like "Δ-9" and "‽" (fictional, non-graphic, kept absurd on purpose)`;

const SYSTEM_PROMPT = `You are a comedy writer generating FICTIONAL AI-chat transcripts for "Elon Tusk", a fully fictional, affectionate parody of a chaotic multi-company tech founder (age 53, lives between a Texas rocket facility and a car factory floor, wants to move to Mars). Not a depiction of any real person or company. The transcripts seed a demo knowledge graph, so recurring entity names must be spelled EXACTLY as given.

${ENTITY_SHEET}

TUSK'S VOICE (the "user" messages) — three registers:
- MANIC (default): types fast, lowercase, drops units and vowels, no greeting, no thanks. e.g. "gimme the delta-v for a fridge sized engine dont overthink it". Escalating exclamation marks as excitement rises. Peaks at 2-4am.
- ENGINEERING-EARNEST: when a real technical problem grips him he becomes detailed, precise, asks genuinely sharp follow-ups. Signature: "explain X from first principles, assume I'm smarter than the textbook author." Argues with the answer, then concedes the physics.
- MEME-DEFLECTION: when cornered or embarrassed he retreats into meme-speak, emoji rationing ("one rocket emoji, no more"), and "add flamethrowers" as the punchline to any decision analysis.
Recurring tells: calls textbooks/regulators/CFOs "cowards"; ends serious plans with an unserious flourish; asks for "HR-safe" or "legally-safe" rewrites of unhinged posts he already sent. When stressed or sleep-deprived the mask drops and he is briefly, genuinely vulnerable — play those moments straight and human.

THE ASSISTANT (the "assistant" messages) plays the straight man: competent, factually accurate, gently deadpan about the chaos. It pushes back on bad physics and bad ideas with real reasoning. The comedy comes from Tusk and the situations, never from the assistant being silly or broken.
- ChatGPT style: snappy, well-structured, occasional bullet lists and numbered steps, pragmatic, minimal hedging.
- Claude style: warm, thoughtful prose, reflective, asks one good question at a time, careful nuance; especially good in the emotional threads.

RULES:
1. Output STRICT JSON: {"messages":[{"role":"user","content":"..."},{"role":"assistant","content":"..."}, ...]}
2. Roles strictly alternate, starting with "user", ending with "assistant". Hit the requested message count exactly.
3. Honor the brief — it is the plot of this conversation. Realize its humor; make it genuinely funny.
4. Use ONLY fictional entities from the sheet (plus generic unnamed staff). Keep spellings exact, including "Björn Kessler". When a recurring person appears in a conversation, use their exact full name (e.g. "Renata Voss", "Gary Puddle") at least once — consistent full names across conversations are load-bearing. Never invent new named characters or real company/person names.
5. Never reference events after the conversation's date.
6. User turns are usually short (1-3 sentences, longer in earnest/deep threads). Assistant turns 60-220 words, shorter for quick lookups.
7. Technical content should be real (correct physics/engineering/chemistry), even when the question is absurd.
8. No meta-commentary, no stage directions, no markdown code fences around the JSON.`;

const REGISTER_HINTS: Record<string, string> = {
  "emotional-processing": "vulnerable/earnest — the mask is off; keep it human, humor only at the edges",
  "decision-support": "engineering-earnest, drifting to meme-deflection if the answer is uncomfortable",
  "writing-help": "manic; often the 'Dahlia Frost wants an HR-safe rewrite' energy",
  "quick-lookup": "manic, impatient, no greeting",
  brainstorm: "manic escalating to grandiose",
  learning: "engineering-earnest ('from first principles')",
  "problem-solving": "engineering-earnest with manic flashes",
  planning: "manic-organized: bullet-point ambition, absurd deadlines",
};

function timeLabel(d: Date): string {
  const h = d.getUTCHours();
  const ampm = h < 12 ? "am" : "pm";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${pad(d.getUTCMinutes())}${ampm}`;
}

function userPrompt(entry: SeedEntry, turns: number, start: Date): string {
  const register = REGISTER_HINTS[entry.purpose] ?? "manic";
  return `Write conversation "${entry.id}".

Provider: ${entry.provider} (write the assistant in ${entry.provider === "claude" ? "Claude" : "ChatGPT"} style)
Date: ${entry.date}, around ${timeLabel(start)} (Tusk's local time — let it color the mood if late)
Title: ${entry.title}
Purpose: ${entry.purpose}
Life areas: ${entry.life_areas.length ? entry.life_areas.join(", ") : "none — intentional off-topic noise, no arc or company references"}
Suggested register: ${register} (the brief overrides if it implies otherwise)
Message count: exactly ${turns} messages (${turns / 2} user + ${turns / 2} assistant, alternating, user first)

Brief (the plot): ${entry.brief}

Return the JSON object now.`;
}

// ------------------------------------------------------------------
// Rate limiting (CLAUDE.md conventions)
// ------------------------------------------------------------------

const rate = { delayMs: 0, count429: 0 };

function bumpDelay(): void {
  const prev = rate.delayMs;
  const base = Math.max(prev, 500);
  let mult: number;
  if (base < 1000) mult = 5;
  else if (base < 15_000) mult = 3;
  else if (base < 40_000) mult = 2;
  else mult = 1.3;
  rate.delayMs = Math.min(Math.round(base * mult), 120_000);
  rate.count429++;
  console.log(`[rate] 429 #${rate.count429}: delay ${prev}ms -> ${rate.delayMs}ms`);
}

function decayDelay(): void {
  if (rate.delayMs === 0) return;
  const prev = rate.delayMs;
  rate.delayMs = rate.delayMs < 100 ? 0 : Math.round(rate.delayMs * 0.9);
  if (prev >= 1000) console.log(`[rate] success decay: delay ${prev}ms -> ${rate.delayMs}ms`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ------------------------------------------------------------------
// Generation
// ------------------------------------------------------------------

const totals = { costUsd: 0, calls: 0, tokensIn: 0, tokensOut: 0 };

interface Failure {
  id: string;
  error: string;
}

class CostCapError extends Error {}

async function callModel(
  client: OpenAI,
  entry: SeedEntry,
  turns: number,
  start: Date,
): Promise<{ role: string; content: string }[]> {
  const MAX_ATTEMPTS = 4; // rate/transient attempts (CLAUDE.md: 3-4 max)
  let jsonRetried = false;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (totals.costUsd >= COST_CAP_USD) throw new CostCapError(`cost cap $${COST_CAP_USD} reached`);
    if (rate.delayMs > 0) await sleep(rate.delayMs); // never retry a 429 immediately

    let response: OpenAI.Chat.Completions.ChatCompletion;
    try {
      response = await client.chat.completions.create({
        model: MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt(entry, turns, start) },
        ],
        response_format: { type: "json_object" },
        temperature: 0.9,
        max_tokens: MAX_TOKENS[entry.depth],
      });
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 429 || (status !== undefined && status >= 500)) {
        if (status === 429) bumpDelay();
        else console.log(`[rate] ${status} on ${entry.id}, attempt ${attempt}/${MAX_ATTEMPTS}`);
        if (attempt === MAX_ATTEMPTS) throw e; // fail fast, move to next item
        continue;
      }
      throw e;
    }

    const tokensIn = response.usage?.prompt_tokens ?? 0;
    const tokensOut = response.usage?.completion_tokens ?? 0;
    totals.costUsd += costUsd(MODEL, tokensIn, tokensOut);
    totals.tokensIn += tokensIn;
    totals.tokensOut += tokensOut;
    totals.calls++;
    decayDelay();

    const finish = response.choices[0]?.finish_reason;
    const content = response.choices[0]?.message?.content ?? "";
    const problem = validateLlmOutput(content, finish, entry);
    if (typeof problem === "string") {
      // Malformed LLM output: retry once, then record as failure (fail fast).
      if (!jsonRetried) {
        jsonRetried = true;
        console.log(`[gen] ${entry.id}: malformed output (${problem}), retrying once`);
        continue;
      }
      throw new Error(`malformed output after retry: ${problem}`);
    }
    return problem;
  }
  throw new Error(`exhausted ${MAX_ATTEMPTS} attempts`);
}

/** Returns the parsed messages, or a string describing what is wrong. */
function validateLlmOutput(
  content: string,
  finishReason: string | undefined,
  entry: SeedEntry,
): { role: string; content: string }[] | string {
  if (finishReason === "length") return "truncated (finish_reason=length)";
  if (!content) return "empty response";
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    return `invalid JSON: ${(e as Error).message}`;
  }
  const messages = (parsed as { messages?: unknown }).messages;
  if (!Array.isArray(messages) || messages.length === 0) return "missing messages array";
  const band = TURN_BANDS[entry.depth];
  if (messages.length < band.hardMin || messages.length > band.hardMax) {
    return `message count ${messages.length} outside ${entry.depth} band [${band.hardMin}, ${band.hardMax}]`;
  }
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i] as { role?: unknown; content?: unknown };
    const expected = i % 2 === 0 ? "user" : "assistant";
    if (m?.role !== expected) return `message ${i} role "${String(m?.role)}" != "${expected}"`;
    if (typeof m.content !== "string" || m.content.trim().length === 0) return `message ${i} has empty content`;
  }
  return messages as { role: string; content: string }[];
}

function buildConversation(
  entry: SeedEntry,
  raw: { role: string; content: string }[],
  start: Date,
  rnd: () => number,
): Conversation {
  let t = start.getTime();
  const messages: Message[] = raw.map((m, i) => {
    if (i > 0) t += (30 + Math.floor(rnd() * 150)) * 1000; // 30s-3min between turns
    return {
      role: m.role as Message["role"],
      content: m.content,
      timestamp: new Date(t).toISOString(),
      metadata: {},
    };
  });
  const model =
    entry.provider === "chatgpt" ? "gpt-4o" : entry.date < "2025-06-01" ? "claude-3-7-sonnet" : "claude-sonnet-4";
  return {
    id: `${entry.provider}:${entry.id}`,
    source: entry.provider,
    source_id: entry.id,
    title: entry.title,
    created_at: start.toISOString(),
    updated_at: new Date(t).toISOString(),
    model,
    messages,
    metadata: {
      synthetic: true,
      persona: "elon-tusk",
      generator: "fixtures/persona/generate.ts",
      seed: { life_areas: entry.life_areas, purpose: entry.purpose, depth: entry.depth, arc_refs: entry.arc_refs },
    },
    synced_at: SYNCED_AT,
  };
}

async function generateOne(client: OpenAI, entry: SeedEntry): Promise<{ messages: number }> {
  const rnd = mulberry32(hashSeed(entry.id));
  const turns = targetTurns(entry, rnd);
  const start = startTime(entry, rnd);
  const raw = await callModel(client, entry, turns, start);
  const conversation = buildConversation(entry, raw, start, rnd);

  const { valid, errors } = validateConversations([conversation]);
  if (valid.length !== 1) throw new Error(`sync-validator rejected: ${errors.join("; ")}`);

  // Atomic write: a crash mid-write must never leave a truncated .json that a
  // resumed run would skip as "done".
  const finalPath = resolve(CORPUS_DIR, `${entry.id}.json`);
  writeFileSync(`${finalPath}.tmp`, `${JSON.stringify(conversation, null, 2)}\n`);
  renameSync(`${finalPath}.tmp`, finalPath);
  return { messages: raw.length };
}

// ------------------------------------------------------------------
// Main
// ------------------------------------------------------------------

async function main(): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error("OPENAI_API_KEY missing (expected in apps/cloud/.env.local)");
    process.exit(1);
  }
  // We own retries/backoff per CLAUDE.md conventions — disable SDK auto-retry.
  const client = new OpenAI({ apiKey, maxRetries: 0 });

  const plan: SeedEntry[] = JSON.parse(readFileSync(SEED_PLAN, "utf8"));
  mkdirSync(CORPUS_DIR, { recursive: true });

  // Optional: --limit N generates at most N pending entries (smoke-testing).
  const args = process.argv.slice(2);
  const limitIdx = args.indexOf("--limit");
  const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : Number.POSITIVE_INFINITY;

  let pending = plan.filter((e) => !existsSync(resolve(CORPUS_DIR, `${e.id}.json`)));
  const skipped = plan.length - pending.length;
  if (pending.length > limit) pending = pending.slice(0, limit);
  console.log(`[gen] model=${MODEL} plan=${plan.length} skip-existing=${skipped} pending=${pending.length} cap=$${COST_CAP_USD}`);

  const failures: Failure[] = [];
  let done = 0;
  let messagesTotal = 0;
  let capAborted = false;
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < pending.length && !capAborted) {
      // Hard cap + projection check before dispatching the next entry.
      if (totals.costUsd >= COST_CAP_USD) {
        capAborted = true;
        break;
      }
      if (done >= 20) {
        const projected = totals.costUsd + (totals.costUsd / done) * (pending.length - done - failures.length);
        if (projected > COST_CAP_USD) {
          console.error(`[gen] ABORT: projected total $${projected.toFixed(2)} exceeds cap $${COST_CAP_USD}`);
          capAborted = true;
          break;
        }
      }
      const entry = pending[cursor++];
      try {
        const { messages } = await generateOne(client, entry);
        done++;
        messagesTotal += messages;
        console.log(
          `[gen] ${entry.id} ok: ${messages} msgs (${done + failures.length}/${pending.length}, $${totals.costUsd.toFixed(2)})`,
        );
      } catch (e) {
        if (e instanceof CostCapError) {
          capAborted = true;
          break;
        }
        failures.push({ id: entry.id, error: (e as Error).message.slice(0, 300) });
        console.error(`[gen] ${entry.id} FAILED: ${(e as Error).message.slice(0, 200)}`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  if (failures.length > 0) {
    writeFileSync(FAILURES_FILE, `${JSON.stringify(failures, null, 2)}\n`);
  } else if (existsSync(FAILURES_FILE)) {
    unlinkSync(FAILURES_FILE);
  }

  console.log("\n=== Generation summary ===");
  console.log(`succeeded: ${done} (+${skipped} already present)`);
  console.log(`failed:    ${failures.length}${failures.length ? ` (see ${FAILURES_FILE})` : ""}`);
  console.log(`messages:  ${messagesTotal} (this run)`);
  console.log(`api calls: ${totals.calls}, tokens in/out: ${totals.tokensIn}/${totals.tokensOut}`);
  console.log(`cost:      $${totals.costUsd.toFixed(4)} (cap $${COST_CAP_USD})`);
  console.log(`429s:      ${rate.count429}`);
  if (capAborted) {
    console.error("[gen] aborted on cost cap — re-run to resume remaining entries");
    process.exit(2);
  }
  if (failures.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
