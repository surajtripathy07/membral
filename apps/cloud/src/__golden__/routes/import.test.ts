// Route contract: POST /api/import. Bearer JWT (extension) or, since #182 (ruling D-067), an UNSCOPED
// lls_ key (the CLI); a scoped key is 403 and a bad key 401 "Invalid API key", all with x-request-id.
import { describe, it, vi } from "vitest";

vi.mock("@supabase/supabase-js", async () => (await import("./boundary")).supabaseJsModule());
vi.mock("@supabase/ssr", async () => (await import("./boundary")).supabaseSsrModule());
vi.mock("next/headers", async () => (await import("./boundary")).nextHeadersModule());
vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: (await import("./boundary")).after,
}));

import { POST } from "@/app/api/import/route";
import { POST as POST_UPLOAD } from "@/app/api/import/upload/route";
import * as boundary from "./boundary";
import { callRoute, expectContract, expectOplog, setupRouteGolden, USER_ID, USER_JWT } from "./harness";

setupRouteGolden();

const post = (o: Omit<Parameters<typeof callRoute>[1], "path">) =>
  callRoute(POST, { method: "POST", path: "/api/import", ...o });
const CONVERSATION = {
  source: "claude",
  source_id: "claude-chat-1",
  title: "Header layout",
  created_at: "2025-12-30T08:00:00.000Z",
  updated_at: "2025-12-30T08:05:00.000Z",
  model: "claude-sonnet",
  messages: [
    { role: "user", content: "Header layout ideas?", timestamp: "2025-12-30T08:00:00.000Z" },
    { role: "assistant", content: "Logo left, auth right.", timestamp: "2025-12-30T08:01:00.000Z" },
  ],
  metadata: {},
};

const CLAUDE_EXPORT_ENTRY = {
  uuid: "claude-export-conv-1",
  name: "Planning chat",
  created_at: "2025-12-30T08:00:00.000Z",
  updated_at: "2025-12-30T08:05:00.000Z",
  chat_messages: [
    { uuid: "m1", sender: "human", created_at: "2025-12-30T08:00:00.000Z", content: [{ type: "text", text: "Hello" }] },
    {
      uuid: "m2",
      sender: "assistant",
      created_at: "2025-12-30T08:01:00.000Z",
      content: [{ type: "text", text: "Hi there" }],
    },
  ],
};

describe("POST /api/import", () => {
  it("401 without authorization", async () => {
    await expectContract("import.no-auth", await post({ body: { conversations: [] } }));
  });
  it("imports with an unscoped lls_ key (#182: was 401 Invalid token)", async () => {
    await expectContract("import.key", await post({ as: "key", body: { conversations: [CONVERSATION] } }));
    await expectOplog("import.key");
    // End to end: the conversation row is stored under the key's owner.
    const owners = (boundary.db().tables.conversations ?? [])
      .filter((r) => r.source_id === CONVERSATION.source_id)
      .map((r) => r.user_id);
    if (owners.length !== 1 || owners[0] !== USER_ID) throw new Error(`owners: ${owners.join(",")}`);
  });
  it("403 for a scoped lls_ key (scoped keys are read lenses, never a write grant)", async () => {
    await expectContract(
      "import.scoped-key",
      await post({ as: "scoped-key", body: { conversations: [CONVERSATION] } }),
    );
  });
  it("401 Invalid API key for an lls_ key that matches no key", async () => {
    await expectContract("import.bad-key", await post({ as: "bad-key", body: { conversations: [] } }));
  });
  // 3A-2 adversarial review: authentication edges unlocked, recorded as-is (incl. x-request-id).
  it("401 for an invalid bearer token", async () => {
    await expectContract(
      "import.bearer-bogus",
      await post({ headers: { authorization: "Bearer bogus" }, body: { conversations: [] } }),
    );
  });
  it("401 for a lowercase bearer scheme (treated as missing)", async () => {
    await expectContract(
      "import.bearer-lowercase",
      await post({ headers: { authorization: `bearer ${USER_JWT}` }, body: { conversations: [] } }),
    );
  });
  it("401 for a Basic scheme", async () => {
    await expectContract(
      "import.auth-basic",
      await post({ headers: { authorization: "Basic x" }, body: { conversations: [] } }),
    );
  });
  it("401 for an empty bearer token", async () => {
    await expectContract(
      "import.bearer-empty",
      await post({ headers: { authorization: "Bearer " }, body: { conversations: [] } }),
    );
  });
  it("400 for malformed JSON", async () => {
    await expectContract("import.malformed-json", await post({ as: "jwt", body: "{" }));
  });
  it("400 without conversations", async () => {
    await expectContract("import.no-conversations", await post({ as: "jwt", body: { metadata: {} } }));
  });
  it("imports one conversation", async () => {
    await expectContract(
      "import.happy",
      await post({ as: "jwt", body: { conversations: [CONVERSATION], sources: ["claude"] } }),
    );
    await expectOplog("import.happy");
  });
});

const postUpload = (o: Omit<Parameters<typeof callRoute>[1], "path">) =>
  callRoute(POST_UPLOAD, { method: "POST", path: "/api/import/upload", ...o });

describe("POST /api/import/upload", () => {
  it("401 without a session", async () => {
    await expectContract("import-upload.no-auth", await postUpload({ body: "[]" }));
  });
  it("400 for an empty upload", async () => {
    await expectContract(
      "import-upload.empty",
      await postUpload({ as: "cookie", body: "", headers: { "content-length": "0" } }),
    );
  });
  it("imports one conversation from a raw Claude export", async () => {
    const body = JSON.stringify([CLAUDE_EXPORT_ENTRY]);
    await expectContract(
      "import-upload.happy",
      await postUpload({ as: "cookie", body, headers: { "content-length": String(Buffer.byteLength(body)) } }),
    );
    await expectOplog("import-upload.happy");
  });
});
