// Route contracts: /api/memory/preamble (AK), /api/memory/branch-state (BK), /api/memory/extraction/kick (BK).
import { describe, it, vi } from "vitest";

vi.mock("@supabase/supabase-js", async () => (await import("./boundary")).supabaseJsModule());
vi.mock("@supabase/ssr", async () => (await import("./boundary")).supabaseSsrModule());
vi.mock("next/headers", async () => (await import("./boundary")).nextHeadersModule());
vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: (await import("./boundary")).after,
}));

import { GET as branchGET, POST as branchPOST } from "@/app/api/memory/branch-state/route";
import { POST as kickPOST } from "@/app/api/memory/extraction/kick/route";
import { GET as preambleGET } from "@/app/api/memory/preamble/route";
import { callRoute, db, expectContract, expectOplog, PROJECT_ID, setupRouteGolden, USER_ID } from "./harness";

setupRouteGolden();

const REPO = "codehub.example/acme/webapp";

/**
 * W3 D5: a session inside the 7-day window with observed forge refs, so the
 * happy preamble exercises "Seen in the last 7 days": an issue grouped with
 * its commit and the MR on that commit's branch, a merged MR (dropped) and a
 * prose ref (never shown).
 */
function seedCurrentWork(): void {
  const session = "5eed0000-0000-4000-8000-0000000000d5";
  const sha = "d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5";
  db().seed("code_sessions", [
    {
      id: session,
      user_id: USER_ID,
      code_project_id: PROJECT_ID,
      started_at: "2025-12-30T09:00:00.000Z",
      ended_at: "2025-12-30T10:00:00.000Z",
      parent_source_session_id: null,
      files_touched: [],
      turn_count: 0,
    },
  ]);
  const base = {
    user_id: USER_ID,
    session_id: session,
    action_ix: 0,
    target_kind: null,
    verb: "viewed",
    source: "cli",
    prose_ref: false,
    host: "codehub.example",
    project: "acme/webapp",
    number: null,
    sha: null,
    branch: null,
    observed_state: null,
    title: null,
    url: null,
  };
  // An outcome in the window's session keeps "Since last session: N PRs" in the golden.
  db().seed("session_memories", [
    {
      id: "5eed0000-0000-4000-8000-0000000001d5",
      user_id: USER_ID,
      code_project_id: PROJECT_ID,
      code_session_id: session,
      agent_id: null,
      source: "extractor",
      kind: "outcome",
      text: "Opened MR !42",
      quote: null,
      turn_idx: 6,
      turn_role: "assistant",
      ref: "!42",
      ref_kind: "pr",
      branch: "fix-totals",
      head_sha: null,
      thread: null,
      paths: [],
      verified: false,
      durable: false,
      observed_durable: false,
      recurrence_count: 1,
      recurs_of: null,
      scope: "project",
      confidence: 0.8,
      supersedes: null,
      retired_at: null,
      chat_conversation_id: null,
      priority: false,
      content_hash: "mh-d5",
      embedding: null,
      created_at: "2025-12-30T09:40:00.000Z",
    },
  ]);
  db().seed("code_session_forge_refs", [
    {
      ...base,
      id: 1,
      turn_idx: 1,
      kind: "issue",
      number: 41,
      observed_state: "opened",
      title: "Checkout totals off by one",
      observed_at: "2025-12-30T09:05:00.000Z",
      item_key: "issue codehub.example/acme/webapp#41",
    },
    {
      ...base,
      id: 2,
      turn_idx: 4,
      kind: "commit",
      verb: "committed",
      sha,
      branch: "fix-totals",
      observed_at: "2025-12-30T09:30:00.000Z",
      item_key: `commit codehub.example/acme/webapp@${sha}`,
    },
    {
      ...base,
      id: 3,
      turn_idx: 4,
      kind: "issue",
      verb: "committed",
      number: 41,
      sha,
      observed_at: "2025-12-30T09:30:00.000Z",
      item_key: "issue codehub.example/acme/webapp#41",
    },
    {
      ...base,
      id: 4,
      turn_idx: 6,
      kind: "merge_request",
      verb: "opened",
      number: 42,
      branch: "fix-totals",
      observed_state: "opened",
      observed_at: "2025-12-30T09:40:00.000Z",
      item_key: "merge_request codehub.example/acme/webapp#42",
    },
    {
      ...base,
      id: 5,
      turn_idx: 7,
      kind: "merge_request",
      verb: "merged",
      number: 40,
      observed_state: "merged",
      observed_at: "2025-12-30T09:45:00.000Z",
      item_key: "merge_request codehub.example/acme/webapp#40",
    },
    {
      ...base,
      id: 6,
      turn_idx: 8,
      kind: "issue",
      verb: "referenced",
      source: "paste",
      prose_ref: true,
      number: 99,
      observed_at: "2025-12-30T09:50:00.000Z",
      item_key: "issue codehub.example/acme/webapp#99",
    },
  ]);
}

describe("GET /api/memory/preamble", () => {
  const path = `/api/memory/preamble?repo=${encodeURIComponent(REPO)}&branch=main`;
  it("401 without authorization", async () => {
    await expectContract("memory-preamble.no-auth", await callRoute(preambleGET, { path }));
  });
  it("401 for a JWT (lls_ key only)", async () => {
    await expectContract("memory-preamble.jwt", await callRoute(preambleGET, { path, as: "jwt" }));
  });
  it("401 for an unknown key", async () => {
    await expectContract("memory-preamble.bad-key", await callRoute(preambleGET, { path, as: "bad-key" }));
  });
  it("400 without repo", async () => {
    await expectContract(
      "memory-preamble.no-repo",
      await callRoute(preambleGET, { path: "/api/memory/preamble", as: "key" }),
    );
  });
  it("text/plain preamble over the seed", async () => {
    seedCurrentWork();
    await expectContract("memory-preamble.happy-text", await callRoute(preambleGET, { path, as: "key" }));
  });
  it("JSON preamble when Accept asks for it", async () => {
    seedCurrentWork();
    await expectContract(
      "memory-preamble.happy-json",
      await callRoute(preambleGET, { path, as: "key", headers: { accept: "application/json" } }),
    );
  });
});

describe("/api/memory/branch-state", () => {
  const path = "/api/memory/branch-state";
  it("GET 401 without authorization", async () => {
    await expectContract("memory-branch-state.get-no-auth", await callRoute(branchGET, { path }));
  });
  it("GET refs to check over the seed", async () => {
    await expectContract(
      "memory-branch-state.get-happy",
      await callRoute(branchGET, { path: `${path}?days=60`, as: "key" }),
    );
  });
  it("POST 400 for malformed JSON", async () => {
    await expectContract(
      "memory-branch-state.post-malformed-json",
      await callRoute(branchPOST, { method: "POST", path, as: "key", body: "{" }),
    );
  });
  it("POST 400 for a schema-invalid body", async () => {
    await expectContract(
      "memory-branch-state.post-invalid-body",
      await callRoute(branchPOST, { method: "POST", path, as: "key", body: { checked_at: "yesterday", results: [] } }),
    );
  });
  it("POST stores a check result", async () => {
    const body = {
      checked_at: "2025-12-31T12:00:00.000Z",
      results: [
        {
          code_project_id: PROJECT_ID,
          branch: "main",
          default_branch: "main",
          last_seen_sha: "0123456789abcdef0123456789abcdef01234567",
          merged_into_default: true,
          sha_superseded_by: null,
          branch_gone: false,
        },
      ],
    };
    await expectContract(
      "memory-branch-state.post-happy",
      await callRoute(branchPOST, { method: "POST", path, as: "key", body }),
    );
    await expectOplog("memory-branch-state.post-happy");
  });
});

describe("POST /api/memory/extraction/kick", () => {
  const path = "/api/memory/extraction/kick";
  it("401 without authorization", async () => {
    await expectContract("memory-extraction-kick.no-auth", await callRoute(kickPOST, { method: "POST", path }));
  });
  it("403 for a scoped key", async () => {
    await expectContract(
      "memory-extraction-kick.scoped-key",
      await callRoute(kickPOST, { method: "POST", path, as: "scoped-key" }),
    );
  });
  it("kick over the seeded pending queue row", async () => {
    await expectContract(
      "memory-extraction-kick.happy",
      await callRoute(kickPOST, { method: "POST", path, as: "key" }),
    );
  });
});
