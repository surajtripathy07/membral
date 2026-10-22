import { NextResponse } from "next/server";
import { withRoute } from "@/lib/api/route";
import { userBucket } from "@/lib/rate-limit";

// POST /api/account/delete — issue #22 (truthfulness audit F7): the privacy
// page has always promised self-service account deletion; this is the route
// that makes that true.
//
// Cascade audit (done by hand against the local Supabase instance,
// 2026-09-08, `\d <table>` / information_schema.referential_constraints):
// every user-owned table's FK either targets `profiles(id)` with
// `ON DELETE CASCADE`, or (memories, feature_flags) targets `auth.users(id)`
// directly with `ON DELETE CASCADE`. `profiles.id` itself is
// `profiles_id_fkey ... REFERENCES auth.users(id) ON DELETE CASCADE`. So a
// single `auth.admin.deleteUser` — which issues `DELETE FROM auth.users`
// under the hood — cascades through profiles into every child table in one
// transaction; nothing needs deleting by hand here. `rate_limit_hits`
// (keyed by an opaque bucket string, not a user FK) and `app_settings`
// (global) are correctly NOT part of this cascade — they hold no
// user-identifying content.
//
// Reuses the "keys" rate-limit rule (10/min, same cadence as key mint/
// revoke) rather than adding a new named rule to lib/rate-limit.ts.

export const POST = withRoute(
  {
    auth: { kind: "bearer", missing: "Unauthorized", invalid: "Unauthorized" },
    rateLimit: { name: "keys", bucket: ({ user }) => userBucket("account-delete", user.id) },
  },
  async ({ req, user, supabase }) => {
    // Defense-in-depth server-side check backing the client's typed
    // confirmation (settings UI requires literally typing DELETE before the
    // button enables) — a caller hitting this route directly still has to
    // send the same word.
    let confirmation: unknown;
    try {
      const body = await req.json();
      confirmation = body?.confirmation;
    } catch {
      confirmation = undefined;
    }
    if (confirmation !== "DELETE") {
      return NextResponse.json({ error: 'Send { "confirmation": "DELETE" } to confirm.' }, { status: 400 });
    }

    const { error } = await supabase.auth.admin.deleteUser(user.id);
    if (error) {
      return NextResponse.json({ error: "Could not delete account" }, { status: 500 });
    }

    return NextResponse.json({ deleted: true });
  },
);
