// The stub's persistence: auth.users and auth.refresh_tokens, reached through the service_role-only
// public.local_auth_* RPCs in supabase/local/auth-prelude.sql (the app talks to Postgres only via PostgREST).
import type { Db } from "@/lib/db/types";

export interface AuthUserRow {
  id: string;
  email: string | null;
  aud: string;
  role: string;
  email_confirmed_at: string | null;
  phone: string;
  last_sign_in_at: string | null;
  banned_until?: string | null;
  raw_app_meta_data: Record<string, unknown>;
  raw_user_meta_data: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  /** Present only from findByEmail (the password check needs it). */
  encrypted_password?: string | null;
}

export type RevokeScope = "global" | "local" | "others";

export interface AuthStore {
  findByEmail(email: string): Promise<AuthUserRow | null>;
  findById(id: string): Promise<AuthUserRow | null>;
  list(page: number, perPage: number): Promise<{ users: AuthUserRow[]; total: number }>;
  create(input: {
    email: string;
    passwordHash: string;
    userMetadata: Record<string, unknown>;
    confirmed: boolean;
  }): Promise<AuthUserRow | "email_exists">;
  recordSignIn(userId: string): Promise<void>;
  insertRefresh(input: { token: string; userId: string; sessionId: string; parent: string | null }): Promise<void>;
  /**
   * Rotates a refresh token: marks it used and inserts `newToken` as its child. Within the 10 s reuse interval a
   * spent token returns its live child's token instead (parallel refreshes share one session); outside it, the
   * token's family is revoked. Null when unknown, expired, or reused: the user must sign in again.
   */
  rotateRefresh(
    token: string,
    newToken: string,
  ): Promise<{ userId: string; sessionId: string | null; token: string } | null>;
  revoke(userId: string, scope: RevokeScope, sessionId: string | null): Promise<void>;
}

async function rpc<T>(db: Db, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await db.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data as T;
}

export function createRpcStore(db: Db): AuthStore {
  return {
    findByEmail: (email) => rpc(db, "local_auth_find_user", { p_email: email, p_with_hash: true }),
    findById: (id) => rpc(db, "local_auth_find_user", { p_id: id }),
    list: (page, perPage) => rpc(db, "local_auth_list_users", { p_page: page, p_per_page: perPage }),
    async create(input) {
      const out = await rpc<AuthUserRow | { error: string }>(db, "local_auth_create_user", {
        p_email: input.email,
        p_password_hash: input.passwordHash,
        p_user_meta: input.userMetadata,
        p_confirmed: input.confirmed,
      });
      return "error" in out ? "email_exists" : out;
    },
    async recordSignIn(userId) {
      await rpc(db, "local_auth_record_sign_in", { p_user_id: userId });
    },
    async insertRefresh(input) {
      await rpc(db, "local_auth_insert_refresh", {
        p_token: input.token,
        p_user_id: input.userId,
        p_session_id: input.sessionId,
        p_parent: input.parent,
      });
    },
    async rotateRefresh(token, newToken) {
      const r = await rpc<{ user_id: string; session_id: string | null; token: string } | null>(
        db,
        "local_auth_rotate_refresh",
        { p_token: token, p_new_token: newToken },
      );
      return r ? { userId: r.user_id, sessionId: r.session_id, token: r.token } : null;
    },
    async revoke(userId, scope, sessionId) {
      await rpc(db, "local_auth_revoke", { p_user_id: userId, p_scope: scope, p_session_id: sessionId });
    },
  };
}
