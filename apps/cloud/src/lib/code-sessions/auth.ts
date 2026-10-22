// Shared write-auth for the code-sessions API surface: POST /api/code-sessions
// (import) and POST /api/code-sessions/synthesize (manual/backfill trigger).
// Bearer Supabase JWT OR an UNSCOPED Bearer lls_ key only — a SCOPED key
// (area-scoped #83, or code-project-scoped ADR Q7) is a narrowed READ lens
// (see /api/mcp), never a write grant.

import { type NextRequest, NextResponse } from "next/server";
import { validateApiKey } from "@/lib/api-keys";
import { getServiceClient } from "@/lib/db/clients";
import { clientIp, rateLimited } from "@/lib/rate-limit";

// withRoute `auth` for the code-sessions write surface (R4 4.12): the same
// strings and rules as authenticateCodeSessionsWrite below, expressed as the
// shared "dual" kind (JWT or unscoped lls_; scoped key -> 403; clientIp always
// threaded). authenticateCodeSessionsWrite stays for kg/claims/advance, which
// is unwrapped by design (cookie-or-bearer with an origin check).
export const CODE_SESSIONS_WRITE_AUTH = {
  kind: "dual",
  missing: "Missing authorization",
  invalidToken: "Invalid token",
  invalidKey: "Invalid API key",
  scoped: { reject: "Scoped API keys cannot write code sessions" },
} as const;

/** GET /api/code-sessions/stats: same as the write surface, with its own 403 text. */
export const CODE_SESSIONS_READ_AUTH = {
  ...CODE_SESSIONS_WRITE_AUTH,
  scoped: { reject: "Scoped API keys cannot read aggregate stats" },
} as const;

export interface CodeSessionsAuthResult {
  userId: string;
}

export function getCodeSessionsServiceClient() {
  return getServiceClient();
}

export async function authenticateCodeSessionsWrite(req: NextRequest): Promise<CodeSessionsAuthResult | NextResponse> {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Missing authorization" }, { status: 401 });
  }

  const token = authHeader.slice(7);

  if (token.startsWith("lls_")) {
    const result = await validateApiKey(token, clientIp(req));
    if (result.rateLimited) {
      return rateLimited(result.retryAfter ?? 60);
    }
    if (!result.valid || !result.userId) {
      return NextResponse.json({ error: "Invalid API key" }, { status: 401 });
    }
    // SECURITY: reject any scoped key (area-scoped #83, or code-project-scoped
    // ADR Q7) for writes. Only an unscoped key may import/synthesize.
    if (result.scopeNodeId != null || result.scopeCodeProjectId != null) {
      return NextResponse.json({ error: "Scoped API keys cannot write code sessions" }, { status: 403 });
    }
    return { userId: result.userId };
  }

  const supabase = getCodeSessionsServiceClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser(token);

  if (error || !user) {
    return NextResponse.json({ error: "Invalid token" }, { status: 401 });
  }

  return { userId: user.id };
}
