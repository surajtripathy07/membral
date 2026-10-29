// /auth/v1/* — the local GoTrue-protocol stub (lib/local/auth-stub). 404 for everything unless local mode, so
// hosted behaviour is unchanged; hosted keeps real Supabase Auth at its own URL.
import { NextResponse } from "next/server";
import { handleLocalAuth } from "@/lib/local/auth-stub";
import { isLocalMode } from "@/lib/local/mode";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ path: string[] }> };

async function handle(req: Request, ctx: Ctx): Promise<Response> {
  if (!isLocalMode()) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const { path } = await ctx.params;
  return handleLocalAuth(req, path);
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
