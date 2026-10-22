// Route contract: POST /api/code-sessions (BK auth), plus /known and /stats.
import { describe, it, vi } from "vitest";

vi.mock("@supabase/supabase-js", async () => (await import("./boundary")).supabaseJsModule());
vi.mock("@supabase/ssr", async () => (await import("./boundary")).supabaseSsrModule());
vi.mock("next/headers", async () => (await import("./boundary")).nextHeadersModule());
vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: (await import("./boundary")).after,
}));

import { POST as knownPOST } from "@/app/api/code-sessions/known/route";
import { POST } from "@/app/api/code-sessions/route";
import { GET as statsGET } from "@/app/api/code-sessions/stats/route";
import {
  callRoute,
  db,
  expectContract,
  expectOplog,
  expectReadLog,
  setRateLimitAllowed,
  setupRouteGolden,
} from "./harness";

setupRouteGolden();

const NEW_SESSION = {
  source: "claude-code",
  sourceSessionId: "sess-gamma",
  contentHash: "hash-sess-gamma",
  repo: { path: "/work/webapp", remoteUrl: "https://codehub.example/acme/webapp.git", branch: "feat/logout" },
  startedAt: "2025-12-28T09:00:00.000Z",
  endedAt: "2025-12-28T09:10:00.000Z",
  model: "claude-sonnet",
  turns: [
    { idx: 0, role: "user", kind: "prose", text: "Add a logout button", ts: "2025-12-28T09:00:00.000Z" },
    {
      idx: 1,
      role: "assistant",
      kind: "tool_use",
      toolName: "Edit",
      filePath: "/work/webapp/src/Header.tsx",
      ts: "2025-12-28T09:02:00.000Z",
    },
    { idx: 2, role: "assistant", kind: "prose", text: "Added it.", ts: "2025-12-28T09:09:00.000Z" },
  ],
  filesTouched: ["/work/webapp/src/Header.tsx"],
  toolCounts: { Edit: 1 },
};

describe("POST /api/code-sessions", () => {
  const call = (o: Parameters<typeof callRoute>[1]) => callRoute(POST, { method: "POST", ...o });

  it("401 without authorization", async () => {
    await expectContract("code-sessions.no-auth", await call({ path: "/api/code-sessions", body: { sessions: [] } }));
  });
  it("401 for an unknown lls_ key", async () => {
    await expectContract(
      "code-sessions.bad-key",
      await call({ path: "/api/code-sessions", as: "bad-key", body: { sessions: [] } }),
    );
  });
  it("401 for an invalid JWT", async () => {
    await expectContract(
      "code-sessions.bad-jwt",
      await call({ path: "/api/code-sessions", as: "bad-jwt", body: { sessions: [] } }),
    );
  });
  it("403 for a scoped key", async () => {
    await expectContract(
      "code-sessions.scoped-key",
      await call({ path: "/api/code-sessions", as: "scoped-key", body: { sessions: [] } }),
    );
  });
  it("400 for malformed JSON", async () => {
    await expectContract(
      "code-sessions.malformed-json",
      await call({ path: "/api/code-sessions", as: "key", body: "{not json" }),
    );
  });
  it("400 for a schema-invalid body", async () => {
    await expectContract(
      "code-sessions.invalid-body",
      await call({ path: "/api/code-sessions", as: "key", body: { sessions: [{ source: "claude-code" }] } }),
    );
  });
  it("429 when rate limited", async () => {
    setRateLimitAllowed(false);
    await expectContract(
      "code-sessions.rate-limited",
      await call({ path: "/api/code-sessions", as: "key", body: { sessions: [] } }),
    );
  });
  it("imports a new session (key)", async () => {
    await expectContract(
      "code-sessions.happy",
      await call({ path: "/api/code-sessions", as: "key", body: { sessions: [NEW_SESSION] } }),
    );
    await expectOplog("code-sessions.happy");
    await expectReadLog("code-sessions.happy");
  });
  it("skips an already-stored session (jwt)", async () => {
    const same = { ...NEW_SESSION, sourceSessionId: "sess-alpha", contentHash: "hash-sess-alpha" };
    await expectContract(
      "code-sessions.skip-existing",
      await call({ path: "/api/code-sessions", as: "jwt", body: { sessions: [same] } }),
    );
    await expectOplog("code-sessions.skip-existing");
  });
  it("re-imports a byte-identical session stored by an older parser (issue #171)", async () => {
    // sess-alpha's seed row has no props.actions_version (= older), so the
    // content_hash short-circuit must not skip it.
    const same = { ...NEW_SESSION, sourceSessionId: "sess-alpha", contentHash: "hash-sess-alpha", actionsVersion: 2 };
    await expectContract(
      "code-sessions.stale-parser",
      await call({ path: "/api/code-sessions", as: "jwt", body: { sessions: [same] } }),
    );
    await expectOplog("code-sessions.stale-parser");
  });
});

describe("POST /api/code-sessions/known", () => {
  const call = (o: Omit<Parameters<typeof callRoute>[1], "path">) =>
    callRoute(knownPOST, { method: "POST", path: "/api/code-sessions/known", ...o });

  it("401 without authorization", async () => {
    await expectContract("code-sessions-known.no-auth", await call({ body: { sessions: [] } }));
  });
  it("400 for a schema-invalid body", async () => {
    await expectContract(
      "code-sessions-known.invalid-body",
      await call({ as: "key", body: { sessions: [{ source: "" }] } }),
    );
  });
  it("400 for malformed JSON", async () => {
    await expectContract("code-sessions-known.malformed-json", await call({ as: "key", body: "[" }));
  });
  it("answers probes over the seed", async () => {
    const sessions = [
      { source: "claude-code", source_session_id: "sess-alpha", turn_count: 3, ended_at: "2025-12-20T10:05:00.000Z" },
      { source: "claude-code", source_session_id: "sess-beta", turn_count: 9, ended_at: "2025-12-22T10:05:00.000Z" },
      { source: "claude-code", source_session_id: "sess-unknown", turn_count: 1, ended_at: null },
    ];
    await expectContract("code-sessions-known.happy", await call({ as: "key", body: { sessions } }));
    await expectReadLog("code-sessions-known.happy");
  });
  it("a probe with a newer actions_version than the stored row is not known (issue #171)", async () => {
    const sessions = [
      {
        source: "claude-code",
        source_session_id: "sess-alpha",
        turn_count: 3,
        ended_at: "2025-12-20T10:05:00.000Z",
        actions_version: 2,
      },
    ];
    await expectContract("code-sessions-known.stale-parser", await call({ as: "key", body: { sessions } }));
  });
  it("a probe whose actions_version the stored row already has is known (issue #171)", async () => {
    // Positive lock: proves props->actions_version reaches the match (a
    // vacuous projection would leave it undefined and answer `known: []`).
    const alpha = db()
      .tableFor("code_sessions")
      .find((r) => r.source_session_id === "sess-alpha");
    if (!alpha) throw new Error("seed: sess-alpha missing");
    alpha.props = { ...alpha.props, actions_version: 2 };
    const sessions = [
      {
        source: "claude-code",
        source_session_id: "sess-alpha",
        turn_count: 3,
        ended_at: "2025-12-20T10:05:00.000Z",
        actions_version: 2,
      },
    ];
    await expectContract("code-sessions-known.current-parser", await call({ as: "key", body: { sessions } }));
  });
});

describe("GET /api/code-sessions/stats", () => {
  const call = (o: Parameters<typeof callRoute>[1]) => callRoute(statsGET, o);

  it("401 without authorization", async () => {
    await expectContract("code-sessions-stats.no-auth", await call({ path: "/api/code-sessions/stats" }));
  });
  it("403 for a scoped key", async () => {
    await expectContract(
      "code-sessions-stats.scoped-key",
      await call({ path: "/api/code-sessions/stats", as: "scoped-key" }),
    );
  });
  it("totals over the default 30-day window (key)", async () => {
    await expectContract("code-sessions-stats.happy", await call({ path: "/api/code-sessions/stats", as: "key" }));
    await expectReadLog("code-sessions-stats.happy");
  });
  it("totals over ?days=7 (jwt)", async () => {
    await expectContract(
      "code-sessions-stats.days-7",
      await call({ path: "/api/code-sessions/stats?days=7", as: "jwt" }),
    );
  });
});
