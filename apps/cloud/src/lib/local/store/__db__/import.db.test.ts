// The import write path: importCodeSession and its import_code_session_turns rpc, end to end on the store.

import { beforeAll, describe, expect, it } from "vitest";
import { importCodeSession } from "@/lib/code-sessions/import";
import type { RawCodeSessionPayload } from "@/lib/code-sessions/payload";
import { getServiceClient } from "@/lib/db/clients";
import { type DbEnv, openDb } from "../../../../../test/db-store";

let env: DbEnv;
beforeAll(async () => {
  env = await openDb();
}, 300_000);

function payload(sourceSessionId: string, overrides: Partial<RawCodeSessionPayload> = {}): RawCodeSessionPayload {
  return {
    source: "claude-code",
    sourceSessionId,
    contentHash: `hash-${sourceSessionId}`,
    repo: { path: "/work/codehub-api", remoteUrl: "https://example.test/codehub/api.git", branch: "main" },
    startedAt: "2026-10-01T10:00:00.000Z",
    endedAt: "2026-10-01T10:05:00.000Z",
    model: "claude-code-sonnet",
    turns: [
      { idx: 0, role: "user", kind: "prose", text: "Add a retry to the importer", ts: "2026-10-01T10:00:00.000Z" },
      {
        idx: 1,
        role: "assistant",
        kind: "tool_use",
        toolName: "Edit",
        filePath: "/work/codehub-api/src/import.ts",
        ts: "2026-10-01T10:01:00.000Z",
      },
      { idx: 2, role: "assistant", kind: "prose", text: "Done.", ts: "2026-10-01T10:04:00.000Z" },
    ],
    filesTouched: ["/work/codehub-api/src/import.ts"],
    toolCounts: { Edit: 1 },
    ...overrides,
  } as RawCodeSessionPayload;
}

describe("importCodeSession on the store", () => {
  it("creates a project, a session and its turns; a second send is skipped; a changed hash re-imports", async () => {
    const userId = await env.newUser();
    const db = getServiceClient();
    const ssid = `imp-${crypto.randomUUID()}`;
    const first = await importCodeSession(db, userId, payload(ssid));
    expect(first.status, first.error).toBe("imported");
    const turns = (await env.query("select count(*)::int n from code_session_turns where session_id=$1", [
      first.sessionId,
    ])) as { n: number }[];
    expect(turns[0]?.n).toBe(3);
    const sess = (await env.query("select turn_count, user_turn_count, tool_count from code_sessions where id=$1", [
      first.sessionId,
    ])) as Record<string, number>[];
    expect(sess[0]).toMatchObject({ turn_count: 3, user_turn_count: 1, tool_count: 1 });
    const again = await importCodeSession(db, userId, payload(ssid));
    expect(again.status).toBe("skipped");
    const changed = await importCodeSession(
      db,
      userId,
      payload(ssid, {
        contentHash: "hash-changed",
        turns: [
          ...payload(ssid).turns,
          { idx: 3, role: "user", kind: "prose", text: "Thanks", ts: "2026-10-01T10:06:00.000Z" },
        ],
      }),
    );
    expect(changed.status, changed.error).toBe("imported");
    const n = (await env.query("select count(*)::int n from code_session_turns where session_id=$1", [
      first.sessionId,
    ])) as { n: number }[];
    expect(n[0]?.n).toBe(4);
    const projects = (await env.query("select count(*)::int n from code_projects where user_id=$1", [userId])) as {
      n: number;
    }[];
    expect(projects[0]?.n).toBe(1);
  });
});
