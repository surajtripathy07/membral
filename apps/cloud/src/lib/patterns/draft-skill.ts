// Goal 2026-09-26 P9 / W10 — draft a skill file from a mined pattern.
//
// One LLM call per pattern (per week — derive.ts decides when to re-ask)
// turns a step sequence like `npm test → Edit ts → git commit` into a
// short named skill. The model's JSON is validated with Zod (CLAUDE.md
// rule 3); a malformed, empty or failed response falls back to
// heuristicSkill(), whose steps are the sequence itself — so the card
// always has something honest to show and this module never throws.
// Membral only DRAFTS the file text (renderSkillBody); it never installs
// anything (B9).
//
// Goal P9's chain is pattern → sessions → quotes: derive.ts reads the
// owner's opening prompt from a few of the pattern's sessions
// (PatternQuote); the draft is asked FROM those quotes and carries them as
// `sources`, and the SKILL.md body cites each one (session + turn), so the
// draft always says what it was mined from.
import { z } from "zod";
import type { LlmClient } from "@/lib/llm/client";
import { log } from "@/lib/log";
import type { Pattern } from "./mine";

export const SkillDraftSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .transform((s) => slugify(s)),
  description: z.string().trim().min(1).max(400),
  steps: z.array(z.string().trim().min(1).max(400)).min(1).max(12),
});

export type SkillDraftSource = "llm" | "heuristic";

/** One of the owner's own words from a session the pattern was mined from. */
export interface PatternQuote {
  session_id: string;
  turn_idx: number;
  quote: string;
}

/** Sessions quoted per draft, and the longest quote kept. */
export const MAX_DRAFT_QUOTES = 5;
export const MAX_QUOTE_CHARS = 240;

export interface SkillDraft {
  /** Skill directory / frontmatter name — a slug. */
  name: string;
  description: string;
  steps: string[];
  source: SkillDraftSource;
  /** The quotes the draft was mined from; every one is from a session in `pattern.sessionIds`. */
  sources: PatternQuote[];
}

/** The one method of LlmClient this module uses — tests inject a fake. */
export type SkillDraftLlm = Pick<LlmClient, "callJson">;

/** Hard ceiling on one draft's output; a skill is a few lines, not an essay. */
export const DRAFT_MAX_OUTPUT_TOKENS = 600;

export function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return slug || "workflow";
}

/** `npm test` → "Run `npm test`"; `Edit ts` → "Edit the .ts files"; `Agent` → "Use Agent". */
export function describeStep(step: string): string {
  if (step === "Edit") return "Edit the relevant files";
  if (step.startsWith("Edit ")) return `Edit the .${step.slice(5)} files`;
  if (/^[A-Z]/.test(step) && !step.includes(" ")) return `Use ${step}`;
  return `Run \`${step}\``;
}

/** Only quotes from the pattern's own sessions, trimmed and capped — the chain's guard. */
export function quotesForPattern(pattern: Pattern, quotes: readonly PatternQuote[] = []): PatternQuote[] {
  const allowed = new Set(pattern.sessionIds);
  const seen = new Set<string>();
  const out: PatternQuote[] = [];
  for (const q of quotes) {
    if (!allowed.has(q.session_id) || seen.has(q.session_id)) continue;
    const text = q.quote.replace(/\s+/g, " ").trim();
    if (!text) continue;
    seen.add(q.session_id);
    out.push({
      session_id: q.session_id,
      turn_idx: q.turn_idx,
      quote: text.length > MAX_QUOTE_CHARS ? `${text.slice(0, MAX_QUOTE_CHARS - 1)}…` : text,
    });
    if (out.length >= MAX_DRAFT_QUOTES) break;
  }
  return out;
}

/** The no-LLM draft: name and steps come straight from the sequence. */
export function heuristicSkill(pattern: Pattern, quotes: readonly PatternQuote[] = []): SkillDraft {
  const name = slugify(
    pattern.steps
      .map(
        (s) =>
          s
            .replace(/^Edit\b.*/, "edit")
            .split(" ")
            .slice(-1)[0],
      )
      .join("-"),
  );
  const sequence = pattern.steps.map((s) => `\`${s}\``).join(" → ");
  return {
    name,
    description: `Runs ${sequence}, as done in ${pattern.sessionCount} sessions of this project.`,
    steps: pattern.steps.map(describeStep),
    source: "heuristic",
    sources: quotesForPattern(pattern, quotes),
  };
}

const SYSTEM_PROMPT = `You name and describe a small reusable coding-agent skill from an observed habit.
You are given a sequence of tool steps a developer repeated across many coding sessions in one project, and what the developer asked for at the start of some of those sessions.
Reply with ONLY a JSON object: {"name": string (2-4 words, kebab-case), "description": string (one sentence, what the skill does and when to use it), "steps": string[] (one imperative line per step, same order, same commands)}.
Do not invent commands that are not in the sequence. Do not add steps.`;

export interface DraftSkillOptions {
  /** Used for the ledger's conversation key. */
  projectId: string;
  /** Optional project name for the prompt. */
  projectName?: string | null;
  /** The owner's words from the pattern's sessions (derive.ts); filtered to those sessions. */
  quotes?: readonly PatternQuote[];
}

/**
 * Draft a skill for `pattern`. `llm` null → heuristic only (no spend). Any
 * failure — cap breach, timeout, malformed JSON, schema mismatch — is logged
 * and yields the heuristic draft. Never throws.
 */
export async function draftSkill(
  pattern: Pattern,
  llm: SkillDraftLlm | null,
  opts: DraftSkillOptions,
): Promise<SkillDraft> {
  const sources = quotesForPattern(pattern, opts.quotes);
  const fallback = heuristicSkill(pattern, sources);
  if (!llm) return fallback;
  const userPrompt = [
    opts.projectName ? `Project: ${opts.projectName}` : null,
    `Seen in ${pattern.sessionCount} sessions.`,
    "Steps, in order:",
    ...pattern.steps.map((s, i) => `${i + 1}. ${s}`),
    ...(sources.length > 0
      ? [
          "What the developer asked for in some of those sessions:",
          ...sources.map((q) => `- ${JSON.stringify(q.quote)}`),
        ]
      : []),
  ]
    .filter((l): l is string => l !== null)
    .join("\n");
  try {
    const { data } = await llm.callJson({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt,
      // Billed under the memory budget (goal P9: "`memory` budget, ≤ $0.05");
      // PassName is a closed union owned by lib/kg/types.ts.
      pass: "memory_backfill",
      conversationId: `pattern:${opts.projectId}:${slugify(pattern.key)}`,
      schema: SkillDraftSchema,
      maxTokens: DRAFT_MAX_OUTPUT_TOKENS,
      temperature: 0.2,
    });
    return { ...data, source: "llm", sources };
  } catch (err) {
    log.warn("patterns/draft-skill: LLM draft failed — using the heuristic draft", {
      project_id: opts.projectId,
      pattern: pattern.key,
      err: err instanceof Error ? err.message : String(err),
    });
    return fallback;
  }
}

/** The copy-able SKILL.md text the card shows — Membral writes no file itself (B9). */
export function renderSkillBody(draft: SkillDraft, pattern: Pattern): string {
  const lines = [
    "---",
    // JSON strings are valid YAML scalars: a `: ` or `#` in the model's text cannot break the front matter (F14).
    `name: ${JSON.stringify(draft.name)}`,
    `description: ${JSON.stringify(draft.description.replace(/\s+/g, " ").trim())}`,
    "---",
    "",
    `# ${draft.name}`,
    "",
    `Observed in ${pattern.sessionCount} sessions as \`${pattern.steps.join(" → ")}\`.`,
    "",
    "## Steps",
    "",
    ...draft.steps.map((s, i) => `${i + 1}. ${s}`),
    "",
  ];
  const sources = draft.sources ?? [];
  if (sources.length > 0) {
    lines.push("## Mined from", "");
    for (const q of sources) lines.push(`- session ${q.session_id}, turn ${q.turn_idx}: ${JSON.stringify(q.quote)}`);
    lines.push("");
  }
  return lines.join("\n");
}
