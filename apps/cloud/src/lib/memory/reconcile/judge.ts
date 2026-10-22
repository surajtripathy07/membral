// L1: the model verdict for batches of (older, newer) pairs. One call per batch of at most MAX_PAIRS_PER_CALL pairs.
// Never throws: a failed or malformed call abstains for every pair in the batch (the caller then falls back to the
// existing planSupersede rule when the provider is down, `failed: true`). Direction is decided by orientPair, never
// by the model.
import { log } from "../../log";
import {
  type AcceptedLink,
  acceptVerdict,
  MAX_PAIRS_PER_CALL,
  type OrientedPair,
  parseVerdicts,
  type ReconTurn,
  VerdictWire,
} from "./verdict";

/** The slice of LlmClient the judge needs (a test passes a fake). */
export interface JudgeLlm {
  /** The label the client calls the model by (`claude-code/sonnet`); the live path refuses any other. */
  modelName?: string;
  callJson<T>(opts: {
    systemPrompt: string;
    userPrompt: string;
    pass: "memory_backfill";
    conversationId: string;
    schema?: { parse: (data: unknown) => T };
    maxTokens?: number;
    temperature?: number;
  }): Promise<{ data: T; record: { cost_usd: number } }>;
}

export interface JudgeItem {
  pair: OrientedPair;
  cosine: number | null;
  /** Turns of the NEWER record's session. */
  turns: readonly ReconTurn[];
}

export interface JudgedItem {
  item: JudgeItem;
  accepted: AcceptedLink;
  /** True only when a model reply covered this batch. Skipped (cap/stop) and failed pairs are not answered: never memoised. */
  answered: boolean;
}

export const RECONCILE_SYSTEM_PROMPT = `You compare pairs of memory records written by a coding agent's past sessions. For each pair there is an OLDER record and a NEWER record from the same repository, plus an excerpt of the session that wrote the NEWER one.

Decide how the NEWER record relates to the OLDER one. Be strict: when in doubt answer "unrelated".
- "supersedes": the two records are about the SAME artifact or object, both cannot be true now, and the NEWER record's own text states the state that replaces the older (a later ruling, a changed fact, a reversal). Give:
  - "subject": the shared artifact/object both records are about (a file, package, flag, PR, rule), a short phrase that appears in both records;
  - "replacing_state_quote": the words, copied verbatim from the NEWER record text above (not from the excerpt), that state the replacing state;
  - "evidence_quote": words copied verbatim from the session excerpt that show the change.
  It is NOT "supersedes" when the newer record only adds detail, covers a neighbouring topic, or both records can still be true: use "refines" or "unrelated".
- "resolves": the OLDER record is an open blocker and the NEWER record closes THE SAME blocker: both name the same artifact (same PR or issue number, goal item, package, file or migration). Give "shared_artifact": that artifact token exactly as it is written in BOTH records (for example "#459", "migration 124", "reconcile.ts"), and a verbatim "evidence_quote" from the excerpt. An outcome on a nearby topic does not close a different blocker.
- "duplicates": either record could be deleted and a reader would lose nothing. Name anything the OLDER record says that the NEWER one does not in lost_information; use the empty string "" only if nothing is lost (never null for a duplicates verdict). If the NEWER record says everything the older does AND more, that is "refines", not "duplicates".
- "refines": the newer one adds detail but both stay true.
- "unrelated": anything else, or when unsure.

Rules: judge only from the text shown. A reversal ("do X" then "do not do X") is "supersedes", never "duplicates". Different identifiers (numbers, ids, versions) are different facts. Never invent a quote; every quote must be a verbatim copy.

Reply with JSON only: {"verdicts":[{"pair":0,"relation":"unrelated","subject":null,"replacing_state_quote":null,"shared_artifact":null,"evidence_quote":null,"lost_information":""}, ...]} with one entry per pair, "pair" being the pair number shown.`;

const EXCERPT_RADIUS = 4;
const CLIP = 500;

function clip(s: string | null | undefined, n = CLIP): string {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function day(ms: number | undefined): string {
  return ms !== undefined && Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : "unknown date";
}

/** The excerpt around the newer record's turn (or the first turns when the receipt is unknown). */
export function excerptFor(item: JudgeItem): string {
  const at = item.pair.from.turn_idx;
  const sorted = [...item.turns].sort((a, b) => a.idx - b.idx);
  const near =
    at === null ? sorted.slice(0, EXCERPT_RADIUS * 2) : sorted.filter((t) => Math.abs(t.idx - at) <= EXCERPT_RADIUS);
  return near.map((t) => `[turn ${t.idx}] ${clip(t.text)}`).join("\n");
}

export function buildPrompt(items: readonly JudgeItem[]): string {
  return items
    .map((it, i) =>
      [
        `### Pair ${i} (kind: ${it.pair.to.kind} -> ${it.pair.from.kind})`,
        `OLDER (session ${day(it.pair.to.sessionStart)}): ${clip(it.pair.to.text, 700)}`,
        `NEWER (session ${day(it.pair.from.sessionStart)}): ${clip(it.pair.from.text, 700)}`,
        `NEWER session excerpt:\n${excerptFor(it) || "(no excerpt)"}`,
      ].join("\n"),
    )
    .join("\n\n");
}

export interface JudgeResult {
  judged: JudgedItem[];
  calls: number;
  failed: boolean;
  costUsd: number;
  /** Pairs that abstained without a call because the run-wide call cap was spent. */
  skipped: number;
  /** Batches that failed once and were retried as two shorter batches. */
  retries: number;
}

const abstained = (item: JudgeItem): JudgedItem => ({
  item,
  accepted: { relation: "unrelated", quote: null, verified: false, turn_idx: null },
  answered: false,
});

/**
 * Judges `items` in batches of at most MAX_PAIRS_PER_CALL. `maxCalls` is the run-wide cap: once spent, the rest
 * abstain WITHOUT a call and `capped` reports it through `calls` reaching the cap (the caller checks).
 * A call that fails (a 120 s timeout, a malformed envelope) is retried ONCE with a shorter batch: the batch is split in
 * two halves, each tried once (each counts against the cap). A half that fails again abstains.
 */
export async function judgePairs(
  llm: JudgeLlm,
  items: readonly JudgeItem[],
  opts: { conversationId: string; maxCalls: number; callsSoFar?: number; shouldStop?: () => boolean },
): Promise<JudgeResult> {
  const judged: JudgedItem[] = [];
  let calls = 0;
  let failed = false;
  let costUsd = 0;
  let skipped = 0;
  let retries = 0;
  const base = opts.callsSoFar ?? 0;
  const spent = () => base + calls >= opts.maxCalls || !!opts.shouldStop?.();

  /** One call for `batch`; true on success, false on error (nothing pushed to `judged` on failure). */
  const attempt = async (batch: readonly JudgeItem[]): Promise<boolean> => {
    calls++;
    try {
      const { data, record } = await llm.callJson<unknown>({
        systemPrompt: RECONCILE_SYSTEM_PROMPT,
        userPrompt: buildPrompt(batch),
        pass: "memory_backfill",
        conversationId: opts.conversationId,
        schema: VerdictWire,
        maxTokens: 2048,
        temperature: 0,
      });
      costUsd += record.cost_usd;
      const byPair = parseVerdicts(data);
      batch.forEach((it, k) => {
        judged.push({
          item: it,
          accepted: acceptVerdict(byPair.get(k), { pair: it.pair, turns: it.turns, cosine: it.cosine }),
          answered: true,
        });
      });
      return true;
    } catch (err) {
      log.warn("memory reconcile: judge call failed", {
        conversation_id: opts.conversationId,
        batch: batch.length,
        err: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  };
  const abstainAll = (batch: readonly JudgeItem[], counted: boolean) => {
    if (counted) skipped += batch.length;
    for (const it of batch) judged.push(abstained(it));
  };

  for (let i = 0; i < items.length; i += MAX_PAIRS_PER_CALL) {
    const batch = items.slice(i, i + MAX_PAIRS_PER_CALL);
    if (spent()) {
      abstainAll(batch, true);
      continue;
    }
    if (await attempt(batch)) continue;
    // Retry once with a shorter batch: two halves (a single pair is retried as is).
    retries++;
    const mid = Math.ceil(batch.length / 2);
    const parts = batch.length > 1 ? [batch.slice(0, mid), batch.slice(mid)] : [batch];
    for (const part of parts) {
      if (spent()) {
        abstainAll(part, true);
        continue;
      }
      if (!(await attempt(part))) {
        failed = true;
        abstainAll(part, false);
      }
    }
  }
  return { judged, calls, failed, costUsd, skipped, retries };
}
