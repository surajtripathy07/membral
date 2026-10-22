// The make-or-break isolation proof for ADR 0021 Q2, EXTENDED for ADR 0023
// Q3 (the code-session KNOWLEDGE GRAPH, code_kg_nodes/code_kg_edges):
// code-session imports AND the Stage-1 code-graph build must NEVER touch
// kg_edges, and must never WRITE kg_nodes (the conversation graph). Two
// checks:
//
// 1. STATIC GATE — nothing under lib/code-sessions/ (which now includes
//    code-graph.ts, ADR 0023's Stage-1 extractor) or the
//    /api/code-sessions*/route.ts routes imports GraphWriter or references
//    kg_edges at all, and nothing WRITES kg_nodes. Grep-fail, not a runtime
//    mock: this catches a future regression even if nobody adds a test
//    exercising it. listTsFiles() scans the whole directory, so code-graph.ts
//    (and any future lib/code-sessions/ module) is covered automatically —
//    no per-file registration needed for this gate to apply to it.
//
//    HISTORY: cross-links.ts and queries.ts used to carry a P1c/P1d
//    exception here — cross-links.ts matched CodeProjects against
//    Item/LifeArea/Person kg_nodes (a NAME-overlap signal) and resolved its
//    content-match signal through a kg_nodes-type='Conversation' row, and
//    queries.ts joined kg_nodes to render cross-link labels. Migration 084
//    (memory v1, docs/design/memory-v1.md §5) retargeted
//    code_cross_links.kg_node_id to conversation_id and cross-links.ts's
//    content signal onto conversations.embedding directly — neither file
//    references kg_nodes at all anymore, so KG_NODES_READ_ALLOWED below is
//    now empty and this gate treats them like every other file.
//
// 2. BYTE-IDENTICAL PROOF — seed a user's kg_nodes/kg_edges, snapshot a hash
//    of every row, run a full multi-session/multi-repo import (and, in later
//    blocks, the full P1c synthesis pass — summarize -> rollup -> cross-links
//    -> Stage-1 code-graph build, ADR 0023 P2a's own test-plan item 1),
//    re-snapshot, assert the hash is unchanged. Structural, not statistical
//    (stronger and cheaper than an A/B corpus comparison). code_kg_nodes/
//    code_kg_edges are DEDICATED tables (migration 031) — this proof shows
//    that building them never touches a single kg_nodes/kg_edges row.

import { FakeSupabase } from "@membral/test-kit";
import { createHash } from "crypto";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { describe, expect, it, vi } from "vitest";
import { LlmClient, type OpenAILike } from "../../llm/client";
import type { ModelConfig } from "../../llm/config";
import { buildCodeGraphForUser } from "../code-graph";
import { importCodeSession } from "../import";
import type { RawCodeSessionPayload } from "../payload";
import { synthesizeCodeDimension } from "../synthesize";

// The P1c synthesize proof below exercises the REAL cross-links.ts content
// signal (migration 084 retargeted it onto conversations.embedding — see
// cross-links.ts's HISTORY note), which otherwise calls the real OpenAI
// embedding client. Mocked to a fixed vector so the test stays offline and
// deterministic; everything else in this file is untouched.
vi.mock("@/lib/embeddings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/embeddings")>();
  return { ...actual, generateEmbedding: vi.fn().mockResolvedValue([1, 0]) };
});

const CODE_SESSIONS_LIB_DIR = join(__dirname, "..");
const CODE_SESSIONS_API_DIR = join(__dirname, "../../../app/api/code-sessions");
// F10 — the backfill CLI entry point (apps/cloud/scripts/code-kg/backfill.ts)
// is a new entry point into code-graph.ts that the original gate never
// scanned. It also `await import(...)`s code-graph.ts dynamically, which is
// exactly one of the evasions this gate now has to catch (see
// FORBIDDEN_EVERYWHERE below) — scan it with the same rules as everything
// under lib/code-sessions/.
const SCRIPTS_CODE_KG_DIR = join(__dirname, "../../../../scripts/code-kg");

// Files allowed a read-only reference to kg_nodes (basenames, matched against
// the scanned file's own name). Empty since migration 084 — see the HISTORY
// note above. Kept as a named set (not deleted outright) so a future file
// that legitimately needs a read-only kg_nodes exception has an obvious,
// already-wired place to add itself, with the same review bar this gate has
// always applied to that allowance.
const KG_NODES_READ_ALLOWED = new Set<string>([]);

// Forbidden in EVERY scanned file, no exceptions: GraphWriter (the chat
// graph's only writer), any reference to kg_edges, any WRITE to kg_nodes
// (insert/update/upsert/delete chained directly off `.from("kg_nodes")` —
// this repo's supabase-js calls are always written `.from(table).method(`,
// so this reliably encodes "kg_nodes is never mutated" without also
// forbidding cross-links.ts's legitimate `.from("kg_nodes").select(...)`),
// AND (F10, adversarial verify of d753f7c) the two evasions of the above
// that a plain identifier/string grep would otherwise miss:
//   - a dynamic `import("...graph-writer")` (the gate used to only scan
//     static `import` statements' text incidentally; this makes the dynamic
//     form explicit rather than relying on that accident)
//   - `supabase.rpc("kg_...")` — any RPC call into a kg_-prefixed function
//     name. This is the most plausible real evasion: migration 032 already
//     ships a write RPC (`kg_edit_move_top_level`) for the CHAT graph, and
//     nothing stops a future code-sessions change from calling an RPC
//     instead of `.from("kg_nodes")` directly.
const FORBIDDEN_EVERYWHERE = [
  /GraphWriter/,
  /\bkg_edges\b/,
  /from\(\s*["']kg_nodes["']\s*\)\s*\.\s*(insert|update|upsert|delete)\s*\(/,
  /import\(\s*["'][^"']*graph-writer["']/,
  /rpc\(\s*["']kg_/,
];
// Forbidden everywhere EXCEPT the files in KG_NODES_READ_ALLOWED.
const KG_NODES_ANY_REFERENCE = /\bkg_nodes\b/;

// F10: restrict which lib/kg/ modules code-sessions is even allowed to
// import from, allowlisted by name. This catches a namespace import
// (`import * as W from ".../kg/graph-writer"`) the same way a named import
// is caught — the regex matches on the trailing `kg/<module>` path segment
// regardless of how many `../` precede it or whether it's a relative path or
// the `@/lib/kg/...` alias, and regardless of import FORM (default/named/
// namespace all share the same `from "..."` clause; dynamic `import(...)`
// is covered by the `import\(` alternative). Adding a new lib/kg/ import is
// a deliberate action: extend this allowlist in the same commit.
// spend-ledger (issue #21): the cost-cap ledger + monthly-ceiling preflight.
// Touches ONLY the llm_spend table (migration 035) — zero coupling to
// kg_nodes/kg_edges/GraphWriter, same isolation guarantee as the rest of this
// allowlist.
const KG_IMPORT_ALLOWLIST = new Set([
  "pagination",
  "llm",
  "types",
  "concurrency",
  "embeddings",
  "entity-labels",
  "spend-ledger",
  // ADR 0039 (W6/D7): mirror-conversations.ts computes the SAME source hash
  // pass1.ts/arrival-loop.ts use to decide "did this conversation's content
  // actually change" — reading it (not the extraction pipeline itself) is
  // what lets an unchanged mirror re-run stay a true no-op without
  // re-triggering extraction. Pure function, zero side effects, no kg_nodes/
  // kg_edges/kg_claims access — same profile as the other allowlisted utils.
  "source-hash",
]);
const KG_IMPORT_RE = /(?:from\s+|import\()\s*["'][^"']*\/kg\/([\w-]+)["']/g;

// WHAT THIS GATE DELIBERATELY CANNOT CATCH (grep-class, not a real import
// resolver — see the F10 finding in docs/adr's P2a adversarial verify):
//   - a re-export through a lib/kg/ barrel file that this gate doesn't
//     itself scan (e.g. `export * from "./graph-writer"` inside a module
//     NOT under lib/kg/ AND not matched by KG_IMPORT_RE's `/kg/` path
//     segment — would need an actual module-resolution graph to catch).
//   - a computed/concatenated identifier or table name, e.g.
//     `supabase.from("kg_" + "nodes")` or `client["Graph" + "Writer"]` — no
//     regex over source text can evaluate string concatenation.
// Both require following imports/evaluating expressions, which is out of
// scope for a grep-class check; the byte-identical proof below is the
// backstop that would still catch either evasion's actual EFFECT (a kg_nodes
// row appearing/disappearing that a code-graph build didn't intend).

// Strip comments before scanning — this module's own doc comments legitimately
// NAME GraphWriter/kg_nodes/kg_edges to explain the isolation invariant (see
// import.ts's and route.ts's header comments). The gate must fail on actual
// CODE (an import, an identifier reference, a table-name string), not on
// prose that documents what must never appear in code. Heuristic, not a full
// TS lexer: strips block comments and `//` line comments not preceded by `:`
// (so a `https://...` URL inside a doc comment doesn't confuse detection) —
// sufficient for this repo's comment style.
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out; // directory doesn't exist (e.g. scripts/code-kg not present in some checkout) — scan nothing rather than throw
  }
  for (const entry of entries) {
    if (entry === "__tests__") continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

// F10: glob every route.ts under app/api/code-sessions/ instead of a
// hardcoded list — the original gate's 2-element ROUTE_FILES array silently
// would not have covered a future e.g. app/api/code-sessions/graph/route.ts.
function listRouteFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...listRouteFiles(full));
    } else if (entry === "route.ts") {
      out.push(full);
    }
  }
  return out;
}

describe("code-session isolation (ADR 0021 Q2 / Q4) — STATIC GATE", () => {
  const files = [
    ...listTsFiles(CODE_SESSIONS_LIB_DIR),
    ...listRouteFiles(CODE_SESSIONS_API_DIR),
    ...listTsFiles(SCRIPTS_CODE_KG_DIR),
  ];

  it("scanned at least the expected module set", () => {
    // Sanity: fail loudly if the glob logic silently finds nothing (e.g. a
    // path typo), rather than passing vacuously.
    expect(files.length).toBeGreaterThanOrEqual(11); // import/payload/repo-identity/auth/summarize/rollup/cross-links/synthesize + 2 routes + backfill.ts
  });

  it("only the allow-listed lib/kg/ modules are imported anywhere in the scanned set (F10)", () => {
    for (const file of files) {
      const code = stripComments(readFileSync(file, "utf8"));
      for (const match of code.matchAll(KG_IMPORT_RE)) {
        const moduleName = match[1];
        expect(
          KG_IMPORT_ALLOWLIST.has(moduleName),
          `${file.split("apps/cloud")[1]} imports lib/kg/${moduleName}, which is not on the allowlist`,
        ).toBe(true);
      }
    }
  });

  for (const file of files) {
    const label = file.split("apps/cloud/src")[1] ?? file;
    const basename = file.split("/").pop() ?? file;
    const allowKgNodesRead = KG_NODES_READ_ALLOWED.has(basename);

    it(`${label} never imports GraphWriter, never references kg_edges, never WRITES kg_nodes`, () => {
      const code = stripComments(readFileSync(file, "utf8"));
      for (const pattern of FORBIDDEN_EVERYWHERE) {
        expect(code).not.toMatch(pattern);
      }
      if (!allowKgNodesRead) {
        expect(code).not.toMatch(KG_NODES_ANY_REFERENCE);
      }
    });
  }

  it("only the allow-listed files reference kg_nodes, and every reference is read-only (.select)", () => {
    const referencing = files.filter((f) => KG_NODES_ANY_REFERENCE.test(stripComments(readFileSync(f, "utf8"))));
    const referencingBasenames = new Set(referencing.map((f) => f.split("/").pop()));
    expect(referencingBasenames).toEqual(KG_NODES_READ_ALLOWED);

    for (const file of referencing) {
      const code = stripComments(readFileSync(file, "utf8"));
      expect(code).toMatch(/from\(\s*["']kg_nodes["']\s*\)\s*\.\s*select\s*\(/);
    }
  });
});

// --- byte-identical proof -------------------------------------------------

function snapshotChatGraphHash(db: FakeSupabase, userId: string): string {
  const nodes = db
    .getRows("kg_nodes")
    .filter((r) => r.user_id === userId)
    .map((r) => JSON.stringify(r, Object.keys(r).sort()))
    .sort();
  const edges = db
    .getRows("kg_edges")
    .filter((r) => r.user_id === userId)
    .map((r) => JSON.stringify(r, Object.keys(r).sort()))
    .sort();
  return createHash("sha256").update(JSON.stringify({ nodes, edges })).digest("hex");
}

function seedChatGraph(db: FakeSupabase, userId: string) {
  const selfId = "node-self";
  const lifeAreaId = "node-area-work";
  const itemId = "node-item-launch";
  const personId = "node-person-1";

  db.seed("kg_nodes", [
    { id: selfId, user_id: userId, type: "User", label: "_self", aliases: [], props: {} },
    { id: lifeAreaId, user_id: userId, type: "LifeArea", label: "Work", aliases: [], props: {} },
    { id: itemId, user_id: userId, type: "Item", label: "Product launch", aliases: [], props: {} },
    { id: personId, user_id: userId, type: "Person", label: "Alex Rivera", aliases: [], props: {} },
  ]);
  db.seed("kg_edges", [
    { id: "edge-1", user_id: userId, src_id: lifeAreaId, dst_id: itemId, rel_type: "contains", props: {} },
    { id: "edge-2", user_id: userId, src_id: itemId, dst_id: personId, rel_type: "collaborates_with", props: {} },
  ]);
}

function makeSession(overrides: Partial<RawCodeSessionPayload> = {}): RawCodeSessionPayload {
  return {
    source: "claude-code",
    sourceSessionId: "session-default",
    contentHash: "hash-default",
    repo: { remoteUrl: "https://github.com/acme/webapp.git" },
    startedAt: "2026-07-01T10:00:00.000Z",
    endedAt: "2026-07-01T10:05:00.000Z",
    turns: [{ idx: 0, role: "user", kind: "prose", text: "Ship the launch page", ts: "2026-07-01T10:00:00.000Z" }],
    filesTouched: ["src/App.tsx"],
    toolCounts: { Edit: 1 },
    ...overrides,
  };
}

describe("code-session isolation (ADR 0021 Q2) — BYTE-IDENTICAL PROOF", () => {
  it("a full multi-session, multi-repo import leaves kg_nodes/kg_edges byte-identical", async () => {
    const db = new FakeSupabase();
    const userId = "founder-1";
    seedChatGraph(db, userId);

    const before = snapshotChatGraphHash(db, userId);
    const nodeCountBefore = db.getRows("kg_nodes").length;
    const edgeCountBefore = db.getRows("kg_edges").length;

    const repos = [
      "https://github.com/acme/webapp.git",
      "https://github.com/acme/api-server.git",
      "https://github.com/acme/infra.git",
    ];
    const client = db.asClient();
    for (let i = 0; i < 12; i++) {
      const repo = repos[i % repos.length];
      await importCodeSession(
        client,
        userId,
        makeSession({
          sourceSessionId: `session-${i}`,
          contentHash: `hash-${i}`,
          repo: { remoteUrl: repo },
        }),
      );
    }

    // Sanity: the import actually did something (not a vacuous "nothing ran"
    // pass) — several code_projects and sessions now exist.
    expect(db.getRows("code_sessions")).toHaveLength(12);
    expect(db.getRows("code_projects").length).toBe(repos.length);

    const after = snapshotChatGraphHash(db, userId);
    expect(after).toBe(before);
    expect(db.getRows("kg_nodes")).toHaveLength(nodeCountBefore);
    expect(db.getRows("kg_edges")).toHaveLength(edgeCountBefore);
  });

  it("re-importing a changed session (turns replaced) still leaves kg_nodes/kg_edges untouched", async () => {
    const db = new FakeSupabase();
    const userId = "founder-1";
    seedChatGraph(db, userId);
    const before = snapshotChatGraphHash(db, userId);

    const client = db.asClient();
    await importCodeSession(client, userId, makeSession({ contentHash: "v1" }));
    await importCodeSession(
      client,
      userId,
      makeSession({
        contentHash: "v2",
        turns: [{ idx: 0, role: "user", kind: "prose", text: "changed", ts: "2026-07-01T10:00:00.000Z" }],
      }),
    );

    expect(snapshotChatGraphHash(db, userId)).toBe(before);
  });
});

// --- P1c: the full synthesize pass (summaries -> rollups -> cross-links) ---

const LLM_CONFIG: ModelConfig = {
  model: "gpt-4o-mini",
  baseURL: undefined,
  apiKey: "test-key",
  embedModel: "text-embedding-3-small",
  embedDimensions: 1536,
};

/** Fake LLM dispatching on prompt shape: the rollup prompt asks for recurring_files_tools, summarize's does not. */
function makeFakeLlm(): LlmClient {
  const chatCreate = vi.fn().mockImplementation((body: { messages: { content: string }[] }) => {
    const isRollupCall = (body.messages[0]?.content ?? "").includes("recurring_files_tools");
    const content = isRollupCall
      ? JSON.stringify({
          summary: "Built the launch page.",
          what_built: "The launch page.",
          key_decisions: "",
          recurring_files_tools: ["src/App.tsx"],
          people: ["Alex Rivera"],
          open_threads: "",
        })
      : JSON.stringify({ summary: "Shipped the launch page." });
    return Promise.resolve({
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    });
  });
  const client: OpenAILike = { chat: { completions: { create: chatCreate } }, embeddings: { create: vi.fn() } };
  return new LlmClient(LLM_CONFIG, { client });
}

describe("code-session isolation (ADR 0021 Q2/Q4, ADR 0023 Q3) — P1c SYNTHESIZE BYTE-IDENTICAL PROOF", () => {
  it("the full synthesize pass (summarize -> rollup -> cross-links -> Stage-1 code-graph build) leaves kg_nodes/kg_edges byte-identical", async () => {
    const db = new FakeSupabase();
    const userId = "founder-1";
    seedChatGraph(db, userId);
    const before = snapshotChatGraphHash(db, userId);
    const nodesBefore = db.getRows("kg_nodes").length;
    const edgesBefore = db.getRows("kg_edges").length;

    const client = db.asClient();
    // A conversation whose (mocked, see the module-level vi.mock above)
    // embedding matches the project's rollup signal — the content-match
    // target cross-links.ts links to post-migration-084 (no more
    // Item/LifeArea/Person name-match; see cross-links.ts's HISTORY note).
    // source: "chatgpt" — a real chat source (cross-links.ts's CHAT_SOURCES
    // allowlist, review-084.md finding 2): a mirrored code session
    // (source='claude-code') is never a cross-link candidate.
    db.seed("conversations", [
      { id: "conv-launch", user_id: userId, title: "Launch page retro", embedding: [1, 0], source: "chatgpt" },
    ]);
    await importCodeSession(
      client,
      userId,
      makeSession({
        sourceSessionId: "session-launch",
        contentHash: "hash-launch",
        repo: { remoteUrl: "https://github.com/acme/webapp.git" },
        turns: [
          {
            idx: 0,
            role: "user",
            kind: "prose",
            text: "Ship the launch page with Alex Rivera's design",
            ts: "2026-07-01T10:00:00.000Z",
          },
          { idx: 1, role: "user", kind: "prose", text: "Wire up the CTA button", ts: "2026-07-01T10:01:00.000Z" },
          { idx: 2, role: "user", kind: "prose", text: "Ship it", ts: "2026-07-01T10:02:00.000Z" },
        ],
      }),
    );

    const llm = makeFakeLlm();
    const result = await synthesizeCodeDimension({ supabase: client, llm, userId });

    // Sanity: the pass actually did something (not a vacuous no-op run).
    expect(result.summarize.processed).toBe(1);
    expect(result.rollup.processed).toBe(1);
    // The one legitimate cross-graph write: code_cross_links, pointing at
    // the seeded conversation via the (mocked) content-match signal — never
    // touching kg_nodes/kg_edges (asserted below).
    expect(db.getRows("code_cross_links").length).toBeGreaterThan(0);
    expect(db.getRows("code_cross_links")[0].conversation_id).toBe("conv-launch");
    // ADR 0023 P2a — the Stage-1 code graph itself got built into its OWN
    // dedicated tables (migration 031), not kg_nodes/kg_edges.
    expect(db.getRows("code_kg_nodes").length).toBeGreaterThan(0);
    expect(db.getRows("code_kg_edges").length).toBeGreaterThan(0);

    const after = snapshotChatGraphHash(db, userId);
    expect(after).toBe(before);
    expect(db.getRows("kg_nodes")).toHaveLength(nodesBefore);
    expect(db.getRows("kg_edges")).toHaveLength(edgesBefore);
  });
});

// --- ADR 0023 P2a: Stage-1 code-graph build, standalone ---------------------
//
// This is the ADR's own test-plan item 1, run against the extractor directly
// (not routed through synthesize): "snapshot md5(kg_nodes)⊕md5(kg_edges) for
// the user, run a full graph build, assert byte-identical after." code-graph.ts
// is also required to be runnable standalone (backfill) — this proof
// exercises exactly that entry point.
describe("code-session isolation (ADR 0023 Q3) — Stage-1 CODE-GRAPH BUILD, STANDALONE BYTE-IDENTICAL PROOF", () => {
  it("buildCodeGraphForUser, run directly (not via synthesize), leaves kg_nodes/kg_edges byte-identical across many projects", async () => {
    const db = new FakeSupabase();
    const userId = "founder-1";
    seedChatGraph(db, userId);

    const before = snapshotChatGraphHash(db, userId);
    const nodesBefore = db.getRows("kg_nodes").length;
    const edgesBefore = db.getRows("kg_edges").length;

    const client = db.asClient();
    const repos = [
      "https://github.com/acme/webapp.git",
      "https://github.com/acme/api-server.git",
      "https://github.com/acme/infra.git",
    ];
    for (let i = 0; i < 12; i++) {
      const repo = repos[i % repos.length];
      await importCodeSession(
        client,
        userId,
        makeSession({
          sourceSessionId: `session-${i}`,
          contentHash: `hash-${i}`,
          repo: { remoteUrl: repo },
          turns: [
            { idx: 0, role: "user", kind: "prose", text: "Ship it", ts: "2026-07-01T10:00:00.000Z" },
            {
              idx: 1,
              role: "assistant",
              kind: "tool_use",
              toolName: "Edit",
              filePath: "/home/dev/webapp/src/App.tsx",
              toolUseId: `toolu_${i}`,
              resultType: "update",
              ts: "2026-07-01T10:01:00.000Z",
            },
          ],
          filesTouched: ["/home/dev/webapp/src/App.tsx"],
          toolCounts: { Edit: 1 },
        }),
      );
    }

    // Sanity: a full graph build (not a vacuous no-op).
    const results = await buildCodeGraphForUser(client, userId);
    expect(results).toHaveLength(repos.length);
    expect(db.getRows("code_kg_nodes").length).toBeGreaterThan(0);
    expect(db.getRows("code_kg_edges").length).toBeGreaterThan(0);

    const after = snapshotChatGraphHash(db, userId);
    expect(after).toBe(before);
    expect(db.getRows("kg_nodes")).toHaveLength(nodesBefore);
    expect(db.getRows("kg_edges")).toHaveLength(edgesBefore);
  });

  it("re-running the graph build (regen) still leaves kg_nodes/kg_edges byte-identical", async () => {
    const db = new FakeSupabase();
    const userId = "founder-1";
    seedChatGraph(db, userId);
    const before = snapshotChatGraphHash(db, userId);

    const client = db.asClient();
    await importCodeSession(client, userId, makeSession({ contentHash: "v1" }));
    await buildCodeGraphForUser(client, userId);
    await buildCodeGraphForUser(client, userId); // regen

    expect(snapshotChatGraphHash(db, userId)).toBe(before);
  });
});
