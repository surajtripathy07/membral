import { checkFeature } from "@/lib/feature-flags";
import { resolveMcpUrl } from "@/lib/mcp-url";
import { createClient } from "@/lib/supabase/server";
import { loadSettingsPage } from "./load";
import { SettingsView } from "./settings-view";

export default async function SettingsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: session } = await supabase.auth.getSession();
  const accessToken = session?.session?.access_token ?? "";

  const { apiKeyPrefix, apiKeyScopeNodeId, apiKeyScopeCodeProjectId, lifeAreas, codeProjects, deviceKeys } =
    await loadSettingsPage(supabase, user!.id);

  // Round-2 review MED 8: the flagged-off NOTICE is rendered once, in
  // (dashboard)/layout.tsx (via its own checkFeature call), covering every
  // dashboard page — no need to compute or thread it here too. The "AI
  // features" CARD below is a separate, settings-only concern (issue #128,
  // ADR 0047 v2) — it shows BOTH features' budget/spend, not just llm's
  // enabled/disabled, so it needs its own checkFeature calls. Cached (30s,
  // in-process) alongside layout.tsx's own llm check — same cache key, so
  // this is a cheap cache hit on any normal page load.
  const [embeddingsCheck, llmCheck] = await Promise.all([
    checkFeature(user!.id, "embeddings"),
    checkFeature(user!.id, "llm"),
  ]);

  return (
    <SettingsView
      email={user?.email ?? ""}
      apiKeyPrefix={apiKeyPrefix}
      apiKeyScopeNodeId={apiKeyScopeNodeId}
      apiKeyScopeCodeProjectId={apiKeyScopeCodeProjectId}
      lifeAreas={lifeAreas}
      codeProjects={codeProjects}
      deviceKeys={deviceKeys}
      accessToken={accessToken}
      embeddingsCheck={embeddingsCheck}
      llmCheck={llmCheck}
      mcpUrl={resolveMcpUrl()}
    />
  );
}
