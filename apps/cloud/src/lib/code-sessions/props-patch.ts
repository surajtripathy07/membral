// Atomic key-level writes to code_sessions.props (migration 109).
//
// code_sessions.props has several writers (the importer, memory extraction's
// checkpoint and lease lock). Writing the whole object back from an earlier
// read loses whatever another writer set in between, so every writer patches
// only its own keys: `props = (props - remove) || set`, in one statement.
// `expect` makes it conditional: applied only while props contains `expect`
// (jsonb `@>`), e.g. release a lease lock only while it is still ours.
import type { Db } from "@/lib/db/types";
/** Returns whether the row was patched (false: no such row of this user's, or `expect` did not hold). */
export async function patchCodeSessionProps(
  supabase: Db,
  userId: string,
  sessionId: string,
  set: Record<string, unknown>,
  remove: readonly string[] = [],
  expect: Record<string, unknown> | null = null,
): Promise<boolean> {
  const { data, error } = await supabase.rpc("code_session_props_patch", {
    p_user_id: userId,
    p_session_id: sessionId,
    p_set: set,
    p_remove: [...remove],
    p_expect: expect,
  });
  if (error) throw new Error(`code_session_props_patch failed: ${error.message}`);
  return data === true;
}
