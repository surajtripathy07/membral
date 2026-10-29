// Bearer check shared by the local-only internal routes (provision, reembed): the caller must present the stack's
// service-role key. Compared in constant time over sha256 digests (equal length whatever the input).
import { createHash, timingSafeEqual } from "node:crypto";
import { getEnv } from "@/lib/env";

function digest(s: string): Buffer {
  return createHash("sha256").update(s).digest();
}

export function bearerMatches(header: string | null, secret: string): boolean {
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  if (!token) return false;
  return timingSafeEqual(digest(token), digest(secret));
}

/** The configured service-role key, or null when env is incomplete. */
export function serviceKey(): string | null {
  try {
    return getEnv().supabaseServiceRoleKey;
  } catch {
    return null;
  }
}
