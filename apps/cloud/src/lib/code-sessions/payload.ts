// Request payload for POST /api/code-sessions (ADR 0021 Q1/Q3/Q8; extended
// per ADR 0023/0026 P2a — code-session knowledge graph, deterministic tier).
//
// The zod mirror of the core `RawCodeSession`/`RawTurn` interfaces the CLI's
// parser produces (packages/core/src/sessions/). Enum members come from core's
// exported arrays (FORGE_VERBS etc., #209), and
// `__tests__/upload-schema.type-lock.test.ts` fails if the schema's input type
// drifts from core's types in either direction.
//
// SOURCE-OPTIONAL (ADR 0026 D13): every new field below is `.optional()` —
// a source/version that doesn't emit it must still validate.
import {
  FORGE_ACTION_SOURCES,
  FORGE_REF_KINDS,
  FORGE_VERBS,
  MAX_INPUT_DIGEST_CHARS,
  MAX_SUBAGENT_TEXT_CHARS,
  MAX_TURN_TEXT_CHARS,
  NON_OWNER_KINDS,
} from "@membral/core";
import { z } from "zod";

// Cap a single turn's text so one crafted turn can't create an oversized row;
// the 4MB body cap bounds the aggregate, this bounds the row. The turn-text,
// digest and sub-agent description limits live in core (wire-limits.ts) so the
// CLI clamps to the same numbers before upload (#480).

// Goal 2026-09-26 W3 (D-051) — a turn's structured forge action, mirrored
// from core's `ForgeAction`. #209: verb/source/refKind validate against core's
// own runtime lists (one source of truth), so an unknown value is a 400, not a
// silently stored string; prod carried no value outside these unions when this
// narrowed. Every string field is already redacted and capped by the parser —
// these caps are a backstop.
const MAX_ACTION_FIELD_CHARS = 500;
export const ForgeActionSchema = z
  .object({
    verb: z.enum(FORGE_VERBS),
    ref: z.string().max(MAX_ACTION_FIELD_CHARS).optional(),
    refKind: z.enum(FORGE_REF_KINDS).optional(),
    sha: z.string().max(40).optional(),
    url: z.string().max(MAX_ACTION_FIELD_CHARS).optional(),
    state: z.string().max(40).optional(),
    branch: z.string().max(MAX_ACTION_FIELD_CHARS).optional(),
    subject: z.string().max(MAX_ACTION_FIELD_CHARS).optional(),
    skill: z.string().max(MAX_ACTION_FIELD_CHARS).optional(),
    source: z.enum(FORGE_ACTION_SOURCES),
    // D-051 F1: the command left the session's directory and nothing named the repo.
    repoUnknown: z.literal(true).optional(),
    // W3 D9 (code_session_forge_refs): the item's title from a single-item view result, capped as the
    // table's `title` column; and a checkout/switch name the parser confirmed is a branch. Optional:
    // older CLIs omit both.
    title: z.string().max(200).optional(),
    branchConfirmed: z.literal(true).optional(),
    // Core marks these LOCAL ONLY, never uploaded (the CLI drops them). Declared so the schema
    // matches core's type; stripped below so a client that sends them anyway never has them stored.
    // No length cap: they are discarded, so their size must never fail a batch.
    dir: z.string().optional(),
    shownRepo: z.string().optional(),
  })
  .transform(({ dir: _dir, shownRepo: _shownRepo, ...uploaded }) => uploaded);
const MAX_ACTIONS_PER_TURN = 64;

export const RawTurnSchema = z.object({
  idx: z.number().int(),
  role: z.enum(["user", "assistant"]),
  kind: z.enum(["prose", "tool_use", "tool_result", "thinking"]),
  text: z.string().max(MAX_TURN_TEXT_CHARS).optional(),
  toolName: z.string().optional(),
  filePath: z.string().optional(),
  ts: z.string(),
  // ADR 0026 additions — all optional, tool_use turns only.
  toolUseId: z.string().optional(),
  resultType: z.enum(["create", "update"]).optional(), // D1
  editHunks: z.number().int().min(0).optional(), // D1
  mcpServer: z.string().optional(), // D2
  mcpTool: z.string().optional(), // D2
  inputDigest: z.string().max(MAX_INPUT_DIGEST_CHARS).optional(), // D10
  action: ForgeActionSchema.optional(), // W3
  actions: z.array(ForgeActionSchema).max(MAX_ACTIONS_PER_TURN).optional(), // W3
  // e2e S2: a user-role prose turn the owner did not write — one of core's
  // NON_OWNER_KINDS (#209: narrowed from a plain string).
  nonOwner: z.enum(NON_OWNER_KINDS).optional(),
  // A prompt with pasted spans (`<pasted_content>`): the owner's own words
  // without them. `text` keeps the paste for context; owner quotes ground on this.
  ownerText: z.string().max(MAX_TURN_TEXT_CHARS).optional(),
});

export type RawTurnPayload = z.infer<typeof RawTurnSchema>;

export const RawCodeSessionRepoSchema = z.object({
  path: z.string().optional(),
  remoteUrl: z.string().optional(),
  branch: z.string().optional(),
});

// Four-bucket usage (ADR 0026 D4) — named to match `gen_ai.usage.*`.
export const RawUsageSchema = z.object({
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  cacheReadInputTokens: z.number().int().min(0),
  cacheCreationInputTokens: z.number().int().min(0),
  // e2e C-8: the 1-hour-TTL share of cacheCreationInputTokens (Claude Code's
  // usage.cache_creation.ephemeral_1h_input_tokens), priced at 2x input.
  // Optional: older CLIs and opencode don't send it (priced as 5-minute).
  cacheCreation1hInputTokens: z.number().int().min(0).optional(),
});

export type RawUsagePayload = z.infer<typeof RawUsageSchema>;

// Cap a session's description/digest-bearing sub-agent fields the same way
// as turn text — bounded, never trusted to be small on its own
// (MAX_SUBAGENT_TEXT_CHARS, imported from core).

// The short identifier-shaped fields aren't meant to be prose — cap them
// symmetrically with description so a hostile/corrupted meta.json sidecar
// can't smuggle an oversized string into one of these instead (the parser
// caps them too, at packages/core/src/sessions/claude-code.ts's
// MAX_SUBAGENT_ID_FIELD_CHARS — this is a backstop for any other client).
const MAX_SUBAGENT_ID_FIELD_CHARS = 2_000;

export const RawSubAgentSchema = z.object({
  toolUseId: z.string().max(MAX_SUBAGENT_ID_FIELD_CHARS).optional(),
  agentId: z.string().max(MAX_SUBAGENT_ID_FIELD_CHARS).optional(),
  agentType: z.string().max(MAX_SUBAGENT_ID_FIELD_CHARS).optional(),
  description: z.string().max(MAX_SUBAGENT_TEXT_CHARS).optional(),
  spawnDepth: z.number().int().min(0).optional(),
  model: z.string().max(MAX_SUBAGENT_ID_FIELD_CHARS).optional(),
  parentAgentId: z.string().max(MAX_SUBAGENT_ID_FIELD_CHARS).optional(),
  isFork: z.boolean().optional(),
  usage: RawUsageSchema.optional(),
});

export type RawSubAgentPayload = z.infer<typeof RawSubAgentSchema>;

// Cap a single session's turn count so one pathological transcript can't blow
// up a request; the CLI parser is expected to compact tool_result payloads
// before upload (ADR Q3), so a well-formed session is well under this.
const MAX_TURNS_PER_SESSION = 20_000;

// A session with a runaway number of sub-agent spawns still can't blow up a
// request — 137 sub-agents was the entire founder-1k corpus (ADR 0026 §1.3).
const MAX_SUBAGENTS_PER_SESSION = 2_000;

const hookCount = z.number().int().min(0).max(1_000_000);
export const HookOutcomesSchema = z.object({
  calls: hookCount,
  injected: hookCount,
  empty: hookCount,
  budget_hit: hookCount,
  timeout: hookCount,
  errors: hookCount,
});

export const RawCodeSessionSchema = z.object({
  source: z.string().min(1),
  sourceSessionId: z.string().min(1),
  contentHash: z.string().min(1),
  repo: RawCodeSessionRepoSchema,
  startedAt: z.string(),
  endedAt: z.string(),
  model: z.string().optional(),
  turns: z.array(RawTurnSchema).max(MAX_TURNS_PER_SESSION),
  filesTouched: z.array(z.string()),
  // Counts land in int4 columns — bound them so a crafted payload can't
  // overflow integer and force a per-session import error.
  toolCounts: z.record(z.string(), z.number().int().min(0).max(1_000_000)),
  // ADR 0026 additions — all optional (D13: source-optional).
  usage: RawUsageSchema.optional(), // D4
  models: z.array(z.string()).max(64).optional(), // D4
  // Forge-action parser version (core FORGE_ACTIONS_VERSION): present => the
  // turns' actions were looked for; absent => a pre-W3 CLI. Stored as
  // code_sessions.props.actions_version.
  actionsVersion: z.number().int().min(1).max(1000).optional(),
  subAgents: z.array(RawSubAgentSchema).max(MAX_SUBAGENTS_PER_SESSION).optional(), // D3
  // A sub-agent's own session: the spawning session's sourceSessionId
  // (stored in code_sessions.parent_source_session_id, migration 089) and
  // the spawn's metadata. Absent on every top-level session.
  parentSessionId: z.string().min(1).max(MAX_SUBAGENT_ID_FIELD_CHARS).optional(),
  subAgent: RawSubAgentSchema.optional(),
  // Recall-precision W3b: the CLI prompt hook's outcome counts for this
  // session (old CLIs send nothing). Stored as code_sessions.props.hook_outcomes.
  hookOutcomes: HookOutcomesSchema.optional(),
});

export type RawCodeSessionPayload = z.infer<typeof RawCodeSessionSchema>;

// Batch cap (ADR Q1 backfill path): a single request imports at most this
// many sessions; the CLI's `sessions` backfill chunks its walk of
// `~/.claude/projects/**/*.jsonl` into batches of this size.
export const MAX_BATCH_SIZE = 20;

export const CodeSessionsRequestSchema = z.object({
  sessions: z.array(RawCodeSessionSchema).max(MAX_BATCH_SIZE),
  // Backfill escape hatch (issue #91): when true, importCodeSession skips its
  // content_hash short-circuit and re-imports every session in the batch even
  // if unchanged — still idempotent (upsert + replaceTurns wholesale-replace
  // either way), used one-off by `membral sessions --force` to backfill
  // code_sessions.props.usage on rows imported before ADR 0026 D3/D4 landed.
  force: z.boolean().optional(),
});

export type CodeSessionsRequest = z.infer<typeof CodeSessionsRequestSchema>;
