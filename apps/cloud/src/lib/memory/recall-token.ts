// recall_token minting/verification (docs/design/memory-v1.md §4/§7).
//
// The push (GET /api/memory/preamble) mints a token; every read tool
// (memory_search/memory_recall/session_summary) echoes it back so
// memory_recall_events rows can be attributed to the session that made the
// original push call, without a server-side session table (§7: "A
// correlation id IS needed: an `lls_` key is per machine, not per session,
// so a time window cannot separate two concurrent sessions on one machine").
//
// SHAPE (documented per the brief's instruction -- "document it in a header
// comment"): the token is an HMAC-SHA256 over `{u: userId, p: projectId,
// t: mintedAt}` keyed on the service-role key (the service secret --
// server-only, already the trust root for every other service-role
// operation in this app). This makes the token STATELESS and VERIFIABLE:
// nothing is written to the database to mint one (no new table, no column
// added to any existing one -- the brief explicitly rejected stashing it in
// `memory_recall_events` since that table's `tool` check-constraint doesn't
// have a "mint" value and doing so would misuse a metrics log as a token
// store), and any request holding the token can be verified by recomputing
// the same MAC, carrying the project id and mint time inside itself. A
// token is never "revoked" -- if the underlying project or user is deleted
// the FK'd data it would resolve to simply also stops existing.
//
// Format: `v1.<base64url(json)>.<base64url(hmac)>`.
import { createHmac, timingSafeEqual } from "crypto";
import { SERVICE_ROLE_KEY_ENV, supabaseServiceRoleKey } from "@/lib/env";

const TOKEN_VERSION = "v1";

export interface RecallTokenPayload {
  userId: string;
  /** code_projects.id, or "" when no project resolved (e.g. preamble called before the repo's first session). */
  projectId: string;
  mintedAt: string; // ISO
}

function serviceSecret(): string {
  const key = supabaseServiceRoleKey();
  if (!key) throw new Error(`Missing ${SERVICE_ROLE_KEY_ENV} (recall_token secret)`);
  return key;
}

function sign(body: string): string {
  return createHmac("sha256", serviceSecret()).update(body).digest("base64url");
}

export function mintRecallToken(userId: string, projectId: string | null, mintedAt: Date = new Date()): string {
  const payload: { u: string; p: string; t: string } = { u: userId, p: projectId ?? "", t: mintedAt.toISOString() };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${TOKEN_VERSION}.${body}.${sign(body)}`;
}

/** Verifies the HMAC and shape; returns null on any malformed or forged token rather than throwing -- a bad recall_token degrades a call to "tokenless", never fails it. */
export function verifyRecallToken(token: string | undefined | null): RecallTokenPayload | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) return null;
  const [, body, mac] = parts;

  let expected: string;
  try {
    expected = sign(body);
  } catch {
    return null;
  }
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as {
      u?: unknown;
      p?: unknown;
      t?: unknown;
    };
    if (typeof payload.u !== "string" || typeof payload.t !== "string") return null;
    return { userId: payload.u, projectId: typeof payload.p === "string" ? payload.p : "", mintedAt: payload.t };
  } catch {
    return null;
  }
}
