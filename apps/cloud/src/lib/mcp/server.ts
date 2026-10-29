import { RECALL_RESULTS_CLAUSE, RECALL_VS_STATE_LINES, RECALL_VS_STATE_NEUTRAL_LINES } from "@membral/core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import { getServiceClient } from "@/lib/db/clients";
import { mcpExtendedToolsEnabled } from "@/lib/env";
import type { FreshnessPayload } from "@/lib/freshness";
import { formatFreshnessCompactValue, formatFreshnessPrefix, getFreshnessForUser } from "@/lib/freshness";
import { getCodeContextFor, getCodeProject, getCodeSession, listCodeProjects } from "@/lib/mcp/code-tools";
import {
  CODE_SESSION_SOURCES,
  getScopedConversation,
  listRecentConversations,
  type RecentKind,
  searchConversationsScoped,
  UnknownScopeError,
} from "@/lib/mcp/graph-tools";
import { registerMemoryTools } from "@/lib/mcp/memory-tools";
import { handoffViewBudget, loadNotInHandoffSection } from "@/lib/mcp/not-in-handoff-view";
import { omitToolIO } from "@/lib/mcp/omit-tool-io";
import { paginateCodeSession, windowCodeSession } from "@/lib/mcp/paginate-code-session";
import { clampMaxChars, paginateConversation } from "@/lib/mcp/paginate-conversation";
import { resolveSessionId } from "@/lib/mcp/resolve-session-id";
import { MAX_SINCE_DAYS, resolveSince } from "@/lib/mcp/since";
import { instrumentServer, type McpTelemetryOptions } from "@/lib/mcp/telemetry";
import { CHAT_SOURCES } from "@/lib/sync-validator";

/** `toolResult` builder bound to one server instance's cached freshness (see `getFreshnessCached` in createCloudMcpServer). */
type ToolResultFn = (fn: () => Promise<unknown>) => Promise<{
  content: { type: "text"; text: string }[];
  isError?: boolean;
  freshness: FreshnessPayload | null;
}>;

/** Per-server-instance freshness getter — computed once, reused by every tool call on this server (see the header comment on createCloudMcpServer). */
type GetFreshnessFn = () => Promise<FreshnessPayload | null>;

// biome-ignore lint/suspicious/noExplicitAny: app zod v4 instances do not match the SDK-bundled zod types; a typed cast breaks handler arg inference
const scopeShape = { scope: z.string().optional().describe("A LifeArea id or label to narrow the result to") } as any;

// Recency bound (since/days), parsed by resolveSince in mcp/since.ts;
// invalid input comes back as isError text.
const SINCE_DESCRIPTION =
  'Only results from this time on. ISO date "2026-09-24" (read as 00:00 UTC that day) or ISO datetime "2026-09-24T09:30:00Z" (no offset = UTC). For "yesterday" pass yesterday\'s date. Wins over days.';
const DAYS_DESCRIPTION = `Only results from the last N days, a whole number 1-${MAX_SINCE_DAYS} (e.g. 1 = the last 24 hours). Ignored when since is given.`;

const RECENT_SOURCE_LIST = [...CHAT_SOURCES, ...CODE_SESSION_SOURCES].sort();

/** Short server-level guidance hosts show the model (MCP `instructions`), limited to the tools this key gets. */
function serverInstructions(chatAllowed: boolean, codeAllowed: boolean): string {
  const open = [
    chatAllowed ? "a chat with get_conversation" : null,
    codeAllowed ? "a coding session with get_code_session" : null,
  ]
    .filter(Boolean)
    .join(" and ");
  // The recall-vs-state rule (@membral/core agent-guidance.ts) leads; the
  // practical lines below it name only the tools this key gets.
  return [
    ...(codeAllowed ? RECALL_VS_STATE_LINES : RECALL_VS_STATE_NEUTRAL_LINES),
    "To find a recent chat or coding session, call list_recent_conversations (kind, days or since, source), then open " +
      `${open} by id.`,
    "To find one by topic within a time window, call search_conversations with query and since/days.",
    "Long results come in parts: call again with start = next_start until next_start is null.",
  ]
    .filter((line) => chatAllowed || !line.startsWith("To find one by topic"))
    .join("\n");
}

/**
 * @param userId       server-verified user (never client-supplied).
 * @param tokenScopeId the API key's AREA bound (issue #83): null = not
 *   area-scoped, else a LifeArea node id that bounds every chat read. Injected
 *   from the validated key by the /api/mcp route — NEVER from a request body.
 * @param codeScopeId  the API key's CODE-PROJECT bound (ADR 0021 Q7): null =
 *   not code-project-scoped, else a code_projects.id that bounds every code
 *   read. Also injected from the key, never the body.
 *
 * A key is area-scoped XOR code-project-scoped XOR unscoped (the single-scope
 * model, enforced by profiles_api_key_single_scope). This maps to three tool
 * surfaces:
 *   - code-project-scoped (codeScopeId set): ONLY the four code tools, each
 *     bound to that project. NO chat tools, NO global identity/portrait — the
 *     shared surface is deliberately empty so a code-scoped key can never read
 *     the chat graph.
 *   - unscoped (both null): the chat tools (exactly as before) PLUS the code
 *     tools (full access to every code project).
 *   - area-scoped (tokenScopeId set): the chat tools ONLY, byte-identical to
 *     #83 — no code tools are registered, so #83 behaviour is unchanged.
 *
 * @param telemetry    api key id + `after()` for the mcp_tool_calls row every
 *   tool call writes (lib/mcp/telemetry.ts). Omitted: rows still go to the DB.
 */
export function createCloudMcpServer(
  userId: string,
  tokenScopeId: string | null = null,
  codeScopeId: string | null = null,
  telemetry: McpTelemetryOptions = {},
): McpServer {
  const server = new McpServer(
    {
      name: "membral-cloud",
      version: "0.2.0",
    },
    { instructions: serverInstructions(codeScopeId === null, codeScopeId !== null || tokenScopeId === null) },
  );
  // Before any register*: every tool registered on this server is timed and
  // recorded to mcp_tool_calls (lib/mcp/telemetry.ts).
  instrumentServer(server, userId, telemetry);

  // Freshness (goal 2026-07-26 step 2, #63/#58 silent-breakage class):
  // computed ONCE per server instance (a server is created fresh per HTTP
  // request in app/api/mcp/route.ts) and cached in this closure so every
  // tool call on this request reuses the same computation + generated_at,
  // rather than re-querying sync_heartbeats/conversations/code_* per tool.
  //
  // Round-3 adversarial review MINOR 1: this used to be
  // `getFreshness(getServiceClient(), userId).catch(() => null)` — but
  // getServiceClient() throws SYNCHRONOUSLY on missing env vars while still
  // being evaluated as an ARGUMENT to getFreshness(...), so that throw
  // happens before getFreshness is even called and escapes the trailing
  // `.catch()` entirely (the exact MAJOR 3 class already fixed in
  // freshness.ts's getFreshnessForUser). Using getFreshnessForUser here
  // reuses that same already-hardened wrapper instead of re-introducing the
  // bug locally.
  let freshnessPromise: Promise<FreshnessPayload | null> | null = null;
  const getFreshnessCached: GetFreshnessFn = () => {
    if (!freshnessPromise) {
      freshnessPromise = getFreshnessForUser(userId).catch(() => null);
    }
    return freshnessPromise;
  };

  /**
   * Every graph-tool handler shares this shape: JSON result on success,
   * isError text on failure (incl. UnknownScopeError) — plus this server
   * instance's cached freshness stamp on every response.
   *
   * BLOCKER 1 fix (adversarial review): the stamp must live INSIDE
   * `content[0].text` — hosts hand the model only content blocks, not
   * protocol-level sibling fields (proven via SDK round-trip), so a
   * top-level `freshness` key alone is inert. The success path folds it
   * into the JSON payload as `{ freshness, data }` (freshness first, so it
   * renders at the top of the text a model reads) — NESTED rather than
   * spread, deliberately: several of these tools return a JSON ARRAY
   * (search_conversations, ...), and
   * `{ freshness, ...data }` silently corrupts an array into numeric-keyed
   * object properties. Nesting keeps one uniform, always-valid shape across
   * every tool regardless of whether its own payload is an array or an
   * object. The embedded `freshness` value itself is the COMPACT one-line
   * string form (formatFreshnessCompactValue), not the full FreshnessPayload
   * object — the full object pretty-printed at 2-space indent ran ~15 lines
   * on every single tool call (NOTE fix, round-2 adversarial review); the
   * top-level `freshness` sibling field below still carries the full object
   * for a caller that wants it. The error path isn't JSON at all, so it
   * gets the same PREFIX-line treatment as the manually-handled tools below
   * (formatFreshnessPrefix — see that function's docstring for why prefix,
   * not suffix: MINOR 5 fix, round-2 review). ONE convention across every
   * plain-text path in this file: the stamp always LEADS the text.
   */
  const toolResult: ToolResultFn = async (fn) => {
    const freshness = await getFreshnessCached();
    try {
      const data = await fn();
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ freshness: formatFreshnessCompactValue(freshness), data }),
          },
        ],
        freshness,
      };
    } catch (err) {
      const message = err instanceof UnknownScopeError ? err.message : err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: formatFreshnessPrefix(freshness) + message }],
        isError: true,
        freshness,
      };
    }
  };

  // A code-project-scoped key gets ONLY the code tools; the entire chat surface
  // (and the global portrait it exposes) is suppressed. Any other key (unscoped
  // or area-scoped) keeps the chat tools exactly as before #83+P1e.
  if (codeScopeId === null) {
    registerChatTools(server, userId, tokenScopeId, toolResult, getFreshnessCached);
  }

  // Code tools are available to an unscoped key (codeScopeId null -> all
  // projects) and to a code-project-scoped key (bound to the one project).
  // An AREA-scoped key gets NEITHER — its surface is chat-only, byte-identical
  // to #83.
  // list_recent_conversations: every key gets it; what it may list (chats,
  // code sessions, or both) follows the same key scope as the tools above —
  // enforced in listRecentConversations and again in SQL.
  registerRecentTool(server, userId, tokenScopeId, codeScopeId, toolResult);

  if (codeScopeId !== null || tokenScopeId === null) {
    registerCodeTools(server, userId, codeScopeId, toolResult, getFreshnessCached);
    // Memory v1 (#152): the three read tools live on the same surface as the
    // code tools, gated the SAME way -- a code-project-scoped key gets its
    // memories bounded to that one project; an area-scoped key gets neither
    // (memory is a code-session concept, ADR 0021 Q2's "no LifeArea
    // membership" applies here too).
    registerMemoryTools(server, userId, codeScopeId, toolResult, getFreshnessCached);
  }

  return server;
}

function registerChatTools(
  server: McpServer,
  userId: string,
  tokenScopeId: string | null,
  toolResult: ToolResultFn,
  getFreshnessCached: GetFreshnessFn,
): void {
  server.registerTool(
    "search_conversations",
    {
      description: `Search the user's synced conversations AND coding-agent sessions by keyword and semantic similarity — results are tagged source_type (chat/code) and, when a matching chunk exists, resolve to the specific message span inside the conversation rather than just its title. To find a chat or session from a specific time, pass since (or days): e.g. yesterday's chat about X → query = X, since = yesterday's date. To browse recent activity with no query, use list_recent_conversations.${tokenScopeId === null ? ` Hits are raw text as said, not extracted, checked or versioned: true when said, not current truth; for decisions, learnings and outcomes use memory_search. ${RECALL_RESULTS_CLAUSE}` : ""}`,
      inputSchema: {
        query: z.string().describe("Search query"),
        ...scopeShape,
        since: z
          .string()
          .optional()
          .describe(
            `${SINCE_DESCRIPTION} Chats count by last update, coding sessions by end time. Omit for no time bound.`,
          ),
        days: z
          .number()
          .int()
          .min(1)
          .max(MAX_SINCE_DAYS)
          .optional()
          .describe(`${DAYS_DESCRIPTION} Omit (and omit since) for no time bound.`),
        limit: z.number().int().min(1).max(50).optional().describe("Max results to return (default 10)"),
        // biome-ignore lint/suspicious/noExplicitAny: app zod v4 instances do not match the SDK-bundled zod types; a typed cast breaks handler arg inference
      } as any,
    },
    async ({
      query,
      scope,
      limit,
      since,
      days,
    }: {
      query: string;
      scope?: string;
      limit?: number;
      since?: string;
      days?: number;
    }) =>
      toolResult(() => {
        // Bad since/days -> resolveSince throws a clear message -> isError text.
        const sinceIso = resolveSince({ since, days });
        // includeCode: tokenScopeId === null (goal 2026-07-26 step 10) — an AREA-scoped key must
        // never see code-session hits through the chat search surface.
        return searchConversationsScoped(
          getServiceClient(),
          userId,
          query,
          scope,
          limit,
          tokenScopeId,
          tokenScopeId === null,
          sinceIso,
        );
      }),
  );

  server.registerTool(
    "get_conversation",
    {
      description:
        "Retrieve a specific conversation by ID with its messages. Long conversations come in parts: each call returns whole messages from `start` up to about `max_chars` of content (default 60000), plus total_messages, total_chars, returned {start, end (exclusive)} and next_start. When next_start is not null, call get_conversation again with the same id and start=next_start until next_start is null to read the whole conversation. Tool calls/results are replaced by short stubs by default (see include_tool_io) so tool-heavy chats don't overflow the part budget.",
      inputSchema: {
        id: z.string().describe("Conversation ID"),
        start: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            "Index of the first message to return (default 0). Pass the previous call's next_start to continue.",
          ),
        max_chars: z
          .number()
          .optional()
          .describe(
            "Approximate content budget for this part, in characters (default 60000, clamped to 5000–200000). A single message larger than this is returned alone, cut, and marked truncated.",
          ),
        include_tool_io: z
          .boolean()
          .optional()
          .describe(
            "Include full tool call inputs and tool result outputs (default false). By default, tool calls/results are replaced by short stubs (e.g. web-search results), since they can be tens of thousands of characters and push a conversation past the part budget; set true to see them in full.",
          ),
        // biome-ignore lint/suspicious/noExplicitAny: app zod v4 instances do not match the SDK-bundled zod types; a typed cast breaks handler arg inference
      } as any,
    },
    async ({
      id,
      start,
      max_chars,
      include_tool_io,
    }: {
      id: string;
      start?: number;
      max_chars?: number;
      include_tool_io?: boolean;
    }) => {
      // Scoping is enforced in SQL (mcp_scoped_conversation) from the token
      // bound — a direct id for an out-of-scope conversation returns null and
      // is reported as a plain "not found" (404-equivalent, no existence leak).
      const [data, freshness] = await Promise.all([
        getScopedConversation(getServiceClient(), userId, id, tokenScopeId),
        getFreshnessCached(),
      ]);

      if (!data) {
        // A (2026-09-25): the id may be a coding session, not a chat -- an
        // unscoped key also has code-session access (registerCodeTools' gate
        // in createCloudMcpServer is `codeScopeId !== null || tokenScopeId
        // === null`; get_conversation only exists when codeScopeId is null,
        // so tokenScopeId === null is exactly "this key also gets the code
        // tools"). Try get_code_session's own lookup (codeScopeId null --
        // unscoped is unbounded across projects here too) before reporting
        // not-found, so the agent never needs a second call to discover which
        // tool an id belongs to. An area-scoped key (tokenScopeId set) has no
        // code-session access at all -- skip straight to not-found for it,
        // same as today.
        if (tokenScopeId === null) {
          const codeData = await getCodeSession(getServiceClient(), userId, id, null);
          if (codeData) {
            const part = paginateCodeSession(codeData as unknown as Record<string, unknown>, {
              start,
              maxChars: max_chars,
            });
            const note = `${part.note ? `${part.note}\n` : ""}Note: "${id}" is a coding session, not a chat -- returned via get_code_session.\n`;
            return {
              content: [
                {
                  type: "text" as const,
                  text: formatFreshnessPrefix(freshness) + note + JSON.stringify(part.data),
                },
              ],
              freshness,
            };
          }
        }
        return {
          content: [
            {
              type: "text" as const,
              text: formatFreshnessPrefix(freshness) + `Conversation not found: ${id}`,
            },
          ],
          isError: true,
          freshness,
        };
      }

      // Tool I/O is stubbed BEFORE pagination (not after) so paging sizes
      // messages by their shrunk content — a message that was mostly a
      // 40k-char tool result no longer eats the whole part budget on its own.
      const source = data as unknown as Record<string, unknown>;
      const { data: shrunk, omittedChars } = include_tool_io ? { data: source, omittedChars: 0 } : omitToolIO(source);

      // Paginate here, in the tool layer only: MCP hosts cap tool output
      // (Claude Code: 25,000 tokens by default), so a long chat is returned
      // in parts with a one-line note telling the model how to continue.
      const part = paginateConversation(shrunk, { start, maxChars: max_chars });
      if (omittedChars > 0) part.data.tool_io_omitted_chars = omittedChars;
      const note = part.note ? `${part.note}\n` : "";
      return {
        content: [
          {
            type: "text" as const,
            text: formatFreshnessPrefix(freshness) + note + JSON.stringify(part.data),
          },
        ],
        freshness,
      };
    },
  );
}

/**
 * list_recent_conversations (migration 094): recent chats and main coding
 * sessions, newest first, metadata only. Registered for every key; the key's
 * bounds decide which kinds come back (see listRecentConversations).
 */
function registerRecentTool(
  server: McpServer,
  userId: string,
  tokenScopeId: string | null,
  codeScopeId: string | null,
  toolResult: ToolResultFn,
): void {
  server.registerTool(
    "list_recent_conversations",
    {
      description: `List the user's recent sessions — chats AND coding sessions (Claude Code, opencode, Copilot CLI, Codex; main sessions, not sub-agents) — from the last few days by default, newest first, metadata only. Chat rows (type "chat"): id, title, source, created_at, updated_at, message_count. Code rows (type "code"): id, project_name, git_branch, source, started_at, ended_at, turn_count, summary (up to 200 chars). Defaults to the last 7 days and both kinds. Use it to find something by when it happened (e.g. yesterday's chat → since = yesterday's date, kind = chat), then open a chat with get_conversation id=<id> or a coding session with get_code_session id=<id>; both return long results in parts.${codeScopeId !== null || tokenScopeId === null ? ` ${RECALL_RESULTS_CLAUSE}` : ""}`,
      inputSchema: {
        kind: z
          .enum(["chat", "code", "all"])
          .optional()
          .describe(
            'Which rows to list: "chat", "code" (coding sessions) or "all" (default). E.g. "code" for yesterday\'s coding session.',
          ),
        since: z.string().optional().describe(SINCE_DESCRIPTION),
        days: z.number().int().min(1).max(MAX_SINCE_DAYS).optional().describe(`${DAYS_DESCRIPTION} Default 7.`),
        source: z
          .string()
          .optional()
          .describe(
            `Only rows from this source: one of ${RECENT_SOURCE_LIST.join(", ")}. Chat sources filter chats, code sources (claude-code, opencode, copilot-cli, codex) filter coding sessions. E.g. "chatgpt".`,
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Max rows to return across both kinds, a whole number 1-100 (default 30). E.g. 10."),
        // biome-ignore lint/suspicious/noExplicitAny: app zod v4 instances do not match the SDK-bundled zod types; a typed cast breaks handler arg inference
      } as any,
    },
    async ({
      kind,
      since,
      days,
      source,
      limit,
    }: {
      kind?: RecentKind;
      since?: string;
      days?: number;
      source?: string;
      limit?: number;
    }) =>
      toolResult(() => {
        // resolveSince throws a clear message on bad input; toolResult turns it
        // into isError text. since wins over days; default window is 7 days.
        const sinceIso = resolveSince({ since, days: days ?? 7 });
        if (source !== undefined && !RECENT_SOURCE_LIST.includes(source)) {
          throw new Error(`Invalid source: "${source}". Use one of ${RECENT_SOURCE_LIST.join(", ")}.`);
        }
        return listRecentConversations(
          getServiceClient(),
          userId,
          { since: sinceIso, source, limit, kind },
          { tokenScopeId, codeScopeId },
        );
      }),
  );
}

/**
 * Register the code-dimension tools (ADR 0021 Q7/Q8). `codeScopeId` is the
 * per-key code-project bound injected by the route (null = unscoped -> every
 * project). It is passed straight through to the migration-030 RPCs, where the
 * scope is enforced in SQL (fail-closed on a stale id) — a client-supplied
 * project/session id can only ever resolve WITHIN the bound.
 */
function registerCodeTools(
  server: McpServer,
  userId: string,
  codeScopeId: string | null,
  toolResult: ToolResultFn,
  getFreshnessCached: GetFreshnessFn,
): void {
  server.registerTool(
    "list_code_projects",
    {
      description:
        "List the user's coding-agent projects (repos worked on via Claude Code etc.) with a rollup summary, session count, and last-active time",
    },
    async () => toolResult(() => listCodeProjects(getServiceClient(), userId, codeScopeId)),
  );

  if (mcpExtendedToolsEnabled()) {
    server.registerTool(
      "get_code_project",
      {
        description:
          "Get one code project by ID: its cross-session rollup (what was built, key decisions, recurring files/tools, people, open threads) and a recent-session timeline",
        inputSchema: {
          id: z.string().describe("Code project ID"),
          // biome-ignore lint/suspicious/noExplicitAny: app zod v4 instances do not match the SDK-bundled zod types; a typed cast breaks handler arg inference
        } as any,
      },
      async ({ id }: { id: string }) => {
        // Scoping is enforced in SQL (code_project_detail) from the key bound — a
        // direct id for an out-of-scope project returns null and is reported as a
        // plain "not found" (404-equivalent, no existence leak).
        const [data, freshness] = await Promise.all([
          getCodeProject(getServiceClient(), userId, id, codeScopeId),
          getFreshnessCached(),
        ]);
        if (!data) {
          return {
            content: [
              { type: "text" as const, text: formatFreshnessPrefix(freshness) + `Code project not found: ${id}` },
            ],
            isError: true,
            freshness,
          };
        }
        return {
          content: [{ type: "text" as const, text: formatFreshnessPrefix(freshness) + JSON.stringify(data) }],
          freshness,
        };
      },
    );
  }

  server.registerTool(
    "get_code_session",
    {
      description:
        "Retrieve a specific coding session by ID (a memory_search record's session_id, a list_recent_conversations code row's id): its user-spine turns (what the human asked/decided/corrected), files touched, and per-session summary. To read the turns around a record, pass its session_id as id and its turn_idx as turn: you get only turns turn-window..turn+window (window default 8, max 40; max_chars default 12000 here) with focus {turn, window, first_idx, last_idx, total_turns}; prev_start/next_start, passed as start (without turn), read the turns before/after; start reads forward from there with the default 60000 chars. Whole-session paging below is the fallback. Long sessions come in parts: each call returns the session metadata and summary plus whole turns from `start` up to about `max_chars` of turn text (default 60000), with total_turns, total_chars, returned {start, end (exclusive)} and next_start. files_touched is on the first part only (up to 200 paths; files_touched_total and files_touched_omitted give the rest's count). When next_start is not null, call get_code_session again with the same id and start=next_start until next_start is null to read every turn. The first part also lists sub_agents: the sub-agent sessions this session spawned (id, agent_type, description, started_at, ended_at, turn_count, brief = first 160 chars of the task it was given; at most 200, sub_agents_total gives the full count); open one with get_code_session id=<its id>. When this session is itself a sub-agent, parent_session_id is the id of the session that spawned it. Use it to read what was actually said; use session_summary for a short threaded overview of the same session. " +
        RECALL_RESULTS_CLAUSE,
      inputSchema: {
        id: z.string().describe("Code session ID; a unique prefix of ≥ 8 chars also works"),
        start: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            "Index of the first turn to return (default 0). Pass the previous call's next_start to continue. Ignored when turn is given (turn wins over start).",
          ),
        max_chars: z
          .number()
          .optional()
          .describe(
            "Approximate turn-text budget for this part, in characters (default 60000, or 12000 with turn; clamped to 5000–200000). A single turn larger than this is returned alone, cut, and marked truncated.",
          ),
        turn: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            "Open the session at this turn (a memory_search record's turn_idx): only the turns within ±window of it are returned. Omit to page the whole session from start.",
          ),
        window: z
          .number()
          .int()
          .optional()
          .describe("With turn: how many turns either side to return (default 8, clamped to 1–40)."),
        // biome-ignore lint/suspicious/noExplicitAny: app zod v4 instances do not match the SDK-bundled zod types; a typed cast breaks handler arg inference
      } as any,
    },
    async ({
      id,
      start,
      max_chars,
      turn,
      window,
    }: {
      id: string;
      start?: number;
      max_chars?: number;
      turn?: number;
      window?: number;
    }) => {
      // Scoping (incl. the cross-project guard: a session must belong to the
      // bound project) is enforced in SQL (code_session_detail); out-of-scope
      // returns null -> plain "not found" (404-equivalent, no existence leak).
      const db = getServiceClient();
      const [resolved, freshness] = await Promise.all([
        resolveSessionId(db, userId, id, codeScopeId),
        getFreshnessCached(),
      ]);
      if (!resolved.ok && resolved.reason === "ambiguous") {
        return {
          content: [{ type: "text" as const, text: formatFreshnessPrefix(freshness) + resolved.message }],
          isError: true,
          freshness,
        };
      }
      const data = resolved.ok ? await getCodeSession(db, userId, resolved.id, codeScopeId) : null;
      if (!data) {
        return {
          content: [
            { type: "text" as const, text: formatFreshnessPrefix(freshness) + `Code session not found: ${id}` },
          ],
          isError: true,
          freshness,
        };
      }
      // Paginate here, in the tool layer only (same reason as get_conversation):
      // a long session's turns come in parts with a one-line continue note.
      // With `turn`: only the turns around it (a cited record's source), not the session from `start`.
      const part =
        typeof turn === "number"
          ? windowCodeSession(data as unknown as Record<string, unknown>, { turn, window, maxChars: max_chars })
          : paginateCodeSession(data as unknown as Record<string, unknown>, { start, maxChars: max_chars });
      // Box 2.4 (design section 6): first part of a whole-session read: the live handoff note and the records it does not cover.
      if (typeof turn !== "number" && (part.data.returned as { start: number } | undefined)?.start === 0) {
        const gaps = await loadNotInHandoffSection(
          db,
          userId,
          resolved.ok ? resolved.id : id,
          handoffViewBudget(clampMaxChars(max_chars)),
        );
        if (gaps) Object.assign(part.data, gaps);
      }
      const note = part.note ? `${part.note}\n` : "";
      return {
        content: [{ type: "text" as const, text: formatFreshnessPrefix(freshness) + note + JSON.stringify(part.data) }],
        freshness,
      };
    },
  );

  if (mcpExtendedToolsEnabled()) {
    server.registerTool(
      "get_code_context_for",
      {
        description:
          "Get a compact context block for a query across the user's coding projects: matching project rollups, recent session summaries, and matching user-spine turns",
        inputSchema: {
          query: z.string().describe("Query to build code context for"),
          // biome-ignore lint/suspicious/noExplicitAny: app zod v4 instances do not match the SDK-bundled zod types; a typed cast breaks handler arg inference
        } as any,
      },
      async ({ query }: { query: string }) =>
        toolResult(() => getCodeContextFor(getServiceClient(), userId, query, codeScopeId)),
    );
  }
}
