// Route contract: POST /api/memory/extract-next — one link of the memory extraction chain
// (extraction-trigger.ts), authenticated by a server-only bearer token HMAC-derived from
// SUPABASE_SERVICE_ROLE_KEY (never a user session or API key) rather than the cookie/JWT idiom
// most other routes use. The real work (claim one session, extract, POST the next link) is
// deferred into after(), which the harness records and never runs — so the happy 202 locks the
// route's own auth + validation + accept contract without ever reaching the LLM extraction path
// or a real chained fetch. UNLOCKED BRANCH: "accepted, work deferred" (afterCalls: 1).
import { createHmac } from "node:crypto";
import { describe, it, vi } from "vitest";

vi.mock("@supabase/supabase-js", async () => (await import("./boundary")).supabaseJsModule());
vi.mock("@supabase/ssr", async () => (await import("./boundary")).supabaseSsrModule());
vi.mock("next/headers", async () => (await import("./boundary")).nextHeadersModule());
vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: (await import("./boundary")).after,
}));

import { POST } from "@/app/api/memory/extract-next/route";
import { callRoute, expectContract, setupRouteGolden, USER_ID } from "./harness";

setupRouteGolden();

// Mirrors memoryWorkerToken() (lib/memory/extraction-trigger.ts): HMAC-SHA256 of a fixed label,
// keyed on SUPABASE_SERVICE_ROLE_KEY (GOLDEN_ENV's "golden-service-key").
const TOKEN = createHmac("sha256", "golden-service-key").update("membral:memory-extract-next:v1").digest("hex");

const post = (o: Omit<Parameters<typeof callRoute>[1], "path" | "method">) =>
  callRoute(POST, { method: "POST", path: "/api/memory/extract-next", ...o });

describe("POST /api/memory/extract-next", () => {
  it("503 when SUPABASE_SERVICE_ROLE_KEY isn't configured", async () => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    await expectContract(
      "memory-extract-next.not-configured",
      await post({ headers: { authorization: `Bearer ${TOKEN}` }, body: { userId: USER_ID } }),
    );
  });
  it("403 for a missing or wrong worker token", async () => {
    await expectContract(
      "memory-extract-next.forbidden",
      await post({ headers: { authorization: "Bearer not-the-token" }, body: { userId: USER_ID } }),
    );
  });
  it("400 for a body that isn't { userId: uuid }", async () => {
    await expectContract(
      "memory-extract-next.invalid-body",
      await post({ headers: { authorization: `Bearer ${TOKEN}` }, body: { userId: "not-a-uuid" } }),
    );
  });
  it("202 accepted, deferring the actual step to after()", async () => {
    await expectContract(
      "memory-extract-next.happy",
      await post({ headers: { authorization: `Bearer ${TOKEN}` }, body: { userId: USER_ID } }),
    );
  });
});
