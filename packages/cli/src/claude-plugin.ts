// Detects the Membral Claude Code plugin (plugins/membral in this repo,
// published from surajtripathy07/membral-plugin). When it is installed, the
// plugin already supplies the SessionStart/SessionEnd hooks and the MCP
// server, so `membral setup` skips writing its own copies into
// ~/.claude/settings.json and ~/.claude.json; otherwise every hook would
// fire twice. The plugin's run.mjs makes the mirror check: it no-ops when
// setup's hooks are already in settings.json.
//
// Claude Code records installed plugins in
// <config dir>/plugins/installed_plugins.json as
// `{ "version": 2, "plugins": { "<name>@<marketplace>": [ ... ] } }`, where
// the config dir is $CLAUDE_CONFIG_DIR or ~/.claude.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

export function installedPluginsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(claudeConfigDir(env), "plugins", "installed_plugins.json");
}

export function userSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(claudeConfigDir(env), "settings.json");
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * The plugin id (e.g. "membral@membral") when the Membral plugin is installed
 * at user scope and not disabled in the user settings.json
 * (`enabledPlugins[id] === false`); otherwise null. A project- or
 * local-scope install covers only some repos, so setup still installs its
 * own user-level hooks then.
 */
export async function findMembralPlugin(
  registryPath: string = installedPluginsPath(),
  settingsPath: string = userSettingsPath(),
): Promise<string | null> {
  const plugins = ((await readJson(registryPath)) as { plugins?: unknown } | null)?.plugins;
  if (!plugins || typeof plugins !== "object") return null;
  const enabled = ((await readJson(settingsPath)) as { enabledPlugins?: Record<string, unknown> } | null)
    ?.enabledPlugins;
  for (const [id, installs] of Object.entries(plugins as Record<string, unknown>)) {
    if (id.split("@")[0] !== "membral" || !Array.isArray(installs)) continue;
    const userScope = installs.some((i) => (i as { scope?: unknown } | null)?.scope === "user");
    if (userScope && enabled?.[id] !== false) return id;
  }
  return null;
}
