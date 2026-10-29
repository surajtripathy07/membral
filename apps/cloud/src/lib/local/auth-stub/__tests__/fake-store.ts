// In-memory AuthStore for the stub's tests (same contract as the RPC-backed one).
import bcrypt from "bcryptjs";
import type { AuthStore, AuthUserRow } from "../store";

export const REUSE_INTERVAL_MS = 10_000;
export const REFRESH_TTL_MS = 30 * 24 * 3_600_000;

/** Mirrors local_auth_rotate_refresh in auth-prelude.sql (the SQL itself is run against PGlite in prelude.test.ts). */
export function fakeStore(clock: { now: number } = { now: Date.now() }) {
  const users = new Map<string, AuthUserRow>();
  const tokens = new Map<
    string,
    { userId: string; sessionId: string | null; revoked: boolean; parent: string | null; at: number; created: number }
  >();
  let n = 0;
  const store: AuthStore = {
    async findByEmail(email) {
      return [...users.values()].find((u) => u.email?.toLowerCase() === email.toLowerCase()) ?? null;
    },
    async findById(id) {
      const u = users.get(id);
      if (!u) return null;
      const { encrypted_password: _omit, ...rest } = u;
      return rest;
    },
    async list(page, perPage) {
      const all = [...users.values()];
      return { users: all.slice((page - 1) * perPage, page * perPage), total: all.length };
    },
    async create(input) {
      if ([...users.values()].some((u) => u.email === input.email)) return "email_exists";
      const row: AuthUserRow = {
        id: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
        email: input.email,
        aud: "authenticated",
        role: "authenticated",
        email_confirmed_at: input.confirmed ? "2026-01-01T00:00:00Z" : null,
        phone: "",
        last_sign_in_at: null,
        raw_app_meta_data: { provider: "email", providers: ["email"] },
        raw_user_meta_data: input.userMetadata,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        encrypted_password: input.passwordHash,
      };
      users.set(row.id, row);
      return row;
    },
    async recordSignIn() {},
    async insertRefresh(i) {
      tokens.set(i.token, {
        userId: i.userId,
        sessionId: i.sessionId,
        revoked: false,
        parent: i.parent,
        at: clock.now,
        created: clock.now,
      });
    },
    async rotateRefresh(token, newToken) {
      const t = tokens.get(token);
      if (!t || clock.now - t.created > REFRESH_TTL_MS) return null;
      if (!t.revoked) {
        t.revoked = true;
        t.at = clock.now;
        tokens.set(newToken, {
          userId: t.userId,
          sessionId: t.sessionId,
          revoked: false,
          parent: token,
          at: clock.now,
          created: clock.now,
        });
        return { userId: t.userId, sessionId: t.sessionId, token: newToken };
      }
      if (clock.now - t.at < REUSE_INTERVAL_MS) {
        for (const [k, c] of tokens) {
          if (c.parent === token && !c.revoked) return { userId: t.userId, sessionId: t.sessionId, token: k };
        }
      }
      for (const c of tokens.values()) if (c.sessionId === t.sessionId) c.revoked = true;
      return null;
    },
    async revoke(userId, scope, sessionId) {
      for (const t of tokens.values()) {
        if (t.userId !== userId) continue;
        if (
          scope === "global" ||
          (scope === "local" && t.sessionId === sessionId) ||
          (scope === "others" && t.sessionId !== sessionId)
        ) {
          t.revoked = true;
          t.at = clock.now;
        }
      }
    },
  };
  return { store, users, tokens };
}

export async function seedUser(s: ReturnType<typeof fakeStore>, email = "me@codehub.test", password = "correct horse") {
  const row = await s.store.create({
    email,
    passwordHash: bcrypt.hashSync(password, 4),
    userMetadata: {},
    confirmed: true,
  });
  if (row === "email_exists") throw new Error("seed collision");
  return row;
}
