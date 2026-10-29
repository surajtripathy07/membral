// POST /api/internal/local/provision — local stack only (W7 design §6, §11).
//
// `membral local up` calls this to create (or refresh) the single local user
// and, when its stored key no longer works, mint a new API key — no browser.
//
// VISIBILITY: 404 unless local mode (MEMBRAL_LOCAL=1 and VERCEL unset), so on
// hosted the route looks like it does not exist.
// AUTH: `Authorization: Bearer <service-role key>`, compared in constant time
// over sha256 digests (equal length whatever the input). 401 on mismatch.
// The password and the minted key are never logged.
//
// Body: { email, password (>= 16 chars), deviceName, mintKey }.
// 200:  { userId, email, created, apiKey: string | null }.
import { NextResponse } from "next/server";
import { z } from "zod";
import { withRoute } from "@/lib/api/route";
import { getServiceClient } from "@/lib/db/clients";
import { isLocalMode } from "@/lib/local/mode";
import { provisionLocalUser } from "@/lib/local/provision";
import { bearerMatches, serviceKey } from "@/lib/local/service-auth";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";

const ProvisionSchema = z.object({
  email: z.string().trim().email().max(320),
  password: z.string().min(16).max(256),
  deviceName: z.string().trim().min(1).max(100),
  mintKey: z.boolean(),
});

export const POST = withRoute({ auth: { kind: "none" } }, async ({ req }) => {
  if (!isLocalMode()) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const secret = serviceKey();
  if (!secret) return NextResponse.json({ error: "Not configured" }, { status: 503 });
  if (!bearerMatches(req.headers.get("authorization"), secret)) {
    log.warn("local_provision: rejected — bad or missing bearer");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = ProvisionSchema.safeParse(json);
  if (!parsed.success) {
    // Issue paths and codes only: never echo input values (the password).
    const issues = parsed.error.issues.slice(0, 5).map((i) => ({ path: i.path, code: i.code }));
    return NextResponse.json({ error: "Invalid body", issues }, { status: 400 });
  }

  try {
    const result = await provisionLocalUser(getServiceClient(), parsed.data);
    log.info("local_provision", { user_id: result.userId, created: result.created, minted: result.apiKey !== null });
    return NextResponse.json(result);
  } catch (err) {
    log.error("local_provision: failed", { err: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: "Provisioning failed" }, { status: 500 });
  }
});
