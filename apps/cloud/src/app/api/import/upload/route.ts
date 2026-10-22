// POST /api/import/upload — bulk import of an official ChatGPT or Claude.ai
// data export (either the emailed .zip, or a bare conversations.json pulled
// out of it). Cookie-session auth (dashboard user), unlike /api/import's
// bearer-token auth (extension/CLI) — this route is only ever called from
// the logged-in dashboard's /import page.
//
// Reuses the EXACT SAME upsert/heartbeat/embedding/pass-1 path as
// /api/import via `ingestConversations` (apps/cloud/src/lib/import/ingest.ts)
// — no forked write logic here, only: auth, upload parsing (zip -> find
// conversations.json -> detect provider -> parse via @membral/core), and
// time-boxed batching so a very large export can't silently time out the
// request. Never sync-writes (turbo build) — see CLAUDE.md.

import { detectExportProvider, parseChatGptExport, parseClaudeExport } from "@membral/core";
import { inflateSync, unzipSync } from "fflate";
import { NextResponse } from "next/server";
import { withRoute } from "@/lib/api/route";
import { tryServiceClient } from "@/lib/db/clients";
import { readBodyWithLimit } from "@/lib/http-body";
import { findExistingConversationKeys, ingestConversations, triggerPostIngestHooks } from "@/lib/import/ingest";
import { log, requestId } from "@/lib/log";
import { userBucket } from "@/lib/rate-limit";

export const runtime = "nodejs";
/**
 * Platform request-timeout hint (seconds). Round-5 verification HIGH 5: this
 * used to be 60 — enough headroom above SOFT_DEADLINE_MS below for the
 * synchronous batch loop, but NOT enough for the `after()` callback this
 * route triggers via `triggerPostIngestHooks` (issue #132) — embed, chunk,
 * embed-chunks, `processKgPass1`, and now a full `runClaimsAdvanceForUser`
 * cycle (hash backfill up to 20 pages, pass1 up to the incremental cap,
 * claims-stage, plus `computeClaimsLag`'s full-corpus scans) all run AFTER
 * the response is sent but keep this invocation billed/alive until they
 * settle. `/api/sync` was already raised 120 -> 300 for exactly this reason
 * (see vercel.json); this route calls the SAME `triggerPostIngestHooks` and
 * was the one route whose budget didn't move with it — a large upload's
 * `after()` work could be hard-killed mid-cycle, leaving the per-user
 * advance lock held (stale after 900s, `lib/kg/queue.ts`) and every other
 * post-sync/self-advance kick for that user refused as `already_running` for
 * up to 15 minutes. Matches `src/app/api/sync/**` and `apps/cloud/vercel.json`.
 */
export const maxDuration = 300;

/** Hard cap from the goal spec — rejected with 413 before any parsing work happens.
 * This bounds the UPLOADED bytes (compressed, for a zip) — the JSON a zip
 * inflates to is bounded separately by MAX_ENTRY_UNCOMPRESSED_BYTES below. */
const MAX_UPLOAD_BYTES = 300 * 1024 * 1024;
/**
 * Cap on a single zip entry's DECLARED uncompressed size, checked via the
 * central-directory info fflate's unzip `filter` callback receives —
 * BEFORE any inflation happens. Without this, a small (even innocuous)
 * zip whose central directory claims a huge uncompressed size would be
 * decompressed synchronously in full, freezing the process (H7).
 */
const MAX_ENTRY_UNCOMPRESSED_BYTES = 512 * 1024 * 1024;
/** Ingest batch size for this route (the goal spec's "batches of 100"). */
const CHUNK_SIZE = 100;
/**
 * Soft time budget for one request's batch loop. Comfortably under the
 * common ~60s platform request timeout — once exceeded, the loop stops
 * between chunks (never mid-chunk, and only ever AFTER at least one chunk
 * has landed — see the loop below) and reports {partial: true, nextOffset}
 * so the client can re-POST the same file with `?offset=nextOffset` to pick
 * up where it left off, rather than the request being killed mid-flight
 * with no progress recorded.
 */
const SOFT_DEADLINE_MS = 50_000;

// readBodyWithLimit moved to @/lib/http-body (round-2 review MED 7) — shared
// with /api/sync, /api/import, and /api/code-sessions now.

function isZip(bytes: Uint8Array, filename: string | null, contentType: string | null): boolean {
  // ZIP local-file-header magic ("PK\x03\x04") — the reliable signal;
  // filename/content-type are only a fallback for the (empty-zip / weird
  // client) edge case where the magic bytes might not be the first thing.
  if (bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b) return true;
  if (filename?.toLowerCase().endsWith(".zip")) return true;
  if (contentType?.includes("zip")) return true;
  return false;
}

function findConversationsEntryName(unzipped: Record<string, Uint8Array>): string | null {
  return Object.keys(unzipped).find((k) => k.toLowerCase().endsWith("conversations.json")) ?? null;
}

const oversizeError = (declaredBytes: number) =>
  `conversations.json inside the zip is too large to process (${Math.floor(declaredBytes / (1024 * 1024))}MB uncompressed, max ${Math.floor(MAX_ENTRY_UNCOMPRESSED_BYTES / (1024 * 1024))}MB) — unzip and split the export, or upload a smaller conversations.json.`;

/**
 * Fallback for exports with >= 65,536 entries (ZIP64): fflate's unzipSync
 * has no ZIP64 fallback — when the central directory's entry count
 * overflows its 16-bit field, fflate parses zero entries and we'd
 * otherwise report a misleading "No conversations.json found" (H8).
 *
 * Local-file headers (magic "PK\x03\x04") don't depend on the central
 * directory, so we scan the raw bytes for one whose filename ends in
 * conversations.json and inflate just that entry directly.
 */
function scanRawZipForConversationsJson(bytes: Uint8Array): { json: unknown } | { error: string } | null {
  const decoder = new TextDecoder("utf-8");
  const nameDecoder = new TextDecoder("ascii");

  for (let offset = 0; offset + 30 <= bytes.length; offset++) {
    // Fast-path byte check before touching DataView — this loop runs over
    // the entire (potentially hundreds-of-MB) buffer in the common
    // (non-match) case.
    if (
      bytes[offset] !== 0x50 ||
      bytes[offset + 1] !== 0x4b ||
      bytes[offset + 2] !== 0x03 ||
      bytes[offset + 3] !== 0x04
    ) {
      continue;
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 30);
    const compressionMethod = view.getUint16(8, true);
    const compressedSize = view.getUint32(18, true);
    const uncompressedSize = view.getUint32(22, true);
    const nameLength = view.getUint16(26, true);
    const extraLength = view.getUint16(28, true);
    const nameStart = offset + 30;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > bytes.length) continue;

    const name = nameDecoder.decode(bytes.subarray(nameStart, nameEnd));
    if (!name.toLowerCase().endsWith("conversations.json")) continue;

    // 0xFFFFFFFF marks a ZIP64 extra-field size (or a streamed entry using
    // a trailing data descriptor) — the real size isn't in this fixed
    // header. We don't parse the ZIP64 extra field; treat as unreadable.
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) return null;
    if (uncompressedSize > MAX_ENTRY_UNCOMPRESSED_BYTES) return { error: oversizeError(uncompressedSize) };

    const dataStart = nameEnd + extraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > bytes.length) continue;
    const compressed = bytes.subarray(dataStart, dataEnd);

    try {
      // H7 REGRESSION FIX (round-2 review): a declared uncompressedSize of 0
      // used to skip the `out` bound entirely (`undefined` options), letting
      // fflate grow the output buffer with no ceiling — an attacker who lies
      // about uncompressedSize (declares 0 while compressedSize correctly
      // points at real, large compressed bytes; general-purpose bit 3 /
      // data-descriptor entries can legitimately have a 0 in this field) gets
      // an unbounded inflate, i.e. a zip-bomb DoS. Always pass a bounded `out`
      // buffer — the declared size when it's usable (and already checked
      // above against the cap), otherwise the cap itself — so a lying header
      // can never grow the inflate past MAX_ENTRY_UNCOMPRESSED_BYTES.
      //
      // H7 SHORT-READ (round-3 review): passing a fixed-size `out` does NOT
      // make fflate throw once inflated content would exceed it — fflate's
      // `resize` flag is false for a caller-supplied buffer, so writes past
      // `out.length` are silently dropped by the typed array (no exception),
      // and the returned `subarray(0, bt)` then clamps to `out.length`
      // either way. That means a lying header can produce an `inflated`
      // whose length silently equals the (wrong) declared size on the
      // overflow side. The direction we CAN detect cheaply is the other one
      // — actual decompressed content shorter than declared — so when the
      // header declares a nonzero uncompressedSize, require the inflate to
      // have actually produced exactly that many bytes; a short read means
      // the entry is truncated/corrupt and must not be treated as valid
      // JSON input.
      const outCap = uncompressedSize > 0 ? uncompressedSize : MAX_ENTRY_UNCOMPRESSED_BYTES;
      const inflated = compressionMethod === 0 ? compressed : inflateSync(compressed, { out: new Uint8Array(outCap) });
      if (uncompressedSize > 0 && inflated.length !== uncompressedSize) {
        return { error: "zip entry size mismatch" };
      }
      if (inflated.length > MAX_ENTRY_UNCOMPRESSED_BYTES) return { error: oversizeError(inflated.length) };
      return { json: JSON.parse(decoder.decode(inflated)) };
    } catch (err) {
      return {
        error: `Could not read conversations.json inside the zip: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  return null;
}

/**
 * Pull the parsed `conversations.json` payload out of the raw upload bytes —
 * a zip (only the conversations.json entry is actually decompressed, via
 * fflate's filter option, which also lets us reject an entry whose
 * DECLARED uncompressed size exceeds our cap before inflating it at all —
 * H7; every other export file — user.json, chat.html, media — is skipped
 * rather than decompressed, since we never read them) or a bare .json file
 * uploaded directly.
 */
function extractExportJson(
  bytes: Uint8Array,
  filename: string | null,
  contentType: string | null,
): { json: unknown } | { error: string } {
  const decoder = new TextDecoder("utf-8");

  if (isZip(bytes, filename, contentType)) {
    let unzipped: Record<string, Uint8Array>;
    let entriesSeen = 0;
    let rejectedForSize: number | null = null;
    // Declared uncompressed size from the central-directory info the filter
    // closure receives, keyed by entry name — captured here so it can be
    // compared against what unzipSync actually produced (below), against
    // the SAME entry findConversationsEntryName picks. A single scalar used to
    // be overwritten by every accepted entry, so a zip containing BOTH a
    // macOS Finder AppleDouble sidecar (e.g. `__MACOSX/._conversations.json`
    // — its name also ends in "conversations.json") and the real
    // `conversations.json` would have the sidecar's size silently clobber
    // the real entry's declared size, and the real entry would then be
    // rejected below as a "size mismatch" even though it's fine. Skipping
    // AppleDouble/`__MACOSX/` entries in the filter (below) avoids this in
    // the common case, but keying by name is the actual fix — it stays
    // correct even if some other zip writer produces two legitimately
    // differently-named-but-matching entries.
    const declaredSizes = new Map<string, number>();
    try {
      unzipped = unzipSync(bytes, {
        filter: (file) => {
          entriesSeen++;
          // Skip macOS Finder's AppleDouble sidecar files — when a .zip is
          // built (or re-zipped) on macOS, every real file can get a
          // shadow entry under `__MACOSX/` whose basename is `._<name>`
          // and whose content is Finder metadata, not the real file. Its
          // name still ends in "conversations.json" so it would otherwise
          // match the name filter below.
          const lower = file.name.toLowerCase();
          if (lower.startsWith("__macosx/")) return false;
          const basename = file.name.slice(file.name.lastIndexOf("/") + 1);
          if (basename.startsWith("._")) return false;
          if (!lower.endsWith("conversations.json")) return false;
          if (file.originalSize > MAX_ENTRY_UNCOMPRESSED_BYTES) {
            rejectedForSize = file.originalSize;
            return false;
          }
          declaredSizes.set(file.name, file.originalSize);
          return true;
        },
      });
    } catch (err) {
      return { error: `Could not read the zip file: ${err instanceof Error ? err.message : String(err)}` };
    }

    if (rejectedForSize !== null) return { error: oversizeError(rejectedForSize) };

    const entryName = findConversationsEntryName(unzipped);
    const entry = entryName ? unzipped[entryName] : null;
    if (entry && entryName) {
      if (entry.length > MAX_ENTRY_UNCOMPRESSED_BYTES) return { error: oversizeError(entry.length) };
      const declaredSize = declaredSizes.get(entryName) ?? null;
      // One-directional guard: this only catches the entry coming out
      // SHORTER than declared (a short/truncated inflate). A declared size
      // smaller than the actual content isn't caught here — fflate's
      // `unzipSync` (unlike our bounded raw-scan fallback below) doesn't
      // give us a way to cap output by the declared size mid-inflate, so an
      // over-long entry just decodes as-is and any resulting corruption is
      // caught downstream by JSON.parse failing. Acceptable: the entry is
      // still bounded by MAX_ENTRY_UNCOMPRESSED_BYTES above regardless of
      // what was declared.
      if (declaredSize !== null && declaredSize !== 0 && entry.length !== declaredSize) {
        return { error: "zip entry size mismatch" };
      }
      let text: string;
      try {
        text = decoder.decode(entry);
      } catch {
        return {
          error:
            "conversations.json inside the zip is too large to process in one pass — unzip and split the export, or upload conversations.json directly.",
        };
      }
      try {
        return { json: JSON.parse(text) };
      } catch {
        return { error: "conversations.json inside the zip is not valid JSON." };
      }
    }

    if (entriesSeen === 0 || entriesSeen >= 0xffff) {
      // fflate has no real ZIP64 fallback: when the archive's End Of
      // Central Directory record reports its entry count as 0 (some
      // writers do this once the count overflows into the ZIP64 EOCD
      // record) it bails out before ever calling our filter (entriesSeen
      // stays 0); if it reports the truncated 16-bit sentinel 0xFFFF, our
      // filter is called exactly that many times and conversations.json
      // may sit past the entries fflate actually walked. Either way, fall
      // back to a raw scan for the local-file header before giving up.
      const fallback = scanRawZipForConversationsJson(bytes);
      if (fallback) return fallback;
      return {
        error:
          "This export has too many entries (ZIP64) for us to read directly — unzip it yourself and upload conversations.json instead.",
      };
    }

    return { error: "No conversations.json found inside the zip." };
  }

  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch {
    return {
      error:
        "Uploaded file is too large to process in one pass — unzip and split the export, or upload a smaller conversations.json.",
    };
  }
  try {
    return { json: JSON.parse(text) };
  } catch {
    return { error: "Uploaded file is not valid JSON (and doesn't look like a zip)." };
  }
}

// Cookie-session auth; the 401 carries x-request-id (withRoute requestId).
// NEW-10 (round-2 review): this route had no rate limit at all — every
// other write-path route in this codebase does. Per-user (cookie-session
// auth'd, so user_id is always known here) rather than per-IP.
export const POST = withRoute(
  {
    auth: { kind: "session", unauthorized: "unauthorized" },
    requestId: true,
    rateLimit: { name: "importUpload", bucket: ({ user }) => userBucket("importUpload", user.id) },
  },
  async ({ req, user, supabase: cookieSupabase, rid: routeRid }) => {
    const rid = routeRid ?? requestId(req);
    const rlog = log.withContext({ request_id: rid, route: "/api/import/upload", user_id: user.id });
    const hdrs = { "x-request-id": rid };

    // Writes go through the service-role client (same as /api/import) so RLS
    // never gates the bulk upsert; falls back to the cookie client (RLS still
    // scopes correctly for owner-policy tables) if env vars are somehow
    // missing, matching /api/sync-state's graceful-degrade posture.
    const supabase = tryServiceClient() ?? cookieSupabase;

    // MED (round-3 review): a `content-length` header is REQUIRED on this
    // route, not just checked when present. A request with no content-length
    // (e.g. `Transfer-Encoding: chunked`) used to sail past the old
    // `Number(... ?? "0")` check — which silently treated "missing" the same
    // as "declared 0" — and then got fully buffered via `arrayBuffer()`/
    // `formData()` before any size check ever ran, so an unbounded chunked
    // body would be materialized in full regardless of MAX_UPLOAD_BYTES.
    // Requiring the header up front closes that gap for the common case; the
    // streaming read below (with a running byte counter) is the actual
    // enforcement, since a header can still lie about the real body size.
    const contentLengthHeader = req.headers.get("content-length");
    if (contentLengthHeader === null || !/^\d+$/.test(contentLengthHeader)) {
      return NextResponse.json({ error: "content-length required" }, { status: 400, headers: hdrs });
    }
    const contentLength = Number(contentLengthHeader);
    if (contentLength > MAX_UPLOAD_BYTES) {
      return NextResponse.json(
        { error: `File too large — max ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))}MB` },
        { status: 413, headers: hdrs },
      );
    }

    const url = new URL(req.url);
    let offset = Math.max(0, Number.parseInt(url.searchParams.get("offset") ?? "0", 10) || 0);

    let bytes: Uint8Array;
    let filename: string | null = null;
    const contentType = req.headers.get("content-type");

    try {
      // Streamed with a running byte counter (readBodyWithLimit) instead of
      // `req.arrayBuffer()`/`req.formData()` — the latter buffer the ENTIRE
      // body before we ever get to look at its size, so a body larger than
      // declared (or larger than MAX_UPLOAD_BYTES with a lying/absent
      // declaration) would be fully materialized in memory first and only
      // rejected after the fact. This applies to BOTH branches below — a
      // multipart upload is parsed from these already-capped bytes (via
      // `Response#formData()`), never from `req.formData()` directly, so the
      // cap is enforced before any materialization on either branch.
      const streamed = await readBodyWithLimit(req.body, MAX_UPLOAD_BYTES);
      if ("tooLarge" in streamed) {
        return NextResponse.json(
          { error: `File too large — max ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))}MB` },
          { status: 413, headers: hdrs },
        );
      }

      if (contentType?.includes("multipart/form-data")) {
        // Re-parse the multipart structure from the capped, already-in-memory
        // bytes — `Response#formData()` supports this in Node/undici — rather
        // than calling `req.formData()` on the live request stream, which
        // would materialize the whole body itself with no cap.
        const form = await new Response(streamed.bytes as BodyInit, {
          headers: { "content-type": contentType },
        }).formData();
        const file = form.get("file");
        if (!(file instanceof File)) {
          return NextResponse.json({ error: "Missing 'file' in multipart body" }, { status: 400, headers: hdrs });
        }
        filename = file.name;
        bytes = new Uint8Array(await file.arrayBuffer());
        const offsetField = form.get("offset");
        if (typeof offsetField === "string" && !url.searchParams.has("offset")) {
          offset = Math.max(0, Number.parseInt(offsetField, 10) || 0);
        }
      } else {
        // Raw body upload — either a zip or a bare JSON file, sent directly
        // (no multipart wrapper).
        bytes = streamed.bytes;
      }
    } catch (err) {
      rlog.error("upload: failed to read request body", { err: err instanceof Error ? err.message : String(err) });
      return NextResponse.json({ error: "Failed to read upload body" }, { status: 400, headers: hdrs });
    }

    if (bytes.byteLength === 0) {
      return NextResponse.json({ error: "Empty upload" }, { status: 400, headers: hdrs });
    }
    if (bytes.byteLength > MAX_UPLOAD_BYTES) {
      return NextResponse.json(
        { error: `File too large — max ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))}MB` },
        { status: 413, headers: hdrs },
      );
    }

    const extracted = extractExportJson(bytes, filename, contentType);
    if ("error" in extracted) {
      return NextResponse.json({ error: extracted.error }, { status: 400, headers: hdrs });
    }

    const provider = detectExportProvider(extracted.json);
    if (!provider) {
      return NextResponse.json(
        { error: "Unrecognized export format — expected a ChatGPT or Claude.ai conversations.json export." },
        { status: 400, headers: hdrs },
      );
    }

    const { conversations, skipped } =
      provider === "chatgpt" ? parseChatGptExport(extracted.json) : parseClaudeExport(extracted.json);
    const total = conversations.length + skipped.length;

    // Clock starts here — AFTER the upload body has been read and fully
    // parsed (formData/unzip/JSON.parse), not before (B1). Starting it
    // earlier meant a slow/large upload could burn the entire SOFT_DEADLINE_MS
    // budget before the batch loop below ever got to run a single chunk,
    // leaving `processed` at 0 and nextOffset === offset — the client would
    // then re-POST the identical file forever, making zero progress.
    const startedAt = Date.now();

    if (offset >= conversations.length) {
      return NextResponse.json(
        {
          provider,
          total,
          conversationsTotal: conversations.length,
          imported: 0,
          updated: 0,
          skipped: skipped.slice(0, 20),
          skippedCount: skipped.length,
          errors: [],
          durationMs: Date.now() - startedAt,
          partial: false,
        },
        { headers: hdrs },
      );
    }

    const deadline = startedAt + SOFT_DEADLINE_MS;
    let imported = 0;
    let updated = 0;
    const errors: string[] = [];
    let processed = 0;
    let partial = false;
    // Round-2 review HIGH 3: this route deliberately does NOT set
    // `enforceQuota: true` (see the comment on IngestOptions.enforceQuota) —
    // migration 078's DB trigger enforces conversation_limit atomically at
    // the DB layer regardless of that app-level flag, so every insert here
    // is still bounded; these two just surface it in the response the same
    // way /api/sync and /api/import do.
    let quotaSkippedTotal = 0;
    let quotaInfo: { limit: number; count: number } | undefined;

    for (let i = offset; i < conversations.length; i += CHUNK_SIZE) {
      const chunk = conversations.slice(i, i + CHUNK_SIZE);
      // Read-only, before the upsert lands, purely for the imported/updated
      // split in the response — never gates or blocks the actual write below.
      // `degraded` is fine to ignore here (cosmetic split only, per
      // findExistingConversationKeys' own doc comment).
      const { keys: existingKeys } = await findExistingConversationKeys(supabase, user.id, chunk, rlog);
      const {
        errors: chunkErrors,
        failedKeys,
        quotaSkippedKeys,
        quota: chunkQuota,
      } = await ingestConversations(supabase, user.id, chunk, {
        batchSize: CHUNK_SIZE,
        skipPostIngestHooks: true,
        rlog,
      });
      errors.push(...chunkErrors);
      if (chunkQuota) quotaInfo = chunkQuota;

      // NEW-2 (round-2 review): ingestConversations already retries every row
      // in this chunk individually on a batch failure and isolates whichever
      // ones still fail into `failedKeys` (with their own reason in
      // chunkErrors) — so by the time we get here EVERY conversation in this
      // chunk has been attempted, one way or the other. Previously this loop
      // only advanced `processed`/nextOffset when the WHOLE chunk succeeded
      // (`chunkImported === chunk.length`), which meant a single poison row
      // Postgres would always reject (e.g. an embedded NUL byte) turned into
      // an infinite retry loop: the client kept re-POSTing the same offset,
      // the same poison row kept failing, and the 99 good rows next to it
      // kept getting silently re-attempted forever without the import ever
      // completing. The write is idempotent (onConflict), so re-landing an
      // already-succeeded row on a later chunk is harmless — but re-fetching
      // and re-parsing the ENTIRE upload just to retry one bad row never was.
      // Always advance past the whole chunk; a failed row is recorded in
      // `errors`/`skipped`-adjacent reporting, never silently dropped, and
      // never blocks the rest of the import.
      const failedSet = new Set(failedKeys);
      // HIGH 3 fix: a row migration 078's trigger rejected for
      // conversation_limit landed nowhere — not imported, not updated, and
      // (deliberately) not in `errors` either (see ingestConversations'
      // classification). Exclude before the imported/updated split below,
      // same treatment as a genuinely failed row.
      const quotaSkippedSet = new Set(quotaSkippedKeys ?? []);
      quotaSkippedTotal += quotaSkippedKeys?.length ?? 0;
      for (const c of chunk) {
        const key = `${c.source}:${c.source_id}`;
        if (failedSet.has(key) || quotaSkippedSet.has(key)) continue;
        if (existingKeys.has(key)) updated++;
        else imported++;
      }
      processed += chunk.length;

      // Checked at the BOTTOM of the loop body (B1) — so the first chunk
      // always lands regardless of how long parsing the upload took, and the
      // deadline only ever stops the loop BETWEEN chunks, never mid-chunk and
      // never before any chunk has run.
      if (Date.now() > deadline) {
        partial = true;
        break;
      }
    }

    const nextOffset = offset + processed;

    // Fire once per HTTP call (not once per chunk) — same cadence /api/import
    // uses per request.
    if (imported + updated > 0) {
      triggerPostIngestHooks(supabase, user.id, imported + updated, rlog);
    }

    return NextResponse.json(
      {
        provider,
        total,
        // The batch loop's progress denominator — bounded the same way
        // `processed`/nextOffset are (by conversations.length, not `total`,
        // which also includes never-processed skipped entries) so a progress
        // bar computed from these two fields actually reaches 100% (L10).
        conversationsTotal: conversations.length,
        imported,
        updated,
        skipped: skipped.slice(0, 20),
        skippedCount: skipped.length,
        errors: errors.slice(0, 20),
        durationMs: Date.now() - startedAt,
        partial,
        // HIGH 3 fix (round-2 review): rows migration 078's DB trigger
        // rejected for conversation_limit — distinct from the parse-level
        // `skipped`/`skippedCount` above (malformed export entries).
        conversationLimitSkipped: quotaSkippedTotal,
        atLimit: quotaSkippedTotal > 0,
        ...(quotaInfo ? { conversationLimit: quotaInfo } : {}),
        ...(partial ? { nextOffset } : {}),
      },
      { headers: hdrs },
    );
  },
);
