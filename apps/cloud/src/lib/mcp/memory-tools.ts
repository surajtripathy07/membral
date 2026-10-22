// Memory v1 read-tool registrations (docs/design/memory-v1.md §4, #152).
// Mirrors code-tools.ts's shape: this file registers, `lib/memory/*.ts` owns
// the logic. `memory_record` (the write tool) is #153's job -- NOT
// registered here. `memory_resolve` (#436) is the one write tool here: it only
// retires the key owner's own live blocker (lib/memory/agent-resolve.ts), and
// a code-scoped key only within its project. The route's per-key rate limit
// (app/api/mcp/route.ts) covers it like every other tool.
//
// SCOPING: same convention as the code tools (server.ts's call site gates
// this the same way it gates `registerCodeTools`) -- `codeScopeId` is the
// key's mandatory project bound, threaded straight into every tool call
// below and NEVER taken from the request body.

import { RECALL_RESULTS_CLAUSE } from "@membral/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import { getServiceClient } from "@/lib/db/clients";
import type { FreshnessPayload } from "@/lib/freshness";
import { formatFreshnessPrefix } from "@/lib/freshness";
import { isLocalRuntime } from "@/lib/llm/embedding-family";
import { MAX_RESOLVE_QUOTE_CHARS, MIN_RESOLVE_QUOTE_CHARS, resolveBlockerByAgent } from "@/lib/memory/agent-resolve";
import { packLines } from "@/lib/memory/raw-units/search/pack";
import { memoryRecallWithStats } from "@/lib/memory/recall";
import { logSearchRecall, memorySearch } from "@/lib/memory/search";
import { sessionSummary } from "@/lib/memory/summary";
import { fitToTokenBudget, MAX_MAX_TOKENS, MIN_MAX_TOKENS } from "@/lib/memory/token-budget";
import { resolveSessionId } from "./resolve-session-id";
import { compactServedRecords } from "./served-record-view";
import { MAX_SINCE_DAYS } from "./since";

type ToolResultFn = (fn: () => Promise<unknown>) => Promise<{
  content: { type: "text"; text: string }[];
  isError?: boolean;
  freshness: FreshnessPayload | null;
}>;
type GetFreshnessFn = () => Promise<FreshnessPayload | null>;

/** L2: what a served line means when records were hidden or merged. */
const REPLACED_CLAUSE =
  "Records a newer record replaced are hidden unless include_superseded is true or the query names a past date; paraphrases of one fact are served as one record with seen_in (the number of sessions that said it); every record carries as_of, the day its session recorded it (true when recorded, not current state). ";

/** Where a record's sources are, so an agent opens them instead of grepping. Shared by memory_search and memory_recall. */
export const RECORD_LINKS_CLAUSE =
  "Records carry links to their sources when known: sha (the commit the session was on), paths (files it names, up to 5), ref_url (the ref's forge page). Open them directly; they locate sources, they do not report current state. ";

/** I33 (docs/design/i33-port.md D7): the tool's default budget, measured on the lab surface (maintainer gate G4). */
export const SEARCH_DEFAULT_MAX_TOKENS = 3000;

const kindDescription = "One or more of: outcome, decision, learning, blocker, preference";

export function registerMemoryTools(
  server: McpServer,
  userId: string,
  codeScopeId: string | null,
  toolResult: ToolResultFn,
  getFreshnessCached: GetFreshnessFn,
): void {
  server.registerTool(
    "memory_search",
    {
      description:
        "Search past sessions' learnings, decisions, blockers and other memory records by TOPIC (Postgres full-text search fused with semantic similarity) -- the tool for 'what did we decide/learn about X'. Filter by kind, scope, project, path, or since/days. " +
        'A date phrase in the query ("last week", "yesterday", "Sept 20") is read as a time hint: it is taken out of the search text and records from that window rank higher, but older matches still come back (date_hint shows the reading); since/days are hard filters. Newer records win near-ties. ' +
        "since/days filter on the session's start time; each record's `when` is its session's end time (else start). " +
        "Covers extracted, quote-verified records (extraction runs on sessions within about 30 days of upload; older extracted records stay searchable); a fact that was said but never extracted is only in the raw turns (search_conversations). " +
        "When nothing is relevant enough, reason says why -- that is the answer, not an error. " +
        REPLACED_CLAUSE +
        `Local installs return \`served\`: lines (records as JSON, raw session excerpts marked "raw excerpt") packed whole to max_tokens (default ${SEARCH_DEFAULT_MAX_TOKENS}). ` +
        "Else (hosted; raw_reason says why) ranked `records` cut at max_tokens (dropped_for_budget). " +
        "A record's session_id is a code session: read the turns around it with get_code_session id=<session_id> turn=<turn_idx>, or session_summary session_id=<session_id>. " +
        RECORD_LINKS_CLAUSE +
        RECALL_RESULTS_CLAUSE,
      inputSchema: {
        query: z.string().describe("What to search for"),
        kind: z
          .union([z.string(), z.array(z.string())])
          .optional()
          .describe(kindDescription),
        scope: z
          .enum(["project", "global"])
          .optional()
          .describe(
            'Only records of this scope: "project" (about one repo, the default a record gets) or "global" (a rule or fact bigger than one repo). Omit for both.',
          ),
        project: z
          .string()
          .optional()
          .describe(
            'Repo remote URL, absolute path, or short repo name (e.g. "acme/payments" or "owner/repo", as the preamble names the current repo) to scope the search to one project',
          ),
        path: z.string().optional().describe("Only records whose paths[] includes this file"),
        recall_token: z
          .string()
          .optional()
          .describe(
            "The recall_token line from this session's Membral preamble, if you have one. Only logged to link this call to that preamble; it never changes the results.",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe("Max records to return, a whole number 1-20 (default 10)"),
        since: z
          .string()
          .optional()
          .describe(
            'Only records from sessions on or after this time (a hard filter). ISO date "2026-09-24" (00:00 UTC) or ISO datetime "2026-09-24T09:30:00Z". Wins over days.',
          ),
        days: z
          .number()
          .int()
          .min(1)
          .max(MAX_SINCE_DAYS)
          .optional()
          .describe(
            `Only records from sessions in the last N days, a whole number 1-${MAX_SINCE_DAYS} (a hard filter). Ignored when since is given.`,
          ),
        include_superseded: z
          .boolean()
          .optional()
          .describe(
            'Also return records a newer record replaced, each marked superseded_by {id, on}. Default false: replaced records are hidden. A past date phrase in the query ("as of Sept 20") also serves what was current then.',
          ),
        max_tokens: z
          .number()
          .int()
          .min(MIN_MAX_TOKENS)
          .max(MAX_MAX_TOKENS)
          .optional()
          .describe(
            `Token budget for the result, ${MIN_MAX_TOKENS}-${MAX_MAX_TOKENS} (default ${SEARCH_DEFAULT_MAX_TOKENS}). Served lines (records and raw excerpts) are packed whole, in order, estimated as characters / 4, and stop at the first line that does not fit. Without raw excerpts the ranked records fill it instead, and at least one is returned.`,
          ),
        // biome-ignore lint/suspicious/noExplicitAny: see file header
      } as any,
    },
    async (args: {
      query: string;
      kind?: string | string[];
      scope?: "project" | "global";
      project?: string;
      path?: string;
      recall_token?: string;
      limit?: number;
      since?: string;
      days?: number;
      include_superseded?: boolean;
      max_tokens?: number;
    }) =>
      toolResult(async () => {
        const supabase = getServiceClient();
        const { max_tokens, ...searchArgs } = args;
        // W3 behaviours on (floor, date hints); the recall event is logged here,
        // after the budget, so W2's influence numbers count only what was served.
        const result = await memorySearch(supabase, userId, codeScopeId, searchArgs, {
          floor: true,
          dateHints: true,
          logEvent: false,
          collapseByMeaning: true,
          raw: true,
        });
        const budget = max_tokens ?? SEARCH_DEFAULT_MAX_TOKENS;
        const { empty_reason, served, raw_reason, ...visible } = result;
        // I33 lines path: only where raw excerpts are searchable (local runtime) and the raw search ran clean.
        // Hosted, a non-nomic family or a raw failure keep today's records shape, with raw_reason saying why.
        if (isLocalRuntime() && !raw_reason && (served?.length ?? 0) > 0) {
          const packed = packLines(
            served.map((l) => l.text),
            budget,
          );
          const kept = served.slice(0, packed.lines.length);
          logSearchRecall(supabase, userId, {
            query: searchArgs.query,
            recordIds: kept.filter((l) => l.type !== "raw").flatMap((l) => l.members),
            recallToken: searchArgs.recall_token,
            emptyReason: empty_reason ?? null,
          });
          const { records: _ranked, ...visibleNoRecords } = visible;
          return {
            ...visibleNoRecords,
            served: packed.lines.join("\n"),
            served_tokens: packed.tokens,
            stale_blockers_hidden: result.stale_blockers_hidden ?? 0,
          };
        }
        const compact = await compactServedRecords(supabase, result.records, userId);
        const fitted = fitToTokenBudget(compact, budget);
        logSearchRecall(supabase, userId, {
          query: searchArgs.query,
          recordIds: fitted.records.map((r) => r.id),
          recallToken: searchArgs.recall_token,
          emptyReason: empty_reason ?? null,
        });
        return {
          ...visible,
          records: fitted.records,
          ...(raw_reason ? { raw_reason } : {}),
          // left_out_ids are ids of records the caller is allowed to see (they come from `compact`); the list is a
          // few dozen characters per id and is not counted in max_tokens, which budgets the records.
          ...(fitted.dropped > 0
            ? { dropped_for_budget: fitted.dropped, left_out_ids: fitted.skipped.map((r) => r.id) }
            : {}),
          stale_blockers_hidden: result.stale_blockers_hidden ?? 0,
        };
      }),
  );

  server.registerTool(
    "memory_recall",
    {
      description:
        "Recall memory records BY REPO OR PATH (not by topic -- use memory_search for that). 'outcome' alone answers 'what shipped here lately'. Ordered kind-priority then recency. " +
        "Read the turns around a record with get_code_session id=<session_id> turn=<turn_idx>. " +
        RECORD_LINKS_CLAUSE +
        "Replaced records are hidden and paraphrases of one fact are served once with seen_in; every record carries as_of.",
      inputSchema: {
        repo: z
          .string()
          .optional()
          .describe('Repo remote URL, absolute path, or short repo name (e.g. "acme/payments" or "owner/repo")'),
        scope: z
          .enum(["project", "global"])
          .optional()
          .describe(
            'Only records of this scope: "project" (about one repo, the default a record gets) or "global" (a rule or fact bigger than one repo). Omit for both.',
          ),
        kind: z
          .union([z.string(), z.array(z.string())])
          .optional()
          .describe(kindDescription),
        path: z.string().optional().describe("Only records whose paths[] includes this file"),
        recall_token: z
          .string()
          .optional()
          .describe(
            "The recall_token line from this session's Membral preamble, if you have one. Only logged to link this call to that preamble; it never changes the results.",
          ),
        durable_only: z
          .boolean()
          .optional()
          .describe("Default true -- session-scoped records never push, but can still be recalled with this off"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe("Max records to return, a whole number 1-20 (default 10)"),
        // biome-ignore lint/suspicious/noExplicitAny: see file header
      } as any,
    },
    async (args: {
      repo?: string;
      scope?: "project" | "global";
      kind?: string | string[];
      path?: string;
      recall_token?: string;
      durable_only?: boolean;
      limit?: number;
    }) =>
      toolResult(async () => {
        const supabase = getServiceClient();
        const { records, staleBlockersHidden } = await memoryRecallWithStats(supabase, userId, codeScopeId, args);
        const compact = await compactServedRecords(supabase, records, userId);
        // #436: blockers older than BLOCKER_FRESH_DAYS are hidden and counted.
        return { records: compact, stale_blockers_hidden: staleBlockersHidden };
      }),
  );

  server.registerTool(
    "memory_resolve",
    {
      description:
        "Mark a blocker as fixed. Call this right after you fix a blocker that Membral showed you (in the preamble, memory_search or memory_recall); " +
        "quote your own or the user's message text that states the fix (not tool output, which is not stored). " +
        "The blocker and its repeats are closed for every later session; the owner can restore it. " +
        "The quote is checked against this session's transcript when it uploads and kept as the receipt. " +
        "Only your own open blockers can be resolved.",
      inputSchema: {
        id: z.string().describe("The blocker record's id (the id field of a memory_search/memory_recall record)"),
        quote: z
          .string()
          .describe(
            `Verbatim text from your own or the user's message in this session that states the fix, not tool output (${MIN_RESOLVE_QUOTE_CHARS}-${MAX_RESOLVE_QUOTE_CHARS} characters)`,
          ),
        recall_token: z
          .string()
          .optional()
          .describe(
            "The recall_token line from this session's Membral preamble, if you have one. It links the resolution to this session so the quote can be checked.",
          ),
        // biome-ignore lint/suspicious/noExplicitAny: see file header
      } as any,
    },
    async (args: unknown) => toolResult(() => resolveBlockerByAgent(getServiceClient(), userId, codeScopeId, args)),
  );

  server.registerTool(
    "session_summary",
    {
      description:
        "Get one coding session's header (repo, branch, turns, models, files touched) and its JOURNEY: threads in order from the first prompt, each with its records (outcomes first) and files touched in that range. " +
        "Use it for the short story of a session (what it set out to do and what it found); use get_code_session when you need the actual turns, e.g. the exact words around a memory_search record. " +
        RECALL_RESULTS_CLAUSE,
      inputSchema: {
        session_id: z
          .string()
          .optional()
          .describe("A specific code_sessions id; a unique prefix of ≥ 8 chars also works"),
        last: z.boolean().optional().describe("The most recent session (optionally narrowed by repo)"),
        repo: z
          .string()
          .optional()
          .describe(
            'Repo remote URL, absolute path, or short repo name (e.g. "acme/payments" or "owner/repo"), narrows `last`',
          ),
        recall_token: z
          .string()
          .optional()
          .describe(
            "The recall_token line from this session's Membral preamble, if you have one. Only logged to link this call to that preamble; it never changes the results.",
          ),
        // biome-ignore lint/suspicious/noExplicitAny: see file header
      } as any,
    },
    async ({
      session_id,
      last,
      repo,
      recall_token,
    }: {
      session_id?: string;
      last?: boolean;
      repo?: string;
      recall_token?: string;
    }) => {
      const db = getServiceClient();
      // A short id (`session abcd1234` in a recall line) resolves to the full id, user- and scope-bound.
      const resolved = session_id ? await resolveSessionId(db, userId, session_id, codeScopeId) : null;
      if (resolved && !resolved.ok) {
        const freshness = await getFreshnessCached();
        const text = resolved.reason === "ambiguous" ? resolved.message : "Session not found";
        return {
          content: [{ type: "text" as const, text: `${formatFreshnessPrefix(freshness)}${text}` }],
          isError: true,
          freshness,
        };
      }
      const [data, freshness] = await Promise.all([
        sessionSummary(db, userId, codeScopeId, {
          session_id: resolved?.ok ? resolved.id : session_id,
          last,
          repo,
          recall_token,
        }),
        getFreshnessCached(),
      ]);
      // e2e C-10: `last` with nothing to return is an empty answer, not an
      // error -- a new user (or a repo with no sessions yet) is a normal state.
      // An explicit session_id that doesn't resolve is still an error.
      if (!data && !session_id && last) {
        const empty = {
          session: null,
          message: repo ? `No coding sessions recorded yet for "${repo}".` : "No coding sessions recorded yet.",
        };
        return {
          content: [{ type: "text" as const, text: formatFreshnessPrefix(freshness) + JSON.stringify(empty) }],
          freshness,
        };
      }
      if (!data) {
        return {
          content: [{ type: "text" as const, text: `${formatFreshnessPrefix(freshness)}Session not found` }],
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
