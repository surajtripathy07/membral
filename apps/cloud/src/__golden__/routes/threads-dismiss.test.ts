// Route contracts: POST /api/threads/dismiss and POST/DELETE
// /api/threads/blockers/dismiss (step 0.4c). Both use the cookie-session
// client (lib/supabase/server.ts -> next/headers), so `as: "cookie"` (the
// existing harness auth kind, backed by the next/headers mock) is the right
// fake here — unlike middleware.ts, which reads request.cookies directly.
import { describe, it, vi } from "vitest";

vi.mock("@supabase/supabase-js", async () => (await import("./boundary")).supabaseJsModule());
vi.mock("@supabase/ssr", async () => (await import("./boundary")).supabaseSsrModule());
vi.mock("next/headers", async () => (await import("./boundary")).nextHeadersModule());
vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: (await import("./boundary")).after,
}));

import {
  DELETE as blockersDELETE,
  GET as blockersGET,
  POST as blockersPOST,
} from "@/app/api/threads/blockers/dismiss/route";
import { POST as dismissPOST } from "@/app/api/threads/dismiss/route";
import { setCookie } from "./boundary";
import { AUTH_COOKIE, callRoute, expectContract, expectOplog, setupRouteGolden } from "./harness";

setupRouteGolden();

// fixtures/seed.json: a code_session_issues row for ref "42" (issue), so the
// dismiss route's unknown_ref check finds it known.
const KNOWN_REF = "42";
// fixtures/seed.json: session_memories' one live (retired_at: null) blocker row.
const LIVE_BLOCKER_ID = "5eed0000-0000-4000-8000-000000000104";

const dismiss = (o: Omit<Parameters<typeof callRoute>[1], "path" | "method">) =>
  callRoute(dismissPOST, { method: "POST", path: "/api/threads/dismiss", ...o });
const blockersPost = (o: Omit<Parameters<typeof callRoute>[1], "path" | "method">) =>
  callRoute(blockersPOST, { method: "POST", path: "/api/threads/blockers/dismiss", ...o });
const blockersDelete = (o: Omit<Parameters<typeof callRoute>[1], "path" | "method">) =>
  callRoute(blockersDELETE, { method: "DELETE", path: "/api/threads/blockers/dismiss", ...o });
const blockersGet = (o: Omit<Parameters<typeof callRoute>[1], "path" | "method">) =>
  callRoute(blockersGET, { method: "GET", path: "/api/threads/blockers/dismiss", ...o });

describe("POST /api/threads/dismiss", () => {
  it("401 without a session", async () => {
    await expectContract(
      "threads-dismiss.no-auth",
      await dismiss({ body: { ref: KNOWN_REF, kind: "issue", reason: "resolved_elsewhere" } }),
    );
  });

  // 3A-2 adversarial review: an expired/invalid session cookie (getUser errors), recorded as-is.
  it("401 for an expired/invalid session cookie", async () => {
    setCookie(AUTH_COOKIE, "expired-session-jwt");
    await expectContract(
      "threads-dismiss.expired-cookie",
      await dismiss({ body: { ref: KNOWN_REF, kind: "issue", reason: "resolved_elsewhere" } }),
    );
  });

  it("400 for malformed JSON", async () => {
    await expectContract("threads-dismiss.malformed-json", await dismiss({ as: "cookie", body: "{" }));
  });

  it("400 for a body missing kind/reason", async () => {
    await expectContract("threads-dismiss.invalid-body", await dismiss({ as: "cookie", body: { ref: KNOWN_REF } }));
  });

  it("404 for a ref no session of the caller's ever touched", async () => {
    await expectContract(
      "threads-dismiss.unknown-ref",
      await dismiss({ as: "cookie", body: { ref: "999", kind: "issue", reason: "resolved_elsewhere" } }),
    );
  });

  it("dismisses a known ref", async () => {
    await expectContract(
      "threads-dismiss.ok",
      await dismiss({ as: "cookie", body: { ref: KNOWN_REF, kind: "issue", reason: "resolved_elsewhere" } }),
    );
    await expectOplog("threads-dismiss.ok");
  });

  it("a second dismissal on the same (kind, ref) refreshes it (already: true)", async () => {
    await dismiss({ as: "cookie", body: { ref: KNOWN_REF, kind: "issue", reason: "resolved_elsewhere" } });
    await expectContract(
      "threads-dismiss.already",
      await dismiss({ as: "cookie", body: { ref: KNOWN_REF, kind: "issue", reason: "not_delivery_item" } }),
    );
    await expectOplog("threads-dismiss.already");
  });
});

describe("POST /api/threads/blockers/dismiss", () => {
  it("401 without a session", async () => {
    await expectContract(
      "blockers-dismiss.no-auth",
      await blockersPost({ body: { id: LIVE_BLOCKER_ID, reason: "resolved" } }),
    );
  });

  it("400 for malformed JSON", async () => {
    await expectContract("blockers-dismiss.malformed-json", await blockersPost({ as: "cookie", body: "{" }));
  });

  it("400 for a bad reason", async () => {
    await expectContract(
      "blockers-dismiss.invalid-body",
      await blockersPost({ as: "cookie", body: { id: LIVE_BLOCKER_ID, reason: "archived" } }),
    );
  });

  it("404 for an id with no live blocker of the caller's", async () => {
    await expectContract(
      "blockers-dismiss.not-found",
      await blockersPost({ as: "cookie", body: { id: "00000000-0000-4000-8000-000000000999", reason: "resolved" } }),
    );
  });

  it("dismisses the live blocker", async () => {
    await expectContract(
      "blockers-dismiss.ok",
      await blockersPost({ as: "cookie", body: { id: LIVE_BLOCKER_ID, reason: "resolved" } }),
    );
    await expectOplog("blockers-dismiss.ok");
  });

  // 3A-4 group 1/2 adversarial review lock-extend: order is auth -> body parse
  // (withRoute runs auth first), so a missing session wins over a malformed
  // body — the 401 never gets far enough to see the body at all.
  it("401 (auth wins) for no session AND malformed JSON together", async () => {
    await expectContract("blockers-dismiss.no-auth-and-malformed-body", await blockersPost({ body: "{" }));
  });

  // parseBody's isJson() gate runs before schema validation, so a wrong
  // content-type is rejected on its own, independent of body shape.
  it("415 for a wrong content-type", async () => {
    await expectContract(
      "blockers-dismiss.wrong-content-type",
      await blockersPost({
        as: "cookie",
        headers: { "content-type": "text/plain" },
        body: JSON.stringify({ id: LIVE_BLOCKER_ID, reason: "resolved" }),
      }),
    );
  });
});

describe("GET /api/threads/blockers/dismiss", () => {
  // Exported since the route's introduction but never locked: the "N
  // dismissed" list backing Restore-after-reload.
  it("the caller's dismissed blockers, one per click", async () => {
    await blockersPost({ as: "cookie", body: { id: LIVE_BLOCKER_ID, reason: "resolved" } });
    await expectContract("blockers-dismiss.get-happy", await blockersGet({ as: "cookie" }));
  });
});

describe("DELETE /api/threads/blockers/dismiss (Undo)", () => {
  it("401 without a session", async () => {
    await expectContract("blockers-dismiss.delete-no-auth", await blockersDelete({ body: { ids: [LIVE_BLOCKER_ID] } }));
  });

  it("restores a dismissal", async () => {
    const posted = await blockersPost({ as: "cookie", body: { id: LIVE_BLOCKER_ID, reason: "resolved" } });
    const { ids } = JSON.parse(posted.body) as { ids: string[] };
    await expectContract("blockers-dismiss.delete-ok", await blockersDelete({ as: "cookie", body: { ids } }));
    await expectOplog("blockers-dismiss.delete-ok");
  });
});
