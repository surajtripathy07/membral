// Code-session id resolution for the MCP session tools (get_code_session,
// session_summary). Agents copy the 8-char short id a prompt-recall line or
// the preamble shows (`session abcd1234`), so a unique prefix of at least
// SESSION_ID_PREFIX_MIN hex chars resolves to the full id.
//
// The lookup is user-scoped (and project-scoped for a code-scoped key): a
// prefix never matches another user's session, and an out-of-scope match is
// the same "not found" the tools already give. It is a uuid RANGE query
// (prefix padded with 0s .. padded with fs) rather than `id::text like`:
// PostgREST cannot filter on a cast, and Postgres orders uuids by their bytes,
// which is exactly the order of their lowercase hex text.

import type { Db } from "@/lib/db/types";

export const SESSION_ID_PREFIX_MIN = 8;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PREFIX_RE = /^[0-9a-f-]+$/i;

export type SessionIdResolution =
  | { ok: true; id: string }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "ambiguous"; message: string };

function asUuid(hex32: string): string {
  return `${hex32.slice(0, 8)}-${hex32.slice(8, 12)}-${hex32.slice(12, 16)}-${hex32.slice(16, 20)}-${hex32.slice(20)}`;
}

/**
 * A prefix of SESSION_ID_PREFIX_MIN..31 hex chars (dashes ignored) resolves among the user's sessions: exactly one
 * match is that id; none is not_found; two or more is `ambiguous`, naming two candidates by their first 13 chars (more if they match there).
 * Anything else (a full uuid, a shorter or non-hex string) passes through unchanged: the caller's own user-scoped
 * lookup decides whether it exists, as before.
 */
export async function resolveSessionId(
  db: Db,
  userId: string,
  idOrPrefix: string,
  codeScopeId: string | null = null,
): Promise<SessionIdResolution> {
  const raw = idOrPrefix.trim();
  if (UUID_RE.test(raw) || !PREFIX_RE.test(raw)) return { ok: true, id: idOrPrefix };
  const hex = raw.replace(/-/g, "").toLowerCase();
  if (hex.length === 32) return { ok: true, id: asUuid(hex) };
  if (hex.length < SESSION_ID_PREFIX_MIN || hex.length > 31) return { ok: true, id: idOrPrefix };

  let query = db
    .from("code_sessions")
    .select("id")
    .eq("user_id", userId)
    .gte("id", asUuid(hex.padEnd(32, "0")))
    .lte("id", asUuid(hex.padEnd(32, "f")));
  if (codeScopeId) query = query.eq("code_project_id", codeScopeId);
  const { data, error } = await query.order("id", { ascending: true }).limit(2);
  if (error) throw new Error(`code session id lookup failed: ${error.message}`);
  const ids = ((data ?? []) as { id: string }[]).map((r) => r.id);
  if (ids.length === 0) return { ok: false, reason: "not_found" };
  if (ids.length === 1) return { ok: true, id: ids[0] };
  // 13 chars = 12 hex digits plus the dash; longer when the two still match there, up to their first difference.
  let differ = 0;
  while (differ < ids[0].length && ids[0][differ] === ids[1][differ]) differ++;
  const shown = Math.max(13, differ + 1);
  return {
    ok: false,
    reason: "ambiguous",
    message: `Ambiguous session id prefix "${raw}"; candidates: ${ids.map((id) => id.slice(0, shown)).join(", ")} (first ${shown} chars each). Pass more characters or the full id.`,
  };
}
