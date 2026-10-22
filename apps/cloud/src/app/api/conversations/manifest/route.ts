import { type NextRequest, NextResponse } from "next/server";
import { corsPreflight } from "@/lib/api/cors";
import { withRoute } from "@/lib/api/route";
import { listConversationManifestPage } from "@/lib/conversations/queries";

const MANIFEST_CORS_METHODS = "GET, OPTIONS";

export async function OPTIONS(req: NextRequest) {
  return corsPreflight(req, MANIFEST_CORS_METHODS);
}

// withRoute sets the MANIFEST_CORS_METHODS CORS headers on every exit (auth
// failure, handler response), as withCors did by hand.
export const GET = withRoute(
  {
    auth: { kind: "bearer", missing: "Missing authorization", invalid: "Invalid token" },
    cors: { methods: MANIFEST_CORS_METHODS },
  },
  async ({ req, user, supabase }) => {
    // Optional ?source filter
    const { searchParams } = new URL(req.url);
    const sourceFilter = searchParams.get("source");

    // Query the 3 dedup columns. PostgREST caps each response at max_rows
    // (1000 by default), so page with .range() until a short page returns —
    // a single query silently truncates the manifest once a user has >1000.
    const PAGE_SIZE = 1000;
    const conversations: Array<{ source: string; source_id: string; updated_at: string }> = [];

    for (let offset = 0; ; offset += PAGE_SIZE) {
      const { data, error: dbError } = await listConversationManifestPage(
        supabase,
        user.id,
        sourceFilter,
        offset,
        offset + PAGE_SIZE - 1,
      );

      if (dbError) {
        return NextResponse.json({ error: "Database error", detail: dbError.message }, { status: 500 });
      }

      if (!data || data.length === 0) break;
      conversations.push(...data);
      if (data.length < PAGE_SIZE) break;
    }

    return NextResponse.json({ conversations });
  },
);
