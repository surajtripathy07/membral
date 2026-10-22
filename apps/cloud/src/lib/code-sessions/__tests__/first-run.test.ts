// W5 D4: the first-run card's loader. Account-age gate (no query for 7+ day accounts), user-scoped exact
// counts and one-row span lookups, named columns, no row scan.
import { createFakeDb } from "@membral/test-kit";
import { describe, expect, it } from "vitest";
import type { TypedDb } from "@/lib/db/types";
import { getFirstRunHistory, isNewAccount } from "../first-run";

const ME = "00000000-0000-4000-8000-00000000c0de";
const OTHER = "00000000-0000-4000-8000-00000000beef";
const NOW = new Date("2026-10-03T12:00:00.000Z");

function session(user: string, id: string, source: string, startedAt: string, parent: string | null = null) {
  return {
    id,
    user_id: user,
    source,
    source_session_id: id,
    parent_source_session_id: parent,
    started_at: startedAt,
    created_at: "2026-10-02T09:00:00.000Z",
  };
}

function setup() {
  const db = createFakeDb({ flavour: "db", recordReads: true });
  db.seedUser({ id: ME, jwt: "jwt-me" });
  db.seed("code_sessions", [
    session(ME, "a", "claude-code", "2026-09-10T00:00:00.000Z"),
    session(ME, "a:agent-1", "claude-code", "2026-09-10T00:05:00.000Z", "a"),
    session(ME, "b", "opencode", "2026-10-01T00:00:00.000Z"),
    session(ME, "c", "mystery", "2026-09-15T00:00:00.000Z"),
    session(OTHER, "z", "claude-code", "2026-08-01T00:00:00.000Z"),
  ]);
  return { db, client: { from: (t: string) => db.from(t) } as unknown as TypedDb };
}

describe("getFirstRunHistory", () => {
  it("counts only the caller's sessions per harness, with sub-agents, span and an other bucket", async () => {
    const { client, db } = setup();
    const history = await getFirstRunHistory(client, ME, "2026-10-01T00:00:00.000Z", NOW);
    expect(history).toEqual({
      total: 4,
      perHarness: [
        { source: "claude-code", label: "Claude Code", count: 2 },
        { source: "opencode", label: "opencode", count: 1 },
        { source: "other", label: "other", count: 1 },
      ],
      subAgents: 1,
      earliestStart: "2026-09-10T00:00:00.000Z",
      latestStart: "2026-10-01T00:00:00.000Z",
      memoryCount: 0,
    });
    const reads = JSON.stringify(db.oplog.filter((op) => op.op === "select"));
    expect(reads).not.toContain('"*"');
    expect(reads).toContain(ME);
    expect(reads).not.toContain(OTHER);
  });

  it("runs no read at all once the account is 7 days old", async () => {
    const { client, db } = setup();
    expect(await getFirstRunHistory(client, ME, "2026-09-26T12:00:00.000Z", NOW)).toBeNull();
    expect(db.oplog.filter((op) => op.op === "select")).toHaveLength(0);
  });

  it("is null for a new account with no sessions", async () => {
    const db = createFakeDb({ flavour: "db", recordReads: true });
    db.seedUser({ id: ME, jwt: "jwt-me" });
    const client = { from: (t: string) => db.from(t) } as unknown as TypedDb;
    expect(await getFirstRunHistory(client, ME, "2026-10-02T00:00:00.000Z", NOW)).toBeNull();
  });
});

describe("isNewAccount", () => {
  it("cuts off at exactly 7 days, and treats a missing or bad date as not new", () => {
    expect(isNewAccount("2026-09-26T12:00:01.000Z", NOW)).toBe(true);
    expect(isNewAccount("2026-09-26T12:00:00.000Z", NOW)).toBe(false);
    expect(isNewAccount(undefined, NOW)).toBe(false);
    expect(isNewAccount("nope", NOW)).toBe(false);
  });
});
