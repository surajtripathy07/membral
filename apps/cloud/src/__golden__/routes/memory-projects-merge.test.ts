// Route contract: POST/GET /api/memory/projects/merge — the Projects facet's "Merge into..."
// action (migration 060/063/064). Cookie session; plain project_aliases table reads/writes plus
// the already-faked project_alias_seed RPC (boundary.ts's default set) — no new RPC surface
// needed.
import { describe, it, vi } from "vitest";

vi.mock("@supabase/supabase-js", async () => (await import("./boundary")).supabaseJsModule());
vi.mock("@supabase/ssr", async () => (await import("./boundary")).supabaseSsrModule());
vi.mock("next/headers", async () => (await import("./boundary")).nextHeadersModule());
vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: (await import("./boundary")).after,
}));

import { GET, POST } from "@/app/api/memory/projects/merge/route";
import { callRoute, expectContract, expectOplog, setupRouteGolden } from "./harness";

setupRouteGolden();

const post = (o: Omit<Parameters<typeof callRoute>[1], "path" | "method">) =>
  callRoute(POST, { method: "POST", path: "/api/memory/projects/merge", ...o });

describe("POST /api/memory/projects/merge", () => {
  it("401 without a session", async () => {
    await expectContract(
      "memory-projects-merge.post-no-auth",
      await post({ body: { alias: "a", canonical: "b", action: "merge" } }),
    );
  });
  it("400 for an unknown action", async () => {
    await expectContract(
      "memory-projects-merge.invalid-body",
      await post({ as: "cookie", body: { alias: "a", canonical: "b", action: "rename" } }),
    );
  });
  it("merges one alias into a canonical project", async () => {
    await expectContract(
      "memory-projects-merge.happy",
      await post({ as: "cookie", body: { alias: "acme/webapp-fork", canonical: "acme/webapp", action: "merge" } }),
    );
    await expectOplog("memory-projects-merge.happy");
  });

  // 3A-4 group 1 adversarial review lock-extend: order is auth -> body parse
  // (withRoute runs auth first), so a missing session wins over malformed JSON.
  it("401 (auth wins) for no session AND malformed JSON together", async () => {
    await expectContract("memory-projects-merge.no-auth-and-malformed-body", await post({ body: "{" }));
  });

  // This route never checks content-type; req.json() parses the body
  // regardless of the header, so a wrong content-type with an otherwise-valid
  // body succeeds like the happy path.
  it("ignores a wrong content-type when the body still parses", async () => {
    await expectContract(
      "memory-projects-merge.wrong-content-type",
      await post({
        as: "cookie",
        headers: { "content-type": "text/plain" },
        body: JSON.stringify({ alias: "acme/webapp-fork", canonical: "acme/webapp", action: "merge" }),
      }),
    );
  });
});

describe("GET /api/memory/projects/merge", () => {
  it("401 without a session", async () => {
    await expectContract(
      "memory-projects-merge.get-no-auth",
      await callRoute(GET, { path: "/api/memory/projects/merge" }),
    );
  });
  it("lists no merges for a user who hasn't made any", async () => {
    await expectContract(
      "memory-projects-merge.get-happy",
      await callRoute(GET, { path: "/api/memory/projects/merge", as: "cookie" }),
    );
  });
});
