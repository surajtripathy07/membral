// Round-2 review MED 7: `/api/sync`, `/api/import`, and `/api/code-sessions`
// each guarded their body-size cap with:
//
//   const contentLength = Number(req.headers.get("content-length") ?? "0");
//   if (contentLength > MAX_BODY_BYTES) return 413;
//   const rawText = await req.text();          // buffers the WHOLE body first
//   if (rawText.length > MAX_BODY_BYTES) return 413;
//
// Both checks are bypassable: the pre-check reads a client-controlled
// header (absent -> "0", so it's skipped entirely; or the client can just
// lie), and the post-check runs only AFTER `req.text()` has already
// buffered the entire body in memory — `Transfer-Encoding: chunked` with no
// Content-Length, or a lying Content-Length, walks straight past both and
// the process buffers however much bytes the caller actually sends.
//
// `readBodyWithLimit` (originally written for /api/import/upload, extracted
// here so every route shares one implementation) counts bytes across
// STREAM CHUNKS as they arrive and cancels the reader the instant the
// running total exceeds the cap — the oversized body is never fully
// buffered, regardless of what Content-Length claimed.
export async function readBodyWithLimit(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<{ bytes: Uint8Array } | { tooLarge: true }> {
  if (!body) return { bytes: new Uint8Array(0) };

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return { tooLarge: true };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const out = new Uint8Array(total);
  let written = 0;
  for (const chunk of chunks) {
    out.set(chunk, written);
    written += chunk.byteLength;
  }
  return { bytes: out };
}

/**
 * Convenience wrapper for the common "read a JSON body under maxBytes, as
 * UTF-8 text" case — `/api/sync`, `/api/import`, and `/api/code-sessions`
 * all just want the decoded text (they JSON.parse it themselves, with
 * their own route-specific error shape on a parse failure).
 */
export async function readTextBodyWithLimit(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<{ text: string } | { tooLarge: true }> {
  const result = await readBodyWithLimit(body, maxBytes);
  if ("tooLarge" in result) return result;
  return { text: new TextDecoder("utf-8").decode(result.bytes) };
}
