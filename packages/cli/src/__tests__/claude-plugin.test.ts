import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findMembralPlugin, installedPluginsPath, userSettingsPath } from "../claude-plugin.js";

describe("findMembralPlugin", () => {
  let dir: string;
  let registry: string;
  let settings: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "membral-plugin-detect-"));
    registry = join(dir, "installed_plugins.json");
    settings = join(dir, "settings.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const writeRegistry = (plugins: Record<string, unknown>) =>
    writeFileSync(registry, JSON.stringify({ version: 2, plugins }));

  it("returns the plugin id for a user-scope install from any marketplace", async () => {
    writeRegistry({
      "other@somewhere": [{ scope: "user" }],
      "membral@membral": [{ scope: "user", version: "0.2.0" }],
    });
    expect(await findMembralPlugin(registry, settings)).toBe("membral@membral");
  });

  it("ignores project- and local-scope installs", async () => {
    writeRegistry({ "membral@membral": [{ scope: "project", projectPath: "/r" }, { scope: "local" }] });
    expect(await findMembralPlugin(registry, settings)).toBeNull();
  });

  it("ignores a user-scope install disabled in the user settings.json", async () => {
    writeRegistry({ "membral@membral": [{ scope: "user" }] });
    writeFileSync(settings, JSON.stringify({ enabledPlugins: { "membral@membral": false } }));
    expect(await findMembralPlugin(registry, settings)).toBeNull();
    writeFileSync(settings, JSON.stringify({ enabledPlugins: { "membral@membral": true } }));
    expect(await findMembralPlugin(registry, settings)).toBe("membral@membral");
  });

  it("returns null for other plugins, an empty install list, a missing file, or bad JSON", async () => {
    writeRegistry({ "membral-x@m": [{ scope: "user" }], "membral@m": [] });
    expect(await findMembralPlugin(registry, settings)).toBeNull();
    expect(await findMembralPlugin(join(dir, "missing.json"), settings)).toBeNull();
    writeFileSync(registry, "{not json");
    expect(await findMembralPlugin(registry, settings)).toBeNull();
  });

  it("honours CLAUDE_CONFIG_DIR for both paths", () => {
    expect(installedPluginsPath({ CLAUDE_CONFIG_DIR: "/cfg" })).toBe("/cfg/plugins/installed_plugins.json");
    expect(userSettingsPath({ CLAUDE_CONFIG_DIR: "/cfg" })).toBe("/cfg/settings.json");
  });
});
