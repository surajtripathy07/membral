// /settings data loading (G3 step 3B-4a): the page's four table reads moved
// verbatim into a named loader — same chains, same sequential await order
// (profiles → code_projects → api_keys), same row mapping. The
// page keeps auth (getUser/getSession), the checkFeature calls, and render.
// 3B-4b: profiles / code_projects / api_keys now go through repository
// functions (chains unchanged).

import { getApiKeyProfile, listApiKeys } from "@/lib/api-keys";
import { listCodeProjectsForScopePicker } from "@/lib/code-sessions/queries";
import type { Db } from "@/lib/db/types";

export interface SettingsPageData {
  apiKeyPrefix: string | null;
  apiKeyScopeNodeId: string | null;
  apiKeyScopeCodeProjectId: string | null;
  lifeAreas: { id: string; label: string }[];
  codeProjects: { id: string; label: string }[];
  deviceKeys: {
    id: string;
    prefix: string;
    label: string | null;
    createdAt: string;
    lastUsedAt: string | null;
    revoked: boolean;
  }[];
}

export async function loadSettingsPage(supabase: Db, userId: string): Promise<SettingsPageData> {
  // Fetch profile for API key prefix + scope (area #83 / code-project ADR Q7)
  const { data: profile } = await getApiKeyProfile(supabase, userId);

  const apiKeyPrefix = profile?.api_key_prefix ?? null;
  const apiKeyScopeNodeId = profile?.api_key_scope_node_id ?? null;
  const apiKeyScopeCodeProjectId = profile?.api_key_scope_code_project_id ?? null;

  // Life areas were graph nodes (kg_nodes); the graph is gone, so the picker
  // gets none. SettingsView / ApiKeyManager already render the empty case.
  const lifeAreas: { id: string; label: string }[] = [];

  // Code projects for the scope picker (ADR 0021 Q7). RLS scopes to the user.
  const { data: codeRows } = await listCodeProjectsForScopePicker(supabase);

  const codeProjects = (codeRows ?? []).map((p) => ({
    id: p.id as string,
    label: (p.display_name as string | null) ?? (p.repo_identity as string),
  }));

  // Device-bound API keys (migration 052) — RLS scopes this select to the
  // signed-in user, same as the code-projects query above.
  const { data: deviceKeyRows } = await listApiKeys(supabase);

  const deviceKeys = (deviceKeyRows ?? []).map((k) => ({
    id: k.id as string,
    prefix: k.key_prefix as string,
    label: k.label as string | null,
    createdAt: k.created_at as string,
    lastUsedAt: k.last_used_at as string | null,
    revoked: k.revoked_at != null,
  }));

  return { apiKeyPrefix, apiKeyScopeNodeId, apiKeyScopeCodeProjectId, lifeAreas, codeProjects, deviceKeys };
}
