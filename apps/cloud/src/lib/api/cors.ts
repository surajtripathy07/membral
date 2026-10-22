import { type NextRequest, NextResponse } from "next/server";

// Extracted verbatim (G3 step 3A-1) from the two duplicated blocks in
// app/api/sync/route.ts and app/api/conversations/manifest/route.ts — same
// origin patterns, same header names/values/casing/order, same OPTIONS
// status codes. The only difference between the two call sites was the
// `Access-Control-Allow-Methods` value, which callers now pass in.
const ALLOWED_ORIGIN_PATTERNS = [/^chrome-extension:\/\/[a-p]{32}$/, /^moz-extension:\/\/[0-9a-f-]{36}$/];

export function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) return false;
  return ALLOWED_ORIGIN_PATTERNS.some((re) => re.test(origin));
}

export function corsHeaders(origin: string | null, methods: string): Record<string, string> {
  if (!isAllowedOrigin(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin as string,
    Vary: "Origin",
    "Access-Control-Allow-Methods": methods,
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

export function withCors(res: NextResponse, origin: string | null, methods: string): NextResponse {
  for (const [k, v] of Object.entries(corsHeaders(origin, methods))) res.headers.set(k, v);
  return res;
}

/** Shared OPTIONS handler body: 403 (no body) for a missing/disallowed Origin, else 204 with CORS headers. */
export function corsPreflight(req: NextRequest, methods: string): NextResponse {
  const origin = req.headers.get("origin");
  if (!isAllowedOrigin(origin)) {
    return new NextResponse(null, { status: 403 });
  }
  return new NextResponse(null, { status: 204, headers: corsHeaders(origin, methods) });
}
