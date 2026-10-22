// DELETE /api/keys/devices/[id] — revoke one api_keys row (migration 052,
// device-code sign-in). Settings-page-only; NOT part of the CLI's
// device-auth contract. Same Bearer-JWT auth shape as /api/keys (the
// sibling route this extends) rather than the cookie-session shape used by
// the /device approve/deny routes — the settings page already threads an
// accessToken prop through its client components (see settings/page.tsx),
// so this matches that existing convention instead of introducing a second
// auth style into the same page.

import { NextResponse } from "next/server";
import { withRoute } from "@/lib/api/route";
import { revokeApiKey } from "@/lib/api-keys";
import { getServiceClient } from "@/lib/db/clients";
import { userBucket } from "@/lib/rate-limit";

export const DELETE = withRoute<
  { kind: "bearer"; missing: string; invalid: string },
  { params: Promise<{ id: string }> }
>(
  {
    auth: { kind: "bearer", missing: "Unauthorized", invalid: "Unauthorized" },
    rateLimit: { name: "keys", bucket: ({ user }) => userBucket("keys", user.id) },
  },
  async ({ ctx, user }) => {
    const { id } = await ctx.params;
    const supabase = getServiceClient();

    // revokeApiKey constrains by BOTH id and user_id — the service client
    // bypasses RLS, so that predicate is the enforcement, not RLS (same
    // posture as every other service-role route in this codebase).
    const { data, error } = await revokeApiKey(supabase, user.id, id);

    if (error) {
      return NextResponse.json({ error: "Failed to revoke key" }, { status: 500 });
    }
    if (!data || data.length === 0) {
      return NextResponse.json({ error: "Key not found or already revoked" }, { status: 404 });
    }

    return NextResponse.json({ ok: true });
  },
);
