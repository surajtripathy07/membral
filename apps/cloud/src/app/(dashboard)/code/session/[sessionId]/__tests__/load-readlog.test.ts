// G3 step 3B-6a lock: `loadCodeSessionPage`'s direct `.from("code_session_issues")`
// read (load.ts:~110) will move into a repository function. This drives the
// loader against a REAL `@membral/test-kit` FakeDb (not the mocked lib modules
// load-call-log.test.ts uses) and snapshots every `select` chain the loader —
// and the lib/code-sessions reads it triggers — issues today, so the move can
// be checked against this read log afterwards. Records what the code does
// today; asserts nothing new.
import { createFakeDb, type FakeDb } from "@membral/test-kit";
import { beforeEach, describe, expect, it, vi } from "vitest";

const USER_ID = "00000000-0000-4000-8000-00000000c0de";
const USER_JWT = "jwt-golden-user";
const SESSION_ID = "9e4e0000-0000-4000-8000-000000000001";
const PROJECT_ID = "5eed0000-0000-4000-8000-000000000001";

const { state } = vi.hoisted(() => ({ state: { db: null as FakeDb | null } }));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    const db = state.db as FakeDb;
    return {
      auth: { getUser: async () => db.auth.getUser(USER_JWT) },
      from: (t: string) => db.from(t),
    };
  },
}));

import { loadCodeSessionPage } from "../load";

/** `<name>`: only the `select` ops, in order, with `seq` renumbered 1..n (same convention as
 * `apps/cloud/src/__golden__/routes/harness.ts`'s `expectReadLog`). */
async function expectReadLog(db: FakeDb, name: string): Promise<void> {
  const reads = db.oplog.filter((op) => op.op === "select").map((op, i) => ({ ...op, seq: i + 1 }));
  await expect(`${JSON.stringify(reads, null, 2)}\n`).toMatchFileSnapshot(name);
}

beforeEach(() => {
  const db = createFakeDb({ flavour: "db", recordReads: true });
  db.seedUser({ id: USER_ID, jwt: USER_JWT });
  db.seed("code_projects", [
    { id: PROJECT_ID, user_id: USER_ID, display_name: "CodeHub", repo_identity: "codehub/app" },
  ]);
  db.seed("code_sessions", [
    {
      id: SESSION_ID,
      user_id: USER_ID,
      code_project_id: PROJECT_ID,
      title: "Fix the login redirect",
      summary: null,
      git_branch: "main",
      started_at: "2026-09-10T00:00:00.000Z",
      ended_at: "2026-09-10T01:00:00.000Z",
      duration_seconds: 3600,
      turn_count: 0,
      user_turn_count: 0,
      tool_count: 0,
      files_touched: [],
      source: "claude-code",
      source_session_id: "sess-alpha",
      parent_source_session_id: null,
      props: {},
    },
  ]);
  db.seed("code_session_issues", [
    {
      user_id: USER_ID,
      session_id: SESSION_ID,
      ref: "codehub/app#12",
      number: 12,
      kind: "issue",
      role: "worked_on",
      evidence_quote: "fixes #12",
      turn_idx: 0,
      review_verb: null,
      build_verb: null,
      tier: "observed",
      turn_share: null,
      related_to: null,
    },
  ]);
  state.db = db;
});

describe("/code/session/[sessionId] load.ts — read log (G3 3B-6a)", () => {
  it("records every select the session load issues", async () => {
    const out = await loadCodeSessionPage(SESSION_ID, false, null);
    expect(out).toBeTruthy();
    await expectReadLog(state.db as FakeDb, "./session-load.readlog.json");
  });
});
