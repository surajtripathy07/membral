// One minimal valid `arguments` object per MCP tool. The RPC-backed tools read
// the shared seed through the fake handlers in ./mcp-rpc-handlers.
// Tools registered only when MEMBRAL_MCP_EXTENDED_TOOLS=1 (W5 D8); mcp.test.ts turns the flag on for these.
export const EXTENDED_TOOLS = new Set(["get_code_project", "get_code_context_for"]);

export const TOOL_CALLS: Record<string, Record<string, unknown>> = {
  // OPENAI_API_KEY is empty in the golden env: these lock the no-key error path.
  search_conversations: { query: "login" },
  memory_search: { query: "login" },
  // Read session_memories / code_sessions through the fake directly.
  memory_recall: { repo: "acme/webapp" },
  // Unknown id: locks the not_found shape (no row read, nothing to leak).
  memory_get: { ids: ["00000000-0000-4000-8000-000000000000"] },
  // #436 write tool: an id that is no live blocker of the caller's gets the one generic error.
  memory_resolve: { id: "00000000-0000-4000-8000-000000000000", quote: "the deploy works again after the fix" },
  session_summary: { last: true, repo: "acme/webapp" },
  get_conversation: { id: "5eed0000-0000-4000-8000-000000000200" },
  // The default 7-day window ends before the seed's activity; widen it to cover every seeded row.
  list_recent_conversations: { since: "2025-12-01" },
  list_code_projects: {},
  get_code_project: { id: "5eed0000-0000-4000-8000-000000000001" },
  get_code_session: { id: "5eed0000-0000-4000-8000-000000000002" },
  get_code_context_for: { query: "login" },
};
