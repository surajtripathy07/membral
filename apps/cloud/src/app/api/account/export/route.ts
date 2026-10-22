import { NextResponse } from "next/server";
import { withRoute } from "@/lib/api/route";
import { pageConversationsForExport } from "@/lib/conversations/queries";
import type { getServiceClient } from "@/lib/db/clients";
import { userBucket } from "@/lib/rate-limit";

// GET /api/account/export — issue #22 (truthfulness audit F8): the privacy
// page has always promised a cloud-side data export; this is the route that
// makes that true.
//
// Round-5 adversarial verification BLOCKER 1 (this rewrite): the original
// version buffered one big `JSON.stringify` blob built from three
// unpaginated `.select()`s. Two independent failures, either alone enough to
// break the promise on any real account:
//   (a) PostgREST's `db-max-rows` cap (1000, apps/cloud/supabase/config.toml)
//       silently truncated the conversations select — measured on
//       the maintainer's own 1352-conversation corpus, the export returned
//       exactly 1000 rows with NO error and no `truncated` flag.
//   (b) The buffered response could exceed Vercel's ~4.5MB serverless
//       response-body cap long before (a) even mattered (measured ~24MB
//       compact JSON for 1000 conversations) — `FUNCTION_PAYLOAD_TOO_LARGE`.
//
// Fix: stream NDJSON (one JSON object per line — `{"type": "profile" | ... }`)
// through a ReadableStream, paginating every table with `.range()` in pages
// of PAGE_SIZE so nothing is ever buffered in memory and no single response
// carries more than one page's rows past PostgREST at a time — this is the
// same pattern `lib/util/pagination.ts`'s `selectAllRows` documents (not
// reused directly: that helper collects everything into one array before
// returning, which is exactly the buffering this route needs to avoid; the
// route below applies the identical "fresh query per page, .range(),
// continue until a short page" logic but flushes each page to the stream as
// it arrives instead).
//
// Not the extension's separate local export (packages/extension/options.html's
// "Export All Conversations", which can only reach what THAT browser has
// synced) — this is the account's full server-side record.

export const maxDuration = 300; // apps/cloud/vercel.json mirrors this for src/app/api/account/**

const PAGE_SIZE = 200;

type SupabaseLike = ReturnType<typeof getServiceClient>;

function ndjsonLine(obj: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(obj)}\n`);
}

/**
 * Pages a select through `.range()`, calling `onRow` for every row as each
 * page arrives (never accumulating a full-table array in memory) — the
 * streaming counterpart to `lib/util/pagination.ts`'s `selectAllRows`.
 * `makePage` must build a FRESH query for each call (builders are
 * single-use) with a stable `.order()` already applied; this function
 * appends `.range(from, to)`. Emits one `{type:"error", ...}` NDJSON line
 * and stops (rather than throwing, which would only be able to surface as
 * an unhandled stream error after a 200 has already been sent) if any page
 * errors.
 */
async function streamAllRows<Row, Out>(
  controller: ReadableStreamDefaultController<Uint8Array>,
  recordType: string,
  makePage: (from: number, to: number) => PromiseLike<{ data: Row[] | null; error: { message: string } | null }>,
  mapRow: (row: Row) => Out,
): Promise<{ count: number; truncatedByError: boolean }> {
  let count = 0;
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await makePage(offset, offset + PAGE_SIZE - 1);
    if (error) {
      controller.enqueue(ndjsonLine({ type: "error", source: recordType, message: error.message }));
      return { count, truncatedByError: true };
    }
    const rows = data ?? [];
    for (const row of rows) {
      controller.enqueue(ndjsonLine({ type: recordType, ...mapRow(row) }));
      count++;
    }
    if (rows.length < PAGE_SIZE) break;
  }
  return { count, truncatedByError: false };
}

function buildExportStream(supabase: SupabaseLike, userId: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        controller.enqueue(
          ndjsonLine({
            type: "meta",
            format: "membral-account-export-ndjson-v1",
            exported_at: new Date().toISOString(),
          }),
        );

        const { data: profile, error: profileError } = await supabase
          .from("profiles")
          .select("id, email, display_name, tier, conversation_limit, created_at")
          .eq("id", userId)
          .single();
        if (profileError) {
          controller.enqueue(ndjsonLine({ type: "error", source: "profile", message: profileError.message }));
        } else if (profile) {
          controller.enqueue(ndjsonLine({ type: "profile", ...profile }));
        }

        interface RawConversationRow {
          id: string;
          source: string;
          source_id: string | null;
          title: string | null;
          model: string | null;
          messages: unknown;
          metadata: unknown;
          created_at: string;
          updated_at: string;
        }

        const conversationsResult = await streamAllRows<RawConversationRow, RawConversationRow>(
          controller,
          "conversation",
          (from, to) => pageConversationsForExport(supabase, userId, from, to),
          (row) => row,
        );

        controller.enqueue(
          ndjsonLine({
            type: "done",
            conversations: conversationsResult.count,
          }),
        );
      } catch (err) {
        controller.enqueue(
          ndjsonLine({ type: "error", source: "export", message: err instanceof Error ? err.message : String(err) }),
        );
      } finally {
        controller.close();
      }
    },
  });
}

export const GET = withRoute(
  {
    auth: { kind: "bearer", missing: "Unauthorized", invalid: "Unauthorized" },
    // Round-5 verification MED 10: a dedicated, tighter rule than the
    // reused "stats" 60/min bucket — a full-account export is measured at
    // ~24MB/1000 conversations, nowhere near "the same order of cost as
    // /api/stats" the old comment claimed. 3/hour is generous for a human
    // clicking "Export my data" and expensive for anything automated.
    rateLimit: { name: "accountExport", bucket: ({ user }) => userBucket("account-export", user.id) },
  },
  async ({ user, supabase }) => {
    const filename = `membral-export-${user.id}-${new Date().toISOString().slice(0, 10)}.ndjson`;
    const stream = buildExportStream(supabase, user.id);

    return new NextResponse(stream, {
      status: 200,
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  },
);
