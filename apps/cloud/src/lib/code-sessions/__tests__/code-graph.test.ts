// Stage-1 deterministic extractor tests (ADR 0023 Q1/Q2/Q4, ADR 0026 P2a).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FakeSupabase } from "@membral/test-kit";
import { describe, expect, it } from "vitest";
import { buildCodeGraphForProject, buildCodeGraphForUser } from "../code-graph";
import { importCodeSession } from "../import";
import type { RawCodeSessionPayload } from "../payload";

const USER_ID = "user-1";
const REPO = { path: "/home/dev/acme-webapp", remoteUrl: "https://github.com/acme/webapp.git", branch: "main" };

function makeSession(overrides: Partial<RawCodeSessionPayload> = {}): RawCodeSessionPayload {
  return {
    source: "claude-code",
    sourceSessionId: "session-default",
    contentHash: "hash-default",
    repo: REPO,
    startedAt: "2026-07-01T10:00:00.000Z",
    endedAt: "2026-07-01T10:05:00.000Z",
    model: "codehub-model-1",
    turns: [{ idx: 0, role: "user", kind: "prose", text: "Do the work", ts: "2026-07-01T10:00:00.000Z" }],
    filesTouched: [],
    toolCounts: {},
    ...overrides,
  };
}

async function seedProject(db: FakeSupabase, sessions: RawCodeSessionPayload[]): Promise<string> {
  let codeProjectId = "";
  for (const s of sessions) {
    const res = await importCodeSession(db.asClient(), USER_ID, s);
    expect(res.status).toBe("imported");
    codeProjectId = res.codeProjectId as string;
  }
  return codeProjectId;
}

describe("code-graph.ts — makes ZERO LLM calls (ADR 0023 Q4 cost bound)", () => {
  it("the module's source never references an LLM client", () => {
    const src = readFileSync(join(__dirname, "..", "code-graph.ts"), "utf8");
    expect(src).not.toMatch(/LlmClient/);
    expect(src).not.toMatch(/openai/i);
    expect(src).not.toMatch(/chat\.completions/);
  });

  it("buildCodeGraphForProject succeeds with no LLM client constructed anywhere in the call", async () => {
    const db = new FakeSupabase();
    const codeProjectId = await seedProject(db, [makeSession({ sourceSessionId: "s1" })]);
    // buildCodeGraphForProject's signature takes only (supabase, userId, codeProjectId) —
    // there is no LLM parameter to pass, structurally proving the zero-cost claim.
    const result = await buildCodeGraphForProject(db.asClient(), USER_ID, codeProjectId);
    expect(result.nodesWritten).toBeGreaterThan(0);
  });
});

describe("code-graph.ts — File node recurrence (golden assertion)", () => {
  it("a file touched in N sessions -> one File node with session_count=N and N TOUCHED edges", async () => {
    const db = new FakeSupabase();
    const sessions = [1, 2, 3].map((i) =>
      makeSession({
        sourceSessionId: `s${i}`,
        contentHash: `hash-${i}`,
        startedAt: `2026-07-0${i}T10:00:00.000Z`,
        endedAt: `2026-07-0${i}T10:05:00.000Z`,
        turns: [
          { idx: 0, role: "user", kind: "prose", text: "Edit the file", ts: `2026-07-0${i}T10:00:00.000Z` },
          {
            idx: 1,
            role: "assistant",
            kind: "tool_use",
            toolName: "Edit",
            filePath: "/home/dev/acme-webapp/src/app.ts",
            toolUseId: `toolu_edit_${i}`,
            resultType: "update",
            editHunks: 2,
            ts: `2026-07-0${i}T10:01:00.000Z`,
          },
        ],
        filesTouched: ["/home/dev/acme-webapp/src/app.ts"],
        toolCounts: { Edit: 1 },
      }),
    );
    const codeProjectId = await seedProject(db, sessions);

    const result = await buildCodeGraphForProject(db.asClient(), USER_ID, codeProjectId);
    expect(result.nodeCountsByType.file).toBe(1);

    const fileNodes = db.getRows("code_kg_nodes").filter((n) => n.node_type === "file");
    expect(fileNodes).toHaveLength(1);
    expect(fileNodes[0].key).toBe("src/app.ts"); // canonicalized repo-relative
    expect(fileNodes[0].session_count).toBe(3);

    const touchedEdges = db
      .getRows("code_kg_edges")
      .filter((e) => e.rel_type === "touched" && e.dst_node_id === fileNodes[0].id);
    expect(touchedEdges).toHaveLength(3);
    for (const e of touchedEdges) {
      expect(e.weight).toBe(2); // editHunks
      expect((e.props as Record<string, unknown>).edit_count).toBe(2);
      expect((e.props as Record<string, unknown>).created).toBe(false); // resultType: 'update'
    }
  });
});

describe("code-graph.ts — created-vs-edited from toolUseResult.type, never the tool name (D1)", () => {
  it("Write with resultType 'create' -> props.created=true; Write with resultType 'update' -> false, not guessed from the tool name", async () => {
    const db = new FakeSupabase();
    const sessions = [
      makeSession({
        sourceSessionId: "s-create",
        contentHash: "h-create",
        turns: [
          { idx: 0, role: "user", kind: "prose", text: "go", ts: "2026-07-01T10:00:00.000Z" },
          {
            idx: 1,
            role: "assistant",
            kind: "tool_use",
            toolName: "Write",
            filePath: "/home/dev/acme-webapp/src/new.ts",
            toolUseId: "toolu_write_new",
            resultType: "create",
            ts: "2026-07-01T10:01:00.000Z",
          },
        ],
        filesTouched: ["/home/dev/acme-webapp/src/new.ts"],
        toolCounts: { Write: 1 },
      }),
      makeSession({
        sourceSessionId: "s-overwrite",
        contentHash: "h-overwrite",
        turns: [
          { idx: 0, role: "user", kind: "prose", text: "go", ts: "2026-07-02T10:00:00.000Z" },
          {
            idx: 1,
            role: "assistant",
            kind: "tool_use",
            toolName: "Write",
            filePath: "/home/dev/acme-webapp/src/existing.ts",
            toolUseId: "toolu_write_existing",
            resultType: "update", // ADR 0026 D1: measured 5.3% of real Write calls overwrite, not create
            ts: "2026-07-02T10:01:00.000Z",
          },
        ],
        filesTouched: ["/home/dev/acme-webapp/src/existing.ts"],
        toolCounts: { Write: 1 },
      }),
      makeSession({
        sourceSessionId: "s-unknown",
        contentHash: "h-unknown",
        turns: [
          { idx: 0, role: "user", kind: "prose", text: "go", ts: "2026-07-03T10:00:00.000Z" },
          {
            idx: 1,
            role: "assistant",
            kind: "tool_use",
            toolName: "Write",
            filePath: "/home/dev/acme-webapp/src/no-result-info.ts",
            toolUseId: "toolu_write_noinfo",
            // no resultType at all — simulates a backfilled row from before this parser extension.
            ts: "2026-07-03T10:01:00.000Z",
          },
        ],
        filesTouched: ["/home/dev/acme-webapp/src/no-result-info.ts"],
        toolCounts: { Write: 1 },
      }),
    ];
    const codeProjectId = await seedProject(db, sessions);
    await buildCodeGraphForProject(db.asClient(), USER_ID, codeProjectId);

    const edges = db.getRows("code_kg_edges").filter((e) => e.rel_type === "touched");
    const nodes = db.getRows("code_kg_nodes").filter((n) => n.node_type === "file");
    const nodeById = Object.fromEntries(nodes.map((n) => [n.id, n]));

    const byFileKey = Object.fromEntries(
      edges.map((e) => [nodeById[e.dst_node_id as string].key, e.props as Record<string, unknown>]),
    );
    expect(byFileKey["src/new.ts"].created).toBe(true);
    expect(byFileKey["src/existing.ts"].created).toBe(false);
    // Never guessed from the tool name (D1) — no structured signal means no claim either way.
    expect(byFileKey["src/no-result-info.ts"].created).toBeUndefined();
  });
});

describe("code-graph.ts — Tool node keyed on MCP attribution when present (D2)", () => {
  it("keys an MCP tool_use on (server, tool), dedupes the raw name into props.raw_name", async () => {
    const db = new FakeSupabase();
    const codeProjectId = await seedProject(db, [
      makeSession({
        sourceSessionId: "s-mcp",
        turns: [
          { idx: 0, role: "user", kind: "prose", text: "screenshot", ts: "2026-07-01T10:00:00.000Z" },
          {
            idx: 1,
            role: "assistant",
            kind: "tool_use",
            toolName: "mcp__codehub-browser__computer",
            toolUseId: "toolu_mcp1",
            mcpServer: "codehub-browser",
            mcpTool: "computer",
            ts: "2026-07-01T10:01:00.000Z",
          },
        ],
        toolCounts: { "mcp__codehub-browser__computer": 1 },
      }),
    ]);
    await buildCodeGraphForProject(db.asClient(), USER_ID, codeProjectId);

    const toolNodes = db.getRows("code_kg_nodes").filter((n) => n.node_type === "tool");
    expect(toolNodes).toHaveLength(1);
    expect(toolNodes[0].key).toBe("codehub-browser:computer");
    expect((toolNodes[0].props as Record<string, unknown>).raw_name).toBe("mcp__codehub-browser__computer");
  });

  it("USED edge weight is the per-session call count", async () => {
    const db = new FakeSupabase();
    const codeProjectId = await seedProject(db, [
      makeSession({
        sourceSessionId: "s-bash",
        turns: [
          { idx: 0, role: "user", kind: "prose", text: "run tests thrice", ts: "2026-07-01T10:00:00.000Z" },
          {
            idx: 1,
            role: "assistant",
            kind: "tool_use",
            toolName: "Bash",
            toolUseId: "b1",
            ts: "2026-07-01T10:01:00.000Z",
          },
          {
            idx: 2,
            role: "assistant",
            kind: "tool_use",
            toolName: "Bash",
            toolUseId: "b2",
            ts: "2026-07-01T10:02:00.000Z",
          },
          {
            idx: 3,
            role: "assistant",
            kind: "tool_use",
            toolName: "Bash",
            toolUseId: "b3",
            ts: "2026-07-01T10:03:00.000Z",
          },
        ],
        toolCounts: { Bash: 3 },
      }),
    ]);
    await buildCodeGraphForProject(db.asClient(), USER_ID, codeProjectId);

    const usedEdges = db.getRows("code_kg_edges").filter((e) => e.rel_type === "used");
    expect(usedEdges).toHaveLength(1);
    expect(usedEdges[0].weight).toBe(3);
  });
});

describe("code-graph.ts — SubAgent nodes + SPAWNED edges (D3)", () => {
  it("creates a SubAgent node per non-fork spawn, with model/tokens on both node and edge props", async () => {
    const db = new FakeSupabase();
    const codeProjectId = await seedProject(db, [
      makeSession({
        sourceSessionId: "s-subagents",
        subAgents: [
          {
            agentId: "agent-1",
            toolUseId: "toolu_agent1",
            agentType: "general-purpose",
            description: "Investigate the flaky test",
            spawnDepth: 1,
            model: "codehub-model-2",
            usage: { inputTokens: 300, outputTokens: 120, cacheReadInputTokens: 9000, cacheCreationInputTokens: 50 },
          },
          {
            agentId: "agent-1-fork",
            isFork: true, // D3: forks inherit the parent's context, never a distinct node
            agentType: "fork",
          },
        ],
      }),
    ]);
    await buildCodeGraphForProject(db.asClient(), USER_ID, codeProjectId);

    const subAgentNodes = db.getRows("code_kg_nodes").filter((n) => n.node_type === "subagent");
    expect(subAgentNodes).toHaveLength(1); // the isFork spawn is filtered out
    expect(subAgentNodes[0].key).toBe("agent-1");
    expect((subAgentNodes[0].props as Record<string, unknown>).model).toBe("codehub-model-2");
    expect((subAgentNodes[0].props as Record<string, unknown>).tokens).toEqual({
      inputTokens: 300,
      outputTokens: 120,
      cacheReadInputTokens: 9000,
      cacheCreationInputTokens: 50,
    });

    const spawnedEdges = db.getRows("code_kg_edges").filter((e) => e.rel_type === "spawned");
    expect(spawnedEdges).toHaveLength(1);
    expect((spawnedEdges[0].props as Record<string, unknown>).model).toBe("codehub-model-2");
  });

  it("two sessions listing the SAME sub-agent (a resumed transcript) upsert one node, not a duplicate-key batch", async () => {
    const db = new FakeSupabase();
    const shared = { agentId: "agent-shared", agentType: "general-purpose", description: "Survey the repo" };
    const codeProjectId = await seedProject(db, [
      makeSession({ sourceSessionId: "s-original", contentHash: "h-a", subAgents: [shared] }),
      makeSession({ sourceSessionId: "s-resumed", contentHash: "h-b", subAgents: [shared] }),
    ]);
    const result = await buildCodeGraphForProject(db.asClient(), USER_ID, codeProjectId);
    expect(result.error).toBeUndefined();

    const subAgentNodes = db.getRows("code_kg_nodes").filter((n) => n.node_type === "subagent");
    expect(subAgentNodes).toHaveLength(1);
    expect(subAgentNodes[0].session_count).toBe(2);
    const spawned = db.getRows("code_kg_edges").filter((e) => e.rel_type === "spawned");
    expect(spawned).toHaveLength(2); // one per spawning session, both pointing at the one node
    expect(new Set(spawned.map((e) => e.dst_node_id))).toEqual(new Set([subAgentNodes[0].id]));
    expect(result.nodeCountsByType.subagent).toBe(1);
  });

  it("is sparse (zero SubAgent nodes) when the session predates the parser extension — no crash", async () => {
    const db = new FakeSupabase();
    const codeProjectId = await seedProject(db, [makeSession({ sourceSessionId: "s-plain" })]);
    const result = await buildCodeGraphForProject(db.asClient(), USER_ID, codeProjectId);
    expect(result.nodeCountsByType.subagent).toBeUndefined();
  });
});

describe("code-graph.ts — session run-metadata props (usage/models/est_cost_usd)", () => {
  it("copies usage/models onto the session mirror node and computes a cost object with provenance (D5)", async () => {
    const db = new FakeSupabase();
    const codeProjectId = await seedProject(db, [
      makeSession({
        sourceSessionId: "s-usage",
        usage: {
          inputTokens: 1_000_000,
          outputTokens: 500_000,
          cacheReadInputTokens: 2_000_000,
          cacheCreationInputTokens: 100_000,
        },
        models: ["codehub-model-1", "codehub-model-2"],
      }),
    ]);
    await buildCodeGraphForProject(db.asClient(), USER_ID, codeProjectId);

    const sessionNode = db.getRows("code_kg_nodes").find((n) => n.node_type === "session");
    expect(sessionNode).toBeDefined();
    const props = sessionNode?.props as Record<string, unknown>;
    expect(props.models).toEqual(["codehub-model-1", "codehub-model-2"]);
    expect(props.usage).toEqual({
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      cacheReadInputTokens: 2_000_000,
      cacheCreationInputTokens: 100_000,
    });
    const cost = props.est_cost_usd as Record<string, unknown>;
    expect(cost.currency).toBe("USD");
    expect(cost.source).toBe("inferred"); // never provider-emitted — costUSD does not exist (D5)
    expect(typeof cost.price_table_version).toBe("string");
    expect(cost.amount as number).toBeGreaterThan(0);
  });

  it("leaves usage/models/est_cost_usd off the session node when the source never supplied usage", async () => {
    const db = new FakeSupabase();
    const codeProjectId = await seedProject(db, [makeSession({ sourceSessionId: "s-no-usage" })]);
    await buildCodeGraphForProject(db.asClient(), USER_ID, codeProjectId);
    const sessionNode = db.getRows("code_kg_nodes").find((n) => n.node_type === "session");
    const props = sessionNode?.props as Record<string, unknown>;
    expect(props.usage).toBeUndefined();
    expect(props.est_cost_usd).toBeUndefined();
  });
});

describe("code-graph.ts — idempotent wholesale regen (ADR 0023 Q4)", () => {
  it("re-running buildCodeGraphForProject produces the same counts, not accumulating duplicates", async () => {
    const db = new FakeSupabase();
    const codeProjectId = await seedProject(db, [
      makeSession({ sourceSessionId: "s1" }),
      makeSession({
        sourceSessionId: "s2",
        contentHash: "hash-s2",
        turns: [
          { idx: 0, role: "user", kind: "prose", text: "go", ts: "2026-07-02T10:00:00.000Z" },
          {
            idx: 1,
            role: "assistant",
            kind: "tool_use",
            toolName: "Edit",
            filePath: "/home/dev/acme-webapp/src/app.ts",
            toolUseId: "toolu_e2",
            resultType: "update",
            ts: "2026-07-02T10:01:00.000Z",
          },
        ],
        filesTouched: ["/home/dev/acme-webapp/src/app.ts"],
        toolCounts: { Edit: 1 },
      }),
    ]);

    const first = await buildCodeGraphForProject(db.asClient(), USER_ID, codeProjectId);
    const second = await buildCodeGraphForProject(db.asClient(), USER_ID, codeProjectId);

    expect(second.nodesWritten).toBe(first.nodesWritten);
    expect(second.edgesWritten).toBe(first.edgesWritten);
    expect(db.getRows("code_kg_nodes")).toHaveLength(first.nodesWritten);
    expect(db.getRows("code_kg_edges")).toHaveLength(first.edgesWritten);
  });
});

describe("code-graph.ts — pagination past the PostgREST 1000-row default cap", () => {
  it("counts recurrence correctly when a project has >1000 tool_use turns (regression guard)", async () => {
    const db = new FakeSupabase();
    // Enough sessions x turns to blow well past the 1000-row default page —
    // every session touches the SAME file, so an unpaginated read that
    // silently truncates would under-count session_count.
    const sessions = Array.from({ length: 15 }, (_, i) =>
      makeSession({
        sourceSessionId: `s${i}`,
        contentHash: `hash-${i}`,
        turns: [
          { idx: 0, role: "user", kind: "prose", text: "go", ts: "2026-07-01T10:00:00.000Z" },
          ...Array.from({ length: 100 }, (_, j) => ({
            idx: j + 1,
            role: "assistant" as const,
            kind: "tool_use" as const,
            toolName: "Bash",
            toolUseId: `s${i}-b${j}`,
            ts: "2026-07-01T10:01:00.000Z",
          })),
          {
            idx: 101,
            role: "assistant" as const,
            kind: "tool_use" as const,
            toolName: "Edit",
            filePath: "/home/dev/acme-webapp/src/app.ts",
            toolUseId: `s${i}-edit`,
            resultType: "update" as const,
            ts: "2026-07-01T10:02:00.000Z",
          },
        ],
        filesTouched: ["/home/dev/acme-webapp/src/app.ts"],
        toolCounts: { Bash: 100, Edit: 1 },
      }),
    );
    const codeProjectId = await seedProject(db, sessions);
    expect(db.getRows("code_session_turns").length).toBeGreaterThan(1000);

    await buildCodeGraphForProject(db.asClient(), USER_ID, codeProjectId);

    const fileNode = db.getRows("code_kg_nodes").find((n) => n.node_type === "file");
    expect(fileNode?.session_count).toBe(15); // every session touched it — must not be truncated to <15
    const touchedEdges = db.getRows("code_kg_edges").filter((e) => e.rel_type === "touched");
    expect(touchedEdges).toHaveLength(15);
  });
});

describe("code-graph.ts — buildCodeGraphForUser", () => {
  it("builds the graph for every project the user has", async () => {
    const db = new FakeSupabase();
    await seedProject(db, [makeSession({ sourceSessionId: "s1", repo: REPO })]);
    await seedProject(db, [
      makeSession({
        sourceSessionId: "s2",
        contentHash: "hash-other",
        repo: { remoteUrl: "https://github.com/acme/other-repo.git" },
      }),
    ]);

    const results = await buildCodeGraphForUser(db.asClient(), USER_ID);
    expect(results).toHaveLength(2);
    expect(db.getRows("code_kg_nodes").filter((n) => n.node_type === "project")).toHaveLength(2);
  });
});

// --- adversarial verify (commit d753f7c) follow-up fixes --------------------

/** Wraps a FakeSupabase client so the FIRST `code_kg_nodes.upsert(...)` chunk
 * targeting `failForProjectId` fails with a simulated transient error — every
 * other table/project passes through untouched. */
function withFailingNodeUpsert(db: FakeSupabase, failForProjectId: string) {
  let armed = true;
  return {
    from: (t: string) => {
      const b = db.from(t);
      if (t === "code_kg_nodes" && armed) {
        const origUpsert = b.upsert.bind(b);
        b.upsert = ((rows: Record<string, unknown>[]) => {
          const first = Array.isArray(rows) ? rows[0] : rows;
          if (first?.code_project_id === failForProjectId) {
            armed = false;
            return {
              select: () => ({
                // Mimics supabase-js's thenable query builder, same as fake-supabase.ts's own `then` — a test double, not application code.
                // biome-ignore lint/suspicious/noThenProperty: see comment above
                then: (resolve: (v: unknown) => unknown) =>
                  Promise.resolve(resolve({ data: null, error: { message: "simulated 500" } })),
              }),
            };
          }
          return origUpsert(rows);
        }) as typeof b.upsert;
      }
      return b;
    },
  } as unknown as Parameters<typeof buildCodeGraphForUser>[0];
}

describe("code-graph.ts — F2: per-project failure containment", () => {
  it("one project's upsert failure does not empty its graph, and does not abort the other projects' rebuild", async () => {
    const db = new FakeSupabase();
    const okProjectId = await seedProject(db, [makeSession({ sourceSessionId: "s-ok", repo: REPO })]);
    const failProjectId = await seedProject(db, [
      makeSession({
        sourceSessionId: "s-fail",
        contentHash: "hash-fail",
        repo: { remoteUrl: "https://github.com/acme/fails.git" },
      }),
    ]);

    // Healthy baseline build for both projects.
    await buildCodeGraphForUser(db.asClient(), USER_ID);
    const nodesBefore = db.getRows("code_kg_nodes").filter((n) => n.code_project_id === failProjectId).length;
    expect(nodesBefore).toBeGreaterThan(0);

    // Regen where the failing project's node upsert errors out.
    const results = await buildCodeGraphForUser(withFailingNodeUpsert(db, failProjectId), USER_ID);

    expect(results).toHaveLength(2);
    const failResult = results.find((r) => r.codeProjectId === failProjectId);
    const okResult = results.find((r) => r.codeProjectId === okProjectId);
    expect(failResult?.error).toBeDefined();
    expect(okResult?.error).toBeUndefined();
    expect(okResult?.nodesWritten).toBeGreaterThan(0);

    // The failing project's graph is NOT empty — nothing was deleted because
    // nothing was successfully upserted first (F2's insert/upsert-before-
    // delete ordering).
    const nodesAfter = db.getRows("code_kg_nodes").filter((n) => n.code_project_id === failProjectId).length;
    expect(nodesAfter).toBe(nodesBefore);

    // The OTHER project (unaffected by the injected failure) still got
    // rebuilt — the whole run was not aborted.
    expect(db.getRows("code_kg_nodes").filter((n) => n.code_project_id === okProjectId).length).toBeGreaterThan(0);
  });
});

describe("code-graph.ts — F3: concurrent rebuilds of the same project are single-flighted", () => {
  it("two overlapping buildCodeGraphForProject calls for the same project do the work once, not twice", async () => {
    const db = new FakeSupabase();
    const codeProjectId = await seedProject(db, [makeSession({ sourceSessionId: "s1" })]);
    const client = db.asClient();

    const [a, b] = await Promise.all([
      buildCodeGraphForProject(client, USER_ID, codeProjectId),
      buildCodeGraphForProject(client, USER_ID, codeProjectId),
    ]);

    // Both callers joined the same in-flight build — same result object.
    expect(a).toBe(b);
    // No duplicated project mirror node from a racing second build.
    expect(db.getRows("code_kg_nodes").filter((n) => n.node_type === "project")).toHaveLength(1);
  });
});

describe("code-graph.ts — F9: node ids are stable across rebuilds (ADR 0023 Q4 content-addressed mirrors)", () => {
  it("re-running buildCodeGraphForProject preserves every node's id when its (type, key) content is unchanged", async () => {
    const db = new FakeSupabase();
    const codeProjectId = await seedProject(db, [
      makeSession({
        sourceSessionId: "s1",
        turns: [
          { idx: 0, role: "user", kind: "prose", text: "go", ts: "2026-07-01T10:00:00.000Z" },
          {
            idx: 1,
            role: "assistant",
            kind: "tool_use",
            toolName: "Edit",
            filePath: "/home/dev/acme-webapp/src/app.ts",
            toolUseId: "toolu_1",
            resultType: "update",
            ts: "2026-07-01T10:01:00.000Z",
          },
        ],
        filesTouched: ["/home/dev/acme-webapp/src/app.ts"],
        toolCounts: { Edit: 1 },
      }),
    ]);

    await buildCodeGraphForProject(db.asClient(), USER_ID, codeProjectId);
    const first = db
      .getRows("code_kg_nodes")
      .map((n) => ({ id: n.id, type: n.node_type, key: n.key }))
      .sort((x, y) => `${x.type}:${x.key}`.localeCompare(`${y.type}:${y.key}`));

    await buildCodeGraphForProject(db.asClient(), USER_ID, codeProjectId);
    const second = db
      .getRows("code_kg_nodes")
      .map((n) => ({ id: n.id, type: n.node_type, key: n.key }))
      .sort((x, y) => `${x.type}:${x.key}`.localeCompare(`${y.type}:${y.key}`));

    expect(second).toEqual(first); // ids identical, not just content
  });
});

describe("code-graph.ts — F6: code_sessions.files_touched is a fallback File-node source (ADR 0023 Q1/Q4 D13)", () => {
  it("a session with filesTouched but no per-turn file_path still yields File nodes, weight 1, edit_count 0", async () => {
    const db = new FakeSupabase();
    const codeProjectId = await seedProject(db, [
      makeSession({
        sourceSessionId: "s-files-only",
        filesTouched: ["/home/dev/acme-webapp/src/a.ts", "/home/dev/acme-webapp/src/b.ts"],
        toolCounts: { Edit: 2 },
        turns: [{ idx: 0, role: "user", kind: "prose", text: "go", ts: "2026-07-01T10:00:00.000Z" }],
      }),
    ]);

    const result = await buildCodeGraphForProject(db.asClient(), USER_ID, codeProjectId);
    expect(result.nodeCountsByType.file).toBe(2);

    const fileNodes = db.getRows("code_kg_nodes").filter((n) => n.node_type === "file");
    const keys = fileNodes.map((n) => n.key).sort();
    expect(keys).toEqual(["src/a.ts", "src/b.ts"]);

    const touchedEdges = db.getRows("code_kg_edges").filter((e) => e.rel_type === "touched");
    expect(touchedEdges).toHaveLength(2);
    for (const e of touchedEdges) {
      expect(e.weight).toBe(1); // F13: touch happened but no edit data — clamped to 1, not 0
      expect((e.props as Record<string, unknown>).edit_count).toBe(0);
    }
  });

  it("a file present in BOTH files_touched and a turn's file_path is a single node with the turn's edit data", async () => {
    const db = new FakeSupabase();
    const codeProjectId = await seedProject(db, [
      makeSession({
        sourceSessionId: "s-both",
        filesTouched: ["/home/dev/acme-webapp/src/app.ts"],
        toolCounts: { Edit: 1 },
        turns: [
          { idx: 0, role: "user", kind: "prose", text: "go", ts: "2026-07-01T10:00:00.000Z" },
          {
            idx: 1,
            role: "assistant",
            kind: "tool_use",
            toolName: "Edit",
            filePath: "/home/dev/acme-webapp/src/app.ts",
            toolUseId: "toolu_1",
            resultType: "update",
            editHunks: 3,
            ts: "2026-07-01T10:01:00.000Z",
          },
        ],
      }),
    ]);

    const result = await buildCodeGraphForProject(db.asClient(), USER_ID, codeProjectId);
    expect(result.nodeCountsByType.file).toBe(1); // not double-counted

    const touchedEdges = db.getRows("code_kg_edges").filter((e) => e.rel_type === "touched");
    expect(touchedEdges).toHaveLength(1);
    expect(touchedEdges[0].weight).toBe(3); // the turn's editHunks, not the files_touched-seeded 0
    expect((touchedEdges[0].props as Record<string, unknown>).edit_count).toBe(3);
  });
});
