// opencode session parser (goal 2026-09-12 W6 / D5; second harness per the
// maintainer's 2026-09-12 decision — "if I were to pick two harnesses I'd
// pick Claude and opencode").
//
// opencode stores sessions in a SQLite database
// (`~/.local/share/opencode/opencode.db`), not one-file-per-session JSONL
// like Claude Code. core has zero runtime dependencies (see the package
// boundary in CLAUDE.md), so this parser never touches `node:sqlite` or any
// other driver — that lives in the CLI (`packages/cli/src/opencode-export.ts`),
// which queries the DB and hands this parser a plain JSON object
// (`OpencodeSessionExport`) as the `raw` bytes. `detect()` therefore always
// returns `[]` here (see its doc comment) — opencode session *discovery*
// happens in the CLI via SQL, not via a filesystem walk core can do itself.
//
// Schema observed on a real opencode install (`opencode.db`, schema
// `session`/`message`/`part`/`project` tables, drizzle-migrated) — verified
// against the live DB, not opencode's source:
//   - `session`: one row per session (main or sub-agent). Columns include
//     `parent_id` (sub-agent sessions have their spawning session's id here
//     — this is how opencode represents the sub-agent tree; there is no
//     separate sidecar file the way Claude Code has `subagents/agent-*.jsonl`),
//     `directory` (real cwd, ground truth like Claude Code's `cwd`), `agent`
//     (the agent/mode name, e.g. "build", "explore", "oracle" — this doubles
//     as RawSubAgent.agentType for a child session), `model` (JSON text
//     `{"id":...,"providerID":...}`, frequently NULL even on sessions with
//     real usage — the per-message `modelID`/`providerID` fields are the
//     reliable source, mirrored from claude-code.ts's own preference for
//     `message.model` over the 42%-populated `meta.model`), and
//     `tokens_input`/`tokens_output`/`tokens_reasoning`/`tokens_cache_read`/
//     `tokens_cache_write`/`cost` — ALREADS pre-aggregated for the whole
//     session by opencode itself, unlike Claude Code where this parser has
//     to sum every assistant message's usage by hand.
//   - `message`: one row per assistant "step" (not one row per full reply —
//     a single logical assistant turn is often split across several
//     `message` rows sharing the same `parentID` in their `data` JSON,
//     analogous to Claude Code's multi-line same-`message.id` blocks, but at
//     message-row rather than JSONL-line granularity) plus one row per user
//     turn. `data` is a JSON blob: user rows carry `{role:"user", time:
//     {created}, agent, model}`; assistant rows carry `{parentID, role:
//     "assistant", modelID, providerID, tokens:{...}, time:{created,
//     completed}, finish, error?}`. Text/tool content is NOT in this row —
//     it's in `part`.
//   - `part`: one row per content unit within a message (`type`: "text",
//     "reasoning", "tool", "step-start", "step-finish", "patch", "file",
//     "agent", "subtask" observed). Unlike Claude Code, a `tool` part
//     carries BOTH the call and its result in one row (`state.input` /
//     `state.output` / `state.status`) — there is no separate tool_result
//     event to join against, so this parser never emits a `tool_result`
//     turn for opencode (Claude Code's tool_result turns carry little beyond
//     ok/error anyway; that status is available via `state.status`).
//
// Sub-agent spawns: the `task` tool (opencode's Agent/Task equivalent)
// writes its spawned session id into the tool part's own `output` text as
// `"task_id: ses_XXX ..."` — there is no structured field for it. This
// parser regex-matches that text to recover the spawning tool_use's
// `callID` (-> RawSubAgent.toolUseId) and `input.description` for the
// matching child session, joined by session id (-> RawSubAgent.agentId).
// This is the same "best-effort join, degrade rather than fail" posture as
// claude-code.ts's meta.json parsing.
//
// NOT modeled (documented, not silently dropped):
//   - Only DIRECT children (`parent_id` = the session being parsed) are
//     surfaced in this session's `subAgents[]` metadata (every descendant is
//     ALSO exported by the CLI as its own session, with `parentSessionId` =
//     its direct parent — see the end of `parse()`); a sub-agent that itself spawned a further
//     sub-agent is not walked recursively. `spawnDepth` is therefore always
//     `1` for every RawSubAgent this parser produces, and `parentAgentId`
//     is always undefined (no nested chain to report).
//   - `isFork` has no opencode analog (no field carries it) — always
//     undefined.
//   - `resultType`/`editHunks` are only populated for the `edit` tool
//     (opencode's `edit` only ever modifies an existing file, so
//     `resultType` is always `"update"`; `editHunks` is a count of unified
//     diff hunk headers in `state.metadata.diff` when present, the closest
//     available proxy for Claude Code's `structuredPatch.length`). `write`
//     can create OR overwrite and opencode's tool output doesn't say which,
//     so `resultType` is left undefined for `write` (never guessed).
//   - MCP attribution: opencode's `part.tool` is a flat string with no
//     structured server/tool split (unlike Claude Code's
//     `attributionMcpServer`/`attributionMcpTool`, ~1,349 events, explicit).
//     No MCP server was configured on the machine this was validated
//     against, so the heuristic below (split on the first `_` for any tool
//     name outside the known-builtin set) is UNVALIDATED against real MCP
//     traffic — treat `mcpServer`/`mcpTool` from this parser as low
//     confidence, and expect it to misclassify plugin-provided tools (e.g.
//     this machine's `browser_*`/`websearch_*` tools are plugin-provided,
//     not MCP, and are explicitly excluded from the heuristic below because
//     they were observed directly; a differently-configured opencode
//     install could still trip it on some other plugin's tool name).
//   - `file`-type parts (attachments) and `agent`-type parts (agent/mode
//     switch markers) and `subtask`-type parts (slash-command agent
//     invocations, a different mechanism from the `task` tool) carry no
//     text/tool content this parser's turn shape can represent — skipped,
//     same as claude-code.ts's "unknown content block types are ignored
//     defensively".

import { createHash } from "node:crypto";
import {
  actionFromPastedText,
  assignActions,
  createCommitShaBackfill,
  deriveToolActions,
  FORGE_ACTIONS_VERSION,
  FORGE_COMMAND,
  MAX_DIGEST_CHARS,
} from "./forge-actions.js";
import { buildInputDigest, type InputDigestConfig } from "./input-digest.js";
import { redactSecrets } from "./redact.js";
import type { CodeSessionParser, RawCodeSession, RawSubAgent, RawTurn, RawUsage, SessionRef } from "./types.js";

/** One `message` table row, as exported by the CLI — `data` is that row's raw JSON text, unparsed (this parser parses it). */
export interface OpencodeMessageRow {
  id: string;
  /** Raw JSON text of the row's `data` column. */
  data: string;
}

/** One `part` table row, as exported by the CLI — `data` is that row's raw JSON text, unparsed. */
export interface OpencodePartRow {
  messageId: string;
  /** Raw JSON text of the row's `data` column. */
  data: string;
}

/** One `session` table row's scalar columns, as exported by the CLI. */
export interface OpencodeSessionRow {
  id: string;
  parentId: string | null;
  directory: string;
  title: string;
  agent: string | null;
  /** Raw JSON text of the `model` column (`{"id":...,"providerID":...}`), or null — frequently null even on sessions with real usage; see module doc comment. */
  modelRaw: string | null;
  timeCreated: number; // epoch ms
  timeUpdated: number; // epoch ms
  cost: number;
  tokensInput: number;
  tokensOutput: number;
  tokensReasoning: number;
  tokensCacheRead: number;
  tokensCacheWrite: number;
}

/** A direct child (`parent_id` = the parsed session's id) — see module doc comment for why only direct children are modeled. */
export interface OpencodeSubAgentExport {
  session: OpencodeSessionRow;
  /** Only needed to derive the child's own `model` string (session.model is frequently null) — parts/turns are not modeled for sub-agents, matching ADR 0026 D3's Claude Code granularity (model + usage summary, not a full turn list). */
  messages: OpencodeMessageRow[];
}

/** The plain-JSON shape the CLI exports from SQLite and hands to `opencodeParser.parse()` as `raw` (JSON.stringify'd). */
export interface OpencodeSessionExport {
  session: OpencodeSessionRow;
  messages: OpencodeMessageRow[];
  parts: OpencodePartRow[];
  subAgents?: OpencodeSubAgentExport[];
}

// --- `data` column shapes (parsed defensively; a malformed/missing field never throws — degrades to undefined, matching claude-code.ts's parseSubAgentFile posture). ---

interface OCModelRef {
  id?: string;
  providerID?: string;
}

interface OCMessageData {
  role?: string;
  parentID?: string;
  agent?: string;
  model?: OCModelRef; // user rows
  modelID?: string; // assistant rows
  providerID?: string; // assistant rows
  time?: { created?: number; completed?: number };
  finish?: string;
  error?: { name?: string; data?: unknown };
}

interface OCToolState {
  status?: string;
  input?: Record<string, unknown>;
  output?: string;
  // `sessionId` (a `task` tool's spawned child) is present on both
  // `status: "completed"` AND `status: "error"` task parts (verified
  // against the live DB, including a cancelled spawn with no `output`
  // text at all) — the structured join key `childSessionIdFromTaskPart`
  // prefers over the `output`-text fallback (2026-09-12 review, finding 6).
  // `exit` is the bash exit code: a failed command is still `status:
  // "completed"` with a nonzero exit (checked on the live DB).
  metadata?: { diff?: string; sessionId?: string; exit?: number };
  time?: { start?: number; end?: number };
}

interface OCPartData {
  type?: string;
  text?: string;
  tool?: string;
  callID?: string;
  state?: OCToolState;
  time?: { start?: number; end?: number };
}

// ADR 0026 D10's tool-input digest is a privacy-relevant surface (shell
// commands/URLs/prompts can carry secrets, hostnames, private paths) — the
// contract in `types.ts`'s `RawTurn.inputDigest` doc comment is an
// ALLOWLISTED subset only: gh/git Bash commands, Agent/Task description,
// WebFetch url — "never populated for non-allowlisted tools". claude-code.ts
// gates its `bash` digest on this same regex (`FORGE_COMMAND`); this parser
// mirrors it exactly rather than digesting every bash command opencode ever
// ran (2026-09-12 adversarial review, finding 3 — measured on the live DB:
// gating on gh/git cut 3,919 candidate bash digests to 629, and removed
// 1,334 digests that still carried the OS username and 1,325 that carried
// an absolute $HOME path even after redactSecrets, which only catches
// labelled/patterned credentials, not arbitrary shell output). The gate now
// lives in forge-actions.ts (`digestBashCommand`: gh/git/glab at 1200 chars,
// test runners at 400 — goal 2026-09-26 W3) so both parsers share it.

/** opencode tool names (always lowercase) → digest kind. */
export const INPUT_DIGEST_CONFIG: InputDigestConfig = {
  kinds: { bash: "bash", task: "agent", webfetch: "webfetch" },
};

// Tool names this parser knows are opencode builtins or machine-observed
// plugin tools, NOT MCP servers — see the MCP-attribution caveat in the
// module doc comment. Anything outside this set is a heuristic guess.
const KNOWN_NON_MCP_TOOLS = new Set([
  "bash",
  "read",
  "write",
  "edit",
  "glob",
  "grep",
  "todowrite",
  "webfetch",
  "question",
  "task",
  "skill",
  "invalid",
  "look_at",
]);
// `websearch_` and `session_` are PREFIXES, not exact names (2026-09-12
// adversarial review, finding 8): the two tools observed on the validation
// machine were `websearch_web_search_exa` and `session_search`, but listing
// them as exact strings means any OTHER tool from those same plugins (e.g.
// a sibling `websearch_*` or `session_*` entry) falls through as a
// fabricated MCP server. Treating the whole family as builtin/plugin,
// keyed by prefix, is the conservative direction — it can only ever
// under-attribute MCP, never invent a server node from a real plugin tool.
const KNOWN_NON_MCP_PREFIXES = ["browser_", "lsp_", "background_", "websearch_", "session_"];

// Tools whose `input.filePath` is meaningful, mirroring claude-code.ts's
// FILE_PATH_TOOLS (which also includes Read).
const FILE_PATH_TOOLS = new Set(["edit", "write", "read"]);

function isLikelyMcpTool(tool: string): { mcpServer?: string; mcpTool?: string } {
  if (KNOWN_NON_MCP_TOOLS.has(tool)) return {};
  if (KNOWN_NON_MCP_PREFIXES.some((p) => tool.startsWith(p))) return {};
  const idx = tool.indexOf("_");
  if (idx <= 0 || idx === tool.length - 1) return {};
  return { mcpServer: tool.slice(0, idx), mcpTool: tool.slice(idx + 1) };
}

function parseJson<T>(text: string | null | undefined): T | undefined {
  if (!text) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === "object") return parsed as T;
    return undefined;
  } catch {
    return undefined;
  }
}

function toIso(epochMs: number | undefined): string | undefined {
  // `epochMs <= 0` is rejected too (2026-09-12 review, finding 9): `0` is a
  // plausible "field absent, defaulted to zero" value from a malformed row,
  // never a real opencode timestamp (the corpus's earliest real
  // `time_created` is in the 1.7e12 range) — treating it as valid would let
  // a single bad row win the session-level `startedAt` min-reduce below.
  if (typeof epochMs !== "number" || !Number.isFinite(epochMs) || epochMs <= 0) return undefined;
  const d = new Date(epochMs);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** Session-level usage: opencode pre-aggregates per-session, unlike Claude Code (module doc comment). Reasoning tokens have no dedicated RawUsage bucket — every provider bills them as output tokens, so they're folded into outputTokens here (ADR-equivalent decision recorded in W6's report, not a separate ADR per the 2026-09-12 "no unbounded ADRs" decision). */
function usageFromSessionRow(row: OpencodeSessionRow): RawUsage | undefined {
  const { tokensInput, tokensOutput, tokensReasoning, tokensCacheRead, tokensCacheWrite } = row;
  if (!tokensInput && !tokensOutput && !tokensReasoning && !tokensCacheRead && !tokensCacheWrite) return undefined;
  return {
    inputTokens: tokensInput || 0,
    outputTokens: (tokensOutput || 0) + (tokensReasoning || 0),
    cacheReadInputTokens: tokensCacheRead || 0,
    cacheCreationInputTokens: tokensCacheWrite || 0,
  };
}

function modelStringFromRef(ref: OCModelRef | undefined): string | undefined {
  if (!ref?.id) return undefined;
  return ref.providerID ? `${ref.providerID}/${ref.id}` : ref.id;
}

/** Last non-empty modelID/providerID across a session's assistant message rows (mirrors claude-code.ts preferring message-level model over session/meta-level model). */
function deriveModelFromMessages(messages: OpencodeMessageRow[]): { model?: string; models: Set<string> } {
  let model: string | undefined;
  const models = new Set<string>();
  for (const row of messages) {
    const data = parseJson<OCMessageData>(row.data);
    if (!data || data.role !== "assistant") continue;
    if (data.modelID) {
      const s = data.providerID ? `${data.providerID}/${data.modelID}` : data.modelID;
      model = s;
      models.add(s);
    }
  }
  return { model, models };
}

function countDiffHunks(diff: string | undefined): number | undefined {
  if (!diff) return undefined;
  const matches = diff.match(/^@@ /gm);
  return matches ? matches.length : undefined;
}

/** Fallback: extracts the spawned session id from a `task` tool's output text (`"task_id: ses_XXX ..."`) — only reached when `state.metadata.sessionId` (the structured field) is absent. */
function taskIdFromOutput(output: string | undefined): string | undefined {
  if (!output) return undefined;
  const m = /task_id:\s*(\S+)/.exec(output);
  return m?.[1];
}

/**
 * Resolves the child session id a `task` tool_use spawned. Prefers
 * `state.metadata.sessionId` — verified 100% present on every `task` part
 * in the live DB regardless of outcome (`status: "completed"` AND
 * `status: "error"`/cancelled, where there is no `output` text at all to
 * regex against) — falling back to the `output`-text join only if that
 * structured field is ever absent (e.g. an older opencode version).
 */
function childSessionIdFromTaskPart(part: OCPartData): string | undefined {
  const metaId = part.state?.metadata?.sessionId;
  if (typeof metaId === "string" && metaId) return metaId;
  return taskIdFromOutput(part.state?.output);
}

function buildSubAgent(sub: OpencodeSubAgentExport, taskParts: OCPartData[]): RawSubAgent {
  const { model } = deriveModelFromMessages(sub.messages);
  const usage = usageFromSessionRow(sub.session);

  // Find the parent's `task` tool_use whose output names this child session,
  // for toolUseId/description — best-effort, undefined if no match (e.g. the
  // spawn used a mechanism other than the `task` tool, or the output text
  // didn't match the expected shape).
  let toolUseId: string | undefined;
  let description: string | undefined;
  for (const part of taskParts) {
    if (childSessionIdFromTaskPart(part) === sub.session.id) {
      toolUseId = part.callID;
      const desc = part.state?.input?.description;
      description = typeof desc === "string" ? redactSecrets(desc).slice(0, MAX_DIGEST_CHARS) : undefined;
      break;
    }
  }

  return {
    toolUseId,
    agentId: sub.session.id,
    agentType: sub.session.agent ?? undefined,
    description,
    spawnDepth: 1,
    model,
    usage,
  };
}

export const opencodeParser: CodeSessionParser = {
  source: "opencode",

  // opencode session discovery requires querying SQLite, which core cannot
  // do (no runtime dependencies — see module doc comment). The CLI performs
  // discovery itself (packages/cli/src/opencode-export.ts) and calls
  // `parse()` directly with a `SessionRef` it constructs by hand plus the
  // exported JSON as `raw`. This always returns `[]` so the interface
  // contract (`detect()` never throws for "nothing found") still holds for
  // any caller that invokes it directly.
  async detect(_root: string, _onWarn?: (message: string) => void): Promise<SessionRef[]> {
    return [];
  },

  parse(ref: SessionRef, raw: string | Buffer): RawCodeSession {
    const bytes = typeof raw === "string" ? Buffer.from(raw, "utf8") : raw;
    const contentHash = createHash("sha256").update(bytes).digest("hex");

    let exportData: OpencodeSessionExport;
    try {
      exportData = JSON.parse(bytes.toString("utf8")) as OpencodeSessionExport;
    } catch {
      // Malformed export — never throw (ADR 0026 D13 posture, same as every
      // other parser in this package). Return the smallest valid session.
      return {
        source: "opencode",
        sourceSessionId: ref.sourceSessionId,
        contentHash,
        repo: {},
        startedAt: "",
        endedAt: "",
        turns: [],
        filesTouched: [],
        toolCounts: {},
      };
    }

    const { session, messages, parts, subAgents } = exportData;
    const partsByMessage = new Map<string, OCPartData[]>();
    for (const p of parts ?? []) {
      let data: OCPartData | undefined;
      try {
        data = JSON.parse(typeof p.data === "string" ? p.data : String(p.data)) as OCPartData;
      } catch {
        continue; // malformed part row — skip defensively
      }
      const list = partsByMessage.get(p.messageId) ?? [];
      list.push(data);
      partsByMessage.set(p.messageId, list);
    }

    const turns: RawTurn[] = [];
    // F2 — a quiet commit's sha from a later `git rev-parse HEAD` / `git log`.
    const shaBackfill = createCommitShaBackfill();
    const filesTouchedSet = new Set<string>();
    const toolCounts: Record<string, number> = {};
    const timestamps: string[] = [];
    const modelsSeen = new Set<string>();
    let model: string | undefined;
    // `task` tool parts across the WHOLE session (needed to join sub-agents
    // by output text, regardless of which message row the call happened in).
    const taskParts: OCPartData[] = [];

    for (const msgRow of messages ?? []) {
      const data = parseJson<OCMessageData>(msgRow.data);
      if (!data) continue; // malformed message row — skip defensively

      if (data.role === "user") {
        const createdIso = toIso(data.time?.created);
        if (createdIso) timestamps.push(createdIso);
        const textParts = (partsByMessage.get(msgRow.id) ?? []).filter((p) => p.type === "text" && p.text);
        const text = textParts
          .map((p) => p.text as string)
          .join("\n\n")
          .trim();
        if (text.length > 0) {
          const proseTurn: RawTurn = {
            idx: turns.length,
            role: "user",
            kind: "prose",
            text: redactSecrets(text),
            ts: createdIso ?? "",
          };
          // W3 — a pasted forge URL names a ref (source `paste`).
          const pasted = actionFromPastedText(text);
          if (pasted) proseTurn.action = pasted;
          turns.push(proseTurn);
        }
        continue;
      }

      if (data.role === "assistant") {
        if (data.modelID) {
          const s = data.providerID ? `${data.providerID}/${data.modelID}` : data.modelID;
          model = s;
          modelsSeen.add(s);
        }
        const createdIso = toIso(data.time?.created);
        if (createdIso) timestamps.push(createdIso);

        for (const part of partsByMessage.get(msgRow.id) ?? []) {
          if (part.type === "tool" && part.tool === "task") {
            // Only `task` tool_use parts are candidates for the sub-agent
            // join (2026-09-12 review, finding 10) — collecting every tool
            // part meant a `bash`/`grep` call whose output happened to
            // contain the literal text "task_id: <id>" (e.g. echoing back
            // another tool's output) could hijack a sub-agent's
            // toolUseId/description. `task` is the only tool that actually
            // spawns a session, so it's the only one that can legitimately
            // match.
            taskParts.push(part);
          }

          if (part.type === "text" || part.type === "reasoning") {
            if (!part.text) continue;
            const ts = toIso(part.time?.start) ?? createdIso ?? "";
            if (ts) timestamps.push(ts);
            turns.push({
              idx: turns.length,
              role: "assistant",
              kind: part.type === "text" ? "prose" : "thinking",
              text: redactSecrets(part.text),
              ts,
            });
          } else if (part.type === "tool") {
            const toolName = part.tool ?? "unknown";
            toolCounts[toolName] = (toolCounts[toolName] ?? 0) + 1;
            const ts = toIso(part.state?.time?.start) ?? createdIso ?? "";
            if (ts) timestamps.push(ts);

            let filePath: string | undefined;
            if (FILE_PATH_TOOLS.has(toolName)) {
              const fp = part.state?.input?.filePath;
              if (typeof fp === "string" && fp) {
                filePath = fp;
                filesTouchedSet.add(fp);
              }
            }

            const { mcpServer, mcpTool } = isLikelyMcpTool(toolName);

            const turn: RawTurn = {
              idx: turns.length,
              role: "assistant",
              kind: "tool_use",
              toolName,
              filePath,
              ts,
              toolUseId: part.callID,
              resultType: toolName === "edit" ? "update" : undefined,
              editHunks: toolName === "edit" ? countDiffHunks(part.state?.metadata?.diff) : undefined,
              mcpServer,
              mcpTool,
              inputDigest: buildInputDigest(INPUT_DIGEST_CONFIG, toolName, part.state?.input),
            };
            // W3 — opencode carries call and result in one part: derive the
            // forge action from `state.input.command` + `state.output` here.
            // The output text is parsed for fixed-shape facts only, never
            // stored (this parser emits no tool_result turn at all).
            // A pending/running part has no result yet; a completed or errored
            // one has returned even when it printed nothing.
            const status = part.state?.status;
            const returned = status === "completed" || status === "error";
            const exit = part.state?.metadata?.exit;
            const observed = {
              toolName,
              mcpTool,
              input: part.state?.input,
              result: returned ? (typeof part.state?.output === "string" ? part.state.output : "") : undefined,
              isError: status === "error" || (typeof exit === "number" && exit !== 0),
              // D-051 F1: the call's own working directory (a bash `workdir` input when the tool
              // recorded one, else the session's directory); a `cd` elsewhere is read off the command.
              cwd: callWorkdir(part.state?.input, session.directory),
            };
            const actions = deriveToolActions(observed);
            assignActions(turn, actions);
            if (returned) shaBackfill.observe(observed, actions);
            // R-5/R-3: see claude-code.ts — a git/gh/glab call that errored
            // with no derived action is proven to have done nothing; its
            // `inputDigest` is stale evidence, so clear it.
            if (
              actions.length === 0 &&
              observed.isError &&
              turn.inputDigest !== undefined &&
              toolName === "bash" &&
              typeof observed.input?.command === "string" &&
              FORGE_COMMAND.test(observed.input.command)
            ) {
              delete turn.inputDigest;
            }
            turns.push(turn);
          }
          // step-start/step-finish/patch/file/agent/subtask — ignored
          // defensively, see module doc comment.
        }
      }
      // Any other role — ignored defensively.
    }

    const startedAt =
      timestamps.length > 0 ? timestamps.reduce((a, b) => (a < b ? a : b)) : (toIso(session.timeCreated) ?? "");
    const endedAt =
      timestamps.length > 0 ? timestamps.reduce((a, b) => (a > b ? a : b)) : (toIso(session.timeUpdated) ?? "");

    const rawSubAgents = (subAgents ?? []).map((sub) => buildSubAgent(sub, taskParts));

    // Session-level model: prefer the last assistant message's model (real,
    // frequently populated) over the session row's own `model` column
    // (frequently null — see module doc comment), falling back to it only
    // when no assistant message carried one.
    if (!model) {
      model = modelStringFromRef(parseJson<OCModelRef>(session.modelRaw));
      if (model) modelsSeen.add(model);
    }

    return {
      source: "opencode",
      sourceSessionId: ref.sourceSessionId,
      contentHash,
      repo: { path: session.directory },
      startedAt,
      endedAt,
      model,
      turns,
      filesTouched: [...filesTouchedSet],
      toolCounts,
      usage: usageFromSessionRow(session),
      models: modelsSeen.size > 0 ? [...modelsSeen] : undefined,
      actionsVersion: FORGE_ACTIONS_VERSION,
      subAgents: rawSubAgents.length > 0 ? rawSubAgents : undefined,
      // A sub-agent session (the CLI now exports every descendant as its own
      // session): link it to its direct parent. toolUseId/description of the
      // spawning `task` call live on the PARENT's subAgents[] entry (joined
      // by agentId = this session's id) — this export only has the child's
      // own row, so the title stands in as the description.
      ...(session.parentId
        ? {
            parentSessionId: session.parentId,
            subAgent: {
              agentId: session.id,
              agentType: session.agent ?? undefined,
              description: session.title ? redactSecrets(session.title).slice(0, MAX_DIGEST_CHARS) : undefined,
              model,
            },
          }
        : {}),
    };
  },
};

/** D-051 N5: a bash call's `workdir` input (absolute, or relative to the session's directory), else the session's directory. */
function callWorkdir(input: unknown, directory: string | undefined): string | undefined {
  const base = directory || undefined;
  const w = input && typeof input === "object" ? (input as { workdir?: unknown }).workdir : undefined;
  if (typeof w !== "string" || !w.trim()) return base;
  if (w.startsWith("/")) return w;
  return base ? `${base.replace(/\/+$/, "")}/${w}` : undefined;
}
