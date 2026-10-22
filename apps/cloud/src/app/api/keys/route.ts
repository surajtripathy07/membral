import { NextResponse } from "next/server";
import { withRoute } from "@/lib/api/route";
import { generateApiKey } from "@/lib/api-keys";
import { getServiceClient } from "@/lib/db/clients";
import { userBucket } from "@/lib/rate-limit";

// POST /api/keys -- generate or regenerate API key.
//
// Body (optional): { scope_node_id?: string | null, scope_code_project_id?:
// string | null }. Both null/absent = "All of my graph" (unscoped). A key is
// area-scoped XOR code-project-scoped XOR unscoped (the single-scope model,
// issue #83 + ADR 0021 Q7) — passing BOTH non-null is a 400 (the DB
// profiles_api_key_single_scope CHECK backstops it too). A non-null
// scope_node_id must be one of the caller's OWN live LifeArea nodes; a non-null
// scope_code_project_id must be one of the caller's OWN code projects —
// validated here so the user gets a clean error instead of a silently dead key.
// Regenerate always sets scope EXPLICITLY from the body (the UI sends the
// current or newly chosen scope every time).
export const POST = withRoute(
  {
    auth: { kind: "bearer", missing: "Unauthorized", invalid: "Unauthorized" },
    rateLimit: { name: "keys", bucket: ({ user }) => userBucket("keys", user.id) },
  },
  async ({ req, user }) => {
    let scopeNodeId: string | null = null;
    let scopeCodeProjectId: string | null = null;
    try {
      const body = await req.json();
      if (body && typeof body === "object") {
        if (body.scope_node_id != null) {
          if (typeof body.scope_node_id !== "string") {
            return NextResponse.json({ error: "scope_node_id must be a string or null" }, { status: 400 });
          }
          scopeNodeId = body.scope_node_id;
        }
        if (body.scope_code_project_id != null) {
          if (typeof body.scope_code_project_id !== "string") {
            return NextResponse.json({ error: "scope_code_project_id must be a string or null" }, { status: 400 });
          }
          scopeCodeProjectId = body.scope_code_project_id;
        }
      }
    } catch {
      // No body / invalid JSON -> unscoped ("all of my graph"), the default.
    }

    // Single-scope (XOR): reject BOTH set before any DB work.
    if (scopeNodeId != null && scopeCodeProjectId != null) {
      return NextResponse.json(
        { error: "A key may be scoped to a life area or a code project, not both" },
        { status: 400 },
      );
    }

    // Validate the scope belongs to the CALLER. The service client bypasses RLS,
    // so we constrain by user_id explicitly and never trust the body's ownership.
    // Life-area (graph) scoping is gone with the knowledge graph; only a code-project scope can be minted.
    if (scopeNodeId != null) {
      return NextResponse.json({ error: "Life-area scoped keys are no longer supported" }, { status: 400 });
    }

    if (scopeCodeProjectId != null) {
      const service = getServiceClient();
      const { data: project, error } = await service
        .from("code_projects")
        .select("id")
        .eq("id", scopeCodeProjectId)
        .eq("user_id", user.id)
        .single();
      if (error || !project) {
        return NextResponse.json({ error: "scope_code_project_id is not one of your code projects" }, { status: 400 });
      }
    }

    try {
      const apiKey = await generateApiKey(user.id, scopeNodeId, scopeCodeProjectId);
      return NextResponse.json({
        api_key: apiKey,
        scope_node_id: scopeNodeId,
        scope_code_project_id: scopeCodeProjectId,
      });
    } catch {
      return NextResponse.json({ error: "Failed to generate API key" }, { status: 500 });
    }
  },
);

// DELETE /api/keys -- revoke API key
export const DELETE = withRoute(
  {
    auth: { kind: "bearer", missing: "Unauthorized", invalid: "Unauthorized" },
    rateLimit: { name: "keys", bucket: ({ user }) => userBucket("keys", user.id) },
  },
  async ({ user, supabase }) => {
    const { error } = await supabase
      .from("profiles")
      .update({
        api_key_hash: null,
        api_key_prefix: null,
        api_key_scope_node_id: null,
        api_key_scope_code_project_id: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", user.id);

    if (error) {
      return NextResponse.json({ error: "Failed to revoke API key" }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  },
);
