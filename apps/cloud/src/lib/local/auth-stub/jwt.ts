// HS256 JWTs for the local GoTrue stub. Signed with the secret `membral local up` generated (the same one that
// signs the anon and service_role keys), with GoTrue's claim names so supabase-js and PostgREST read them unchanged.
import { createHmac, timingSafeEqual } from "node:crypto";

export const ACCESS_TOKEN_TTL_S = 3600;

export interface JwtClaims {
  sub?: string;
  role?: string;
  aud?: string | string[];
  exp?: number;
  iat?: number;
  nbf?: number;
  session_id?: string;
  [key: string]: unknown;
}

const b64url = (s: string | Buffer) => Buffer.from(s).toString("base64url");

export function signJwt(claims: JwtClaims, secret: string): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify(claims));
  const sig = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${sig}`;
}

/** Claims when the token is HS256-signed with `secret` and inside its exp / nbf window; null otherwise. */
export function verifyJwt(token: string, secret: string, nowS: number): JwtClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts as [string, string, string];
  try {
    const header = JSON.parse(Buffer.from(h, "base64url").toString("utf8")) as { alg?: unknown };
    if (header.alg !== "HS256") return null; // never trust the token's own algorithm choice ("none", RS256, ...)
    const want = createHmac("sha256", secret).update(`${h}.${p}`).digest();
    const got = Buffer.from(s, "base64url");
    if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
    const claims = JSON.parse(Buffer.from(p, "base64url").toString("utf8")) as JwtClaims;
    if (typeof claims !== "object" || claims === null) return null;
    if (typeof claims.exp === "number" && claims.exp <= nowS) return null;
    if (typeof claims.nbf === "number" && claims.nbf > nowS) return null;
    return claims;
  } catch {
    return null;
  }
}
