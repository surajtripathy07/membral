// G3 step 3B-2 lock-extend: `loadCodeStatsPage`'s direct `.from("code_sessions")`
// bypass sites (load.ts:~59, ~86) will move into repository functions in
// 3B-3/3B-4. This drives the loader against a REAL `@membral/test-kit` FakeDb
// (not the mocked lib modules load-call-log.test.ts uses) and snapshots every
// `select` chain the loader — and the lib/code-sessions reads it triggers —
// issues today, so the move can be checked against this read log afterwards.
// Records what the code does today; asserts nothing new.
import { createFakeDb, type FakeDb } from "@membral/test-kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Fixed clock: load.ts derives `since`/`priorSince` from Date.now().
const FIXED_NOW = new Date("2026-09-28T05:55:05.736Z");
const USER_ID = "00000000-0000-4000-8000-00000000c0de";
const USER_JWT = "jwt-golden-user";

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

import { loadCodeStatsPage } from "../load";

/** `<name>`: only the `select` ops, in order, with `seq` renumbered 1..n (same convention as
 * `apps/cloud/src/__golden__/routes/harness.ts`'s `expectReadLog`). */
async function expectReadLog(db: FakeDb, name: string): Promise<void> {
  const reads = db.oplog.filter((op) => op.op === "select").map((op, i) => ({ ...op, seq: i + 1 }));
  await expect(`${JSON.stringify(reads, null, 2)}\n`).toMatchFileSnapshot(name);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: FIXED_NOW });
  const db = createFakeDb({ flavour: "db", recordReads: true });
  db.seedUser({ id: USER_ID, jwt: USER_JWT });
  // One session inside the default 30d window, with a title set — so
  // getSessionTitles' "untitled" fallback (a further code_session_turns
  // read via getFirstUserMessages) never fires, keeping this read log to
  // the loader's own baseline queries.
  db.seed("code_sessions", [
    {
      id: "9e4e0000-0000-4000-8000-000000000001",
      user_id: USER_ID,
      started_at: "2026-09-10T00:00:00.000Z",
      turn_count: 5,
      user_turn_count: 3,
      props: {},
      parent_source_session_id: null,
      git_branch: "main",
      code_project_id: "5eed0000-0000-4000-8000-000000000001",
      title: "Fix the login redirect",
      summary: null,
      short_title: null,
      source: "claude-code",
      source_session_id: "sess-alpha",
    },
  ]);
  state.db = db;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("/code/stats load.ts — read log (G3 3B-2 lock-extend)", () => {
  it("records every select the default-window load issues", async () => {
    await loadCodeStatsPage(30);
    await expectReadLog(state.db as FakeDb, "./code-stats-load.readlog.json");
  });
});
