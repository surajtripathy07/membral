import { RECALL_RESULTS_CLAUSE, RECALL_VS_STATE_LINES } from "@membral/core";
// What a calling agent actually sees: tools/list and the server-level
// instructions, read over a real MCP client/server round trip.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";

vi.mock("@supabase/supabase-js", () => ({ createClient: vi.fn(() => ({ from: vi.fn() })) }));

import { createCloudMcpServer } from "../server";

async function connect(tokenScopeId: string | null = null, codeScopeId: string | null = null) {
  const server = createCloudMcpServer("user-123", tokenScopeId, codeScopeId);
  const client = new Client({ name: "test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  // biome-ignore lint/suspicious/noExplicitAny: JSON Schema properties are untyped here
  const props = (name: string) => (byName[name].inputSchema.properties ?? {}) as Record<string, any>;
  return { client, byName, props };
}

describe("MCP tool details visible to agents", () => {
  it("list_recent_conversations exposes its tool description and the kind enum", async () => {
    const { byName, props } = await connect();
    expect(byName.list_recent_conversations.description).toContain("chats AND coding sessions");
    expect(byName.list_recent_conversations.description).toContain("get_code_session id=<id>");
    const p = props("list_recent_conversations");
    expect(Object.keys(p).sort()).toEqual(["days", "kind", "limit", "since", "source"]);
    expect(p.kind.enum).toEqual(["chat", "code", "all"]);
  });

  // Tool search often defers MCP tools behind their names alone (the model
  // reads only the first sentence before deciding to load one) — the two
  // phrases a "recent sessions"/"last few days" prompt is likely to echo
  // must be in list_recent_conversations' FIRST sentence, not buried later.
  it("list_recent_conversations' first sentence names recent sessions and the last few days", async () => {
    const { byName } = await connect();
    const firstSentence = byName.list_recent_conversations.description!.split(". ")[0];
    expect(firstSentence).toContain("recent sessions");
    expect(firstSentence).toContain("last few days");
  });

  it("server instructions lead with the shared recall-vs-state rule, then the practical lines", async () => {
    const unscoped = await connect();
    const text = unscoped.client.getInstructions() ?? "";
    expect(text.startsWith(RECALL_VS_STATE_LINES.join("\n"))).toBe(true);
    expect(text).toContain("It is not live state.");
    expect(text).toContain("call list_recent_conversations");

    // An area-scoped key never gets memory_search (registerMemoryTools is
    // gated the same way registerCodeTools is) — the instructions must not
    // dangle a tool name this key can't call.
    const areaScoped = (await connect("area-bound")).client.getInstructions() ?? "";
    expect(areaScoped).toContain("true when recorded");
    expect(areaScoped).toContain("The user's own instructions win");
    expect(areaScoped).not.toContain("memory_search");
    for (const banned of ["PR", "project", "!123", "coding sessions"]) {
      expect(areaScoped, banned).not.toContain(banned);
    }
  });

  it("chat-only keys do not get the code-flavoured results clause on chat tools", async () => {
    const chatOnly = await connect("area-bound");
    for (const name of ["search_conversations", "list_recent_conversations"]) {
      expect(chatOnly.byName[name]?.description, name).not.toContain(RECALL_RESULTS_CLAUSE);
    }
    const full = await connect();
    for (const name of ["search_conversations", "list_recent_conversations"]) {
      expect(full.byName[name]?.description, name).toContain(RECALL_RESULTS_CLAUSE);
    }
  });

  it("every recall tool says its results are dated records, not current PR/issue state", async () => {
    const { byName } = await connect();
    for (const name of [
      "memory_search",
      "search_conversations",
      "list_recent_conversations",
      "get_code_session",
      "session_summary",
    ]) {
      expect(byName[name]?.description, name).toContain(RECALL_RESULTS_CLAUSE);
    }
  });

  // Regression guard: apps/cloud and the MCP SDK/openai used to resolve
  // separate physical zod copies (app zod 4.3.6 vs the SDK's own zod 3.25.76
  // "v4" build), so `.describe()` text and `.min()/.max()` checks were lost
  // in conversion and tools/list showed bare {type} per param (see the
  // now-fixed root package.json `overrides.zod`, which collapses the whole
  // workspace onto one zod 4.x install). This asserts descriptions AND
  // bounds actually reach tools/list.
  it("per-param descriptions and bounds reach tools/list", async () => {
    const { props } = await connect();
    const p = props("list_recent_conversations");
    expect(p.kind.description).toContain('"all" (default)');
    expect(p.since.description).toContain('ISO date "2026-09-24"');
    expect(p.since.description).toContain("yesterday's date");
    expect(p.days.description).toContain("1-365");
    expect(p.days.maximum).toBe(365);
    expect(p.source.description).toContain("chatgpt, claude, claude-code, codex, copilot-cli, grok, opencode");
    expect(p.limit.description).toContain("default 30");
    for (const tool of ["get_conversation", "get_code_session"]) {
      expect(props(tool).start.description).toContain("next_start");
      expect(props(tool).max_chars.description).toContain("default 60000");
    }
    const search = props("search_conversations");
    expect(search.query.description).toContain("Search query");
    expect(search.limit.description).toContain("default 10");
    expect(search.limit.minimum).toBe(1);
    expect(search.limit.maximum).toBe(50);
    expect(search.since.description).toContain("yesterday's date");
    expect(search.days.maximum).toBe(365);
  });

  it("EVERY param of EVERY registered tool carries a non-empty description, on every key surface", async () => {
    const missing: string[] = [];
    let checked = 0;
    for (const [area, code] of [
      [null, null],
      ["area-bound", null],
      [null, "code-bound"],
    ] as const) {
      const { byName } = await connect(area, code);
      for (const [name, tool] of Object.entries(byName)) {
        // biome-ignore lint/suspicious/noExplicitAny: JSON Schema properties are untyped here
        for (const [param, schema] of Object.entries((tool.inputSchema.properties ?? {}) as Record<string, any>)) {
          checked++;
          if (typeof schema.description !== "string" || schema.description.trim() === "") {
            missing.push(`${name}.${param}`);
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(20);
    expect([...new Set(missing)]).toEqual([]);
  });

  it("get_code_session takes turn and window, and its description says how to open a record's turn, within 2,048 chars", async () => {
    const { byName, props } = await connect();
    const description = byName.get_code_session.description!;
    expect(description.length).toBeLessThan(2_048);
    expect(description).toContain("turn_idx as turn");
    expect(description).toContain("window default 8");
    expect(description).toContain("Whole-session paging below is the fallback");
    const p = props("get_code_session");
    expect(p.turn.minimum).toBe(0);
    expect(p.window.description).toContain("default 8");
    expect(p.max_chars.description).toContain("12000 with turn");
  });

  it("server instructions point at list_recent_conversations and paging, limited to the key's tools", async () => {
    const unscoped = await connect();
    const text = unscoped.client.getInstructions() ?? "";
    expect(text).toContain("list_recent_conversations");
    expect(text).toContain("get_conversation");
    expect(text).toContain("get_code_session");
    expect(text).toContain("next_start");

    const codeScoped = (await connect(null, "code-bound")).client.getInstructions() ?? "";
    expect(codeScoped).toContain("get_code_session");
    expect(codeScoped).not.toContain("get_conversation");
    expect(codeScoped).not.toContain("search_conversations");

    const areaScoped = (await connect("area-bound")).client.getInstructions() ?? "";
    expect(areaScoped).toContain("get_conversation");
    expect(areaScoped).not.toContain("get_code_session");
  });
});
