import { NextResponse } from "next/server";
import { withRoute } from "@/lib/api/route";
import { userBucket } from "@/lib/rate-limit";
import type { SearchLane, SearchOptions } from "@/lib/search";
import { searchConversations } from "@/lib/search";

const VALID_MODES = ["hybrid", "keyword", "semantic"] as const;
type SearchMode = (typeof VALID_MODES)[number];

// ADR 0039 (W6/D7 follow-up) — same lane contract as the conversations list
// and the Memory browser. Default is 'all' (goal 2026-08-27 D6 fix,
// migration 071 rev-2 / #106): the vector RPC now applies lane BEFORE its
// LIMIT (adversarial round 1 F2), so a lane-filtered request never comes
// back short — but D6's own truth query is unlaned, and /memories already
// defaults to All under ADR 0039's ratification, so 'all' is the consistent
// default here too. One-line default; the maintainer may reverse it.
const VALID_LANES = ["all", "chat", "code"] as const;

export const GET = withRoute(
  {
    // 1. Auth
    auth: { kind: "bearer", missing: "Missing authorization", invalid: "Invalid token" },
    // 1b. Rate limit (per user) before any embed/search work.
    rateLimit: { name: "search", bucket: ({ user }) => userBucket("search", user.id) },
  },
  async ({ req, user }) => {
    // 2. Parse query params
    const { searchParams } = new URL(req.url);
    const query = searchParams.get("q");

    if (!query || !query.trim()) {
      return NextResponse.json({ error: "Missing required query parameter: q" }, { status: 400 });
    }

    const modeParam = searchParams.get("mode") || "hybrid";
    if (!VALID_MODES.includes(modeParam as SearchMode)) {
      return NextResponse.json({ error: `Invalid mode: must be one of ${VALID_MODES.join(", ")}` }, { status: 400 });
    }
    const mode = modeParam as SearchMode;

    const limitParam = searchParams.get("limit");
    const limit = limitParam ? Math.min(Math.max(parseInt(limitParam, 10), 1), 50) : 10;

    const laneParam = searchParams.get("lane") ?? "all";
    if (!VALID_LANES.includes(laneParam as SearchLane)) {
      return NextResponse.json({ error: `Invalid lane: must be one of ${VALID_LANES.join(", ")}` }, { status: 400 });
    }
    const lane = laneParam as SearchLane;

    // 3. Search
    const options: SearchOptions = { query: query.trim(), mode, limit, lane };

    try {
      const results = await searchConversations(user.id, options);

      return NextResponse.json({
        results,
        query: query.trim(),
        mode,
        lane,
        count: results.length,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return NextResponse.json({ error: "Search failed", detail: message }, { status: 500 });
    }
  },
);
