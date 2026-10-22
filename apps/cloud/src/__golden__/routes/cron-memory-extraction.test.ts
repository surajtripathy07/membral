// Route contract: GET /api/internal/cron/memory-extraction — the daily backstop that re-kicks
// chains, then derives yesterday's user_stats (W8) and nightly tool-sequence patterns (W9). Same
// CRON_SECRET auth idiom as /api/internal/cron/advance (cron-advance.test.ts): not-configured/
// forbidden/happy, no other input to validate.
//
// The fixture seed has one pending memory_extraction_queue row for the golden user, so the happy
// run's "kick" step genuinely calls triggerMemoryExtraction, which POSTs to this deployment's own
// /api/memory/extract-next over a real `fetch`. That fetch is the one external-network edge this
// route's happy path reaches — it is stubbed here to answer 202 synchronously (the real
// extract-next handler is exercised separately, by memory-extract-next.test.ts); the chain's
// actual extraction work runs only inside THAT route's own after(), never invoked from here.
// UNLOCKED BRANCH: "one chain kicked" (kicked=1), not "nothing queued".
//
// Patterns (W9) locks its own zero-LLM branch for free: PATTERN_MIN_SESSIONS is 5 and the seed
// has only 2 code_sessions for its one project, so derivePatternsNightly's candidateProjects
// filter empties out before defaultLlmFactory (and therefore any LLM client) is ever built —
// same "zero candidates" shape as goal step 3A-0's brief calls out. Stats (W8) locks its own
// zero-work branch too: RECENT_DAYS looks back 3 UTC days ending yesterday of the frozen clock
// (2025-12-29..31), and the seed's sessions are both older (Dec 20/22), so deriveOneDay's
// `sessions.length === 0` guard returns before any extra query or RPC.
import { describe, it, vi } from "vitest";

vi.mock("@supabase/supabase-js", async () => (await import("./boundary")).supabaseJsModule());
vi.mock("@supabase/ssr", async () => (await import("./boundary")).supabaseSsrModule());
vi.mock("next/headers", async () => (await import("./boundary")).nextHeadersModule());
vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: (await import("./boundary")).after,
}));

import { GET } from "@/app/api/internal/cron/memory-extraction/route";
import { callRoute, expectContract, setupRouteGolden } from "./harness";

setupRouteGolden();

const SECRET = "golden-cron-secret";

describe("GET /api/internal/cron/memory-extraction", () => {
  it("503 when CRON_SECRET isn't configured", async () => {
    await expectContract(
      "cron-memory-extraction.not-configured",
      await callRoute(GET, { path: "/api/internal/cron/memory-extraction" }),
    );
  });
  it("403 for a missing or wrong Authorization header", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    await expectContract(
      "cron-memory-extraction.forbidden",
      await callRoute(GET, {
        path: "/api/internal/cron/memory-extraction",
        headers: { authorization: "Bearer not-the-secret" },
      }),
    );
  });
  // 3A-2 adversarial review: authentication edges unlocked, recorded as-is.
  it("403 for a lowercase bearer scheme (strict header equality)", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    await expectContract(
      "cron-memory-extraction.lowercase-bearer",
      await callRoute(GET, {
        path: "/api/internal/cron/memory-extraction",
        headers: { authorization: `bearer ${SECRET}` },
      }),
    );
  });
  it("CRON_SECRET with surrounding whitespace (cronSecret() trims it)", async () => {
    vi.stubEnv("CRON_SECRET", `  ${SECRET}  `);
    const fetchMock = vi.fn(async () => new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    await expectContract(
      "cron-memory-extraction.secret-whitespace",
      await callRoute(GET, {
        path: "/api/internal/cron/memory-extraction",
        headers: { authorization: `Bearer ${SECRET}` },
      }),
    );
  });
  it("kicks the one seeded pending chain, deriving no stats or patterns for the window", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    const fetchMock = vi.fn(async () => new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    await expectContract(
      "cron-memory-extraction.happy",
      await callRoute(GET, {
        path: "/api/internal/cron/memory-extraction",
        headers: { authorization: `Bearer ${SECRET}` },
      }),
    );
  });
});
