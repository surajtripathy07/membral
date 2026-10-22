import { NextResponse } from "next/server";

/**
 * Same shape as the inline `NextResponse.json({ error: message }, { status })`
 * pattern repeated across app/api routes — not repointed to by any route in
 * this PR (that's G3 step 3A-4, one PR per route).
 */
export function apiError(status: number, message: string, init?: ResponseInit): NextResponse {
  return NextResponse.json({ error: message }, { status, ...init });
}
