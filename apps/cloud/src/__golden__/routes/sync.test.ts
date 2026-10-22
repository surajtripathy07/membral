// Route contracts: POST/OPTIONS /api/sync and GET/OPTIONS /api/conversations/manifest (BJ + extension CORS).
import { beforeEach, describe, it, vi } from "vitest";

vi.mock("@supabase/supabase-js", async () => (await import("./boundary")).supabaseJsModule());
vi.mock("@supabase/ssr", async () => (await import("./boundary")).supabaseSsrModule());
vi.mock("next/headers", async () => (await import("./boundary")).nextHeadersModule());
vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: (await import("./boundary")).after,
}));

import { GET as manifestGET, OPTIONS as manifestOPTIONS } from "@/app/api/conversations/manifest/route";
import { OPTIONS, POST } from "@/app/api/sync/route";
import { _clearConversationCountCacheForTest } from "@/lib/billing";
import {
  callRoute,
  db,
  expectContract,
  expectOplog,
  expectReadLog,
  forceError,
  setRateLimitAllowed,
  setupRouteGolden,
  USER_ID,
  USER_JWT,
} from "./harness";

setupRouteGolden();

const ORIGIN = { origin: `chrome-extension://${"a".repeat(32)}` };
const NEW_CONVERSATION = {
  source: "chatgpt",
  source_id: "chat-2",
  title: "Logout flow",
  created_at: "2025-12-29T08:00:00.000Z",
  updated_at: "2025-12-29T08:10:00.000Z",
  model: "gpt-4o",
  messages: [
    { role: "user", content: "Where should logout live?", timestamp: "2025-12-29T08:00:00.000Z" },
    { role: "assistant", content: "Next to login, in the header.", timestamp: "2025-12-29T08:01:00.000Z" },
  ],
  metadata: {},
  synced_at: "2025-12-29T08:11:00.000Z",
};

describe("/api/sync", () => {
  const post = (o: Omit<Parameters<typeof callRoute>[1], "path">) =>
    callRoute(POST, { method: "POST", path: "/api/sync", ...o });
  it("OPTIONS 204 for an extension origin", async () => {
    await expectContract(
      "sync.options-allowed",
      await callRoute(OPTIONS, { method: "OPTIONS", path: "/api/sync", headers: ORIGIN }),
    );
  });
  it("OPTIONS 403 for any other origin", async () => {
    await expectContract(
      "sync.options-denied",
      await callRoute(OPTIONS, { method: "OPTIONS", path: "/api/sync", headers: { origin: "https://evil.example" } }),
    );
  });
  it("OPTIONS 403 with no Origin header", async () => {
    await expectContract("sync.options-no-origin", await callRoute(OPTIONS, { method: "OPTIONS", path: "/api/sync" }));
  });
  it("401 without authorization (CORS kept)", async () => {
    await expectContract("sync.no-auth", await post({ headers: ORIGIN, body: { conversations: [] } }));
  });
  it("401 for an lls_ key (JWT-only route)", async () => {
    await expectContract("sync.key", await post({ as: "key", headers: ORIGIN, body: { conversations: [] } }));
  });
  // 3A-2 adversarial review: authentication edges unlocked (CORS kept on the 401), recorded as-is.
  it("401 for an invalid bearer token (CORS kept)", async () => {
    await expectContract(
      "sync.bearer-bogus",
      await post({ headers: { ...ORIGIN, authorization: "Bearer bogus" }, body: { conversations: [] } }),
    );
  });
  it("401 for a lowercase bearer scheme (treated as missing, CORS kept)", async () => {
    await expectContract(
      "sync.bearer-lowercase",
      await post({ headers: { ...ORIGIN, authorization: `bearer ${USER_JWT}` }, body: { conversations: [] } }),
    );
  });
  it("401 for a Basic scheme (CORS kept)", async () => {
    await expectContract(
      "sync.auth-basic",
      await post({ headers: { ...ORIGIN, authorization: "Basic x" }, body: { conversations: [] } }),
    );
  });
  it("401 for an empty bearer token (CORS kept)", async () => {
    await expectContract(
      "sync.bearer-empty",
      await post({ headers: { ...ORIGIN, authorization: "Bearer " }, body: { conversations: [] } }),
    );
  });
  it("400 for malformed JSON", async () => {
    await expectContract("sync.malformed-json", await post({ as: "jwt", headers: ORIGIN, body: "{" }));
  });
  it("400 without a conversations array", async () => {
    await expectContract(
      "sync.no-conversations",
      await post({ as: "jwt", headers: ORIGIN, body: { sources: ["chatgpt"] } }),
    );
  });
  it("429 keeps CORS", async () => {
    setRateLimitAllowed(false);
    await expectContract("sync.rate-limited", await post({ as: "jwt", headers: ORIGIN, body: { conversations: [] } }));
  });
  it("syncs one new conversation", async () => {
    await expectContract(
      "sync.happy",
      await post({ as: "jwt", headers: ORIGIN, body: { conversations: [NEW_CONVERSATION], sources: ["chatgpt"] } }),
    );
    await expectOplog("sync.happy");
    await expectReadLog("sync.happy");
  });
});

describe("/api/conversations/manifest", () => {
  const path = "/api/conversations/manifest";
  it("OPTIONS 204 for an extension origin", async () => {
    await expectContract(
      "sync.manifest-options",
      await callRoute(manifestOPTIONS, { method: "OPTIONS", path, headers: ORIGIN }),
    );
  });
  it("OPTIONS 403 for any other origin", async () => {
    await expectContract(
      "sync.manifest-options-denied",
      await callRoute(manifestOPTIONS, { method: "OPTIONS", path, headers: { origin: "https://evil.example" } }),
    );
  });
  it("OPTIONS 403 with no Origin header", async () => {
    await expectContract(
      "sync.manifest-options-no-origin",
      await callRoute(manifestOPTIONS, { method: "OPTIONS", path }),
    );
  });
  it("401 without authorization", async () => {
    await expectContract("sync.manifest-no-auth", await callRoute(manifestGET, { path, headers: ORIGIN }));
  });
  it("401 for an lls_ key", async () => {
    await expectContract("sync.manifest-key", await callRoute(manifestGET, { path, as: "key", headers: ORIGIN }));
  });
  // 3A-2 adversarial review: authentication edges unlocked (CORS kept on the 401), recorded as-is.
  it("401 for an invalid bearer token (CORS kept)", async () => {
    await expectContract(
      "sync.manifest-bearer-bogus",
      await callRoute(manifestGET, { path, headers: { ...ORIGIN, authorization: "Bearer bogus" } }),
    );
  });
  it("401 for a lowercase bearer scheme (treated as missing, CORS kept)", async () => {
    await expectContract(
      "sync.manifest-bearer-lowercase",
      await callRoute(manifestGET, { path, headers: { ...ORIGIN, authorization: `bearer ${USER_JWT}` } }),
    );
  });
  it("401 for a Basic scheme (CORS kept)", async () => {
    await expectContract(
      "sync.manifest-auth-basic",
      await callRoute(manifestGET, { path, headers: { ...ORIGIN, authorization: "Basic x" } }),
    );
  });
  it("401 for an empty bearer token (CORS kept)", async () => {
    await expectContract(
      "sync.manifest-bearer-empty",
      await callRoute(manifestGET, { path, headers: { ...ORIGIN, authorization: "Bearer " } }),
    );
  });
  it("lists the seeded conversation", async () => {
    await expectContract("sync.manifest-happy", await callRoute(manifestGET, { path, as: "jwt", headers: ORIGIN }));
    await expectReadLog("sync.manifest-happy");
  });
  it("filters by source", async () => {
    await expectContract(
      "sync.manifest-source-claude",
      await callRoute(manifestGET, { path: `${path}?source=claude`, as: "jwt" }),
    );
  });
});

// 3A-4 lock-extend 2b: behaviours the group 2-4 adversarial reviews confirmed
// preserved but left unpinned — recorded as the code does them today.
const MOZ_ORIGIN = { origin: "moz-extension://0f0f0f0f-1111-4222-8333-444444444444" };
const EVIL_ORIGIN = { origin: "https://evil.example" };
const setConversationLimit = (limit: number) => {
  (db().tables.profiles as Record<string, unknown>[])[0].conversation_limit = limit;
};

describe("/api/sync lock-extend 2b", () => {
  const post = (o: Omit<Parameters<typeof callRoute>[1], "path">) =>
    callRoute(POST, { method: "POST", path: "/api/sync", ...o });
  const quiet = { conversations: [] };
  // getConversationQuota caches the count per user at module level (and the
  // clock is frozen), so each case here starts cold rather than inheriting
  // whatever an earlier test in this file cached.
  beforeEach(() => _clearConversationCountCacheForTest());

  it("CORS: no Origin header", async () => {
    await expectContract("sync.cors-no-origin", await post({ as: "jwt", body: quiet }));
  });
  it("CORS: a disallowed Origin", async () => {
    await expectContract("sync.cors-evil-origin", await post({ as: "jwt", headers: EVIL_ORIGIN, body: quiet }));
  });
  it("CORS: a moz-extension Origin", async () => {
    await expectContract("sync.cors-moz-origin", await post({ as: "jwt", headers: MOZ_ORIGIN, body: quiet }));
  });
  it("413 for a body over the size cap", async () => {
    const big = `{"conversations":[],"pad":"${"x".repeat(25 * 1024 * 1024)}"}`;
    await expectContract("sync.body-too-large", await post({ as: "jwt", headers: ORIGIN, body: big }));
  });
  it("400 for more conversations than the per-request cap", async () => {
    const many = Array.from({ length: 501 }, () => ({}));
    await expectContract("sync.count-cap", await post({ as: "jwt", headers: ORIGIN, body: { conversations: many } }));
  });
  it("402 when no new conversation fits under conversation_limit", async () => {
    setConversationLimit(1);
    await expectContract(
      "sync.conversation-limit",
      await post({ as: "jwt", headers: ORIGIN, body: { conversations: [NEW_CONVERSATION] } }),
    );
  });
  it("quiet 200 for a declared source with nothing new", async () => {
    await expectContract(
      "sync.quiet",
      await post({ as: "jwt", headers: ORIGIN, body: { conversations: [], sources: ["chatgpt"] } }),
    );
    await expectOplog("sync.quiet");
  });
  it("partial 200 with skipped/atLimit when only some new conversations fit", async () => {
    setConversationLimit(2);
    const second = { ...NEW_CONVERSATION, source_id: "chat-3", title: "Signup flow" };
    await expectContract(
      "sync.partial",
      await post({ as: "jwt", headers: ORIGIN, body: { conversations: [NEW_CONVERSATION, second] } }),
    );
  });
  it("429 is returned before the body is parsed", async () => {
    setRateLimitAllowed(false);
    await expectContract("sync.rate-limited-malformed", await post({ as: "jwt", headers: ORIGIN, body: "{" }));
  });
  it("500 with detail when the bulk upsert fails", async () => {
    // Two earlier `conversations` reads (quota count, existing-key lookup) pass through.
    forceError("conversations", "boundary: conversations upsert failed", 2);
    await expectContract(
      "sync.upsert-error",
      await post({ as: "jwt", headers: ORIGIN, body: { conversations: [NEW_CONVERSATION] } }),
    );
  });
});

describe("/api/conversations/manifest lock-extend 2b", () => {
  const path = "/api/conversations/manifest";
  it("CORS: no Origin header", async () => {
    await expectContract("sync.manifest-cors-no-origin", await callRoute(manifestGET, { path, as: "jwt" }));
  });
  it("CORS: a disallowed Origin", async () => {
    await expectContract(
      "sync.manifest-cors-evil-origin",
      await callRoute(manifestGET, { path, as: "jwt", headers: EVIL_ORIGIN }),
    );
  });
  it("CORS: a moz-extension Origin", async () => {
    await expectContract(
      "sync.manifest-cors-moz-origin",
      await callRoute(manifestGET, { path, as: "jwt", headers: MOZ_ORIGIN }),
    );
  });
  it("500 with detail when the conversations query fails", async () => {
    forceError("conversations", "boundary: conversations read failed");
    await expectContract("sync.manifest-db-error", await callRoute(manifestGET, { path, as: "jwt", headers: ORIGIN }));
  });
  it("pages past 1000 rows (body summarised: count, first, last)", async () => {
    db().seed(
      "conversations",
      Array.from({ length: 1000 }, (_, i) => ({
        id: `5eed0000-0000-4000-8000-${String(700000 + i).padStart(12, "0")}`,
        user_id: USER_ID,
        source: "claude",
        source_id: `page-${String(i).padStart(4, "0")}`,
        updated_at: "2025-12-02T00:00:00.000Z",
      })),
    );
    const result = await callRoute(manifestGET, { path, as: "jwt", headers: ORIGIN });
    const rows = (JSON.parse(result.body) as { conversations: unknown[] }).conversations;
    await expectContract("sync.manifest-paged", {
      ...result,
      body: JSON.stringify({ count: rows.length, first: rows[0], last: rows[rows.length - 1] }),
    });
  });
});
