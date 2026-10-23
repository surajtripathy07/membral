// `membral use [<profile>]` — the local <-> prod switch. With no argument it
// lists the profiles in ~/.membral/credentials.json and marks the active
// one. With a name it makes that profile active and re-points the things
// that carry a URL + key outside credentials.json: Claude Code's user-scope
// MCP entry, opencode's `mcp.membral`, and — when their config file exists
// and already has a `membral` entry — Claude Desktop's and Cursor's. Hooks, the opencode
// plugin and the sweep resolve the active profile at run time, so they
// follow without being touched — but `use` still re-runs the hook installer
// (idempotent) so a legacy entry that baked in `--api-url <url>` is migrated
// to the URL-free form; otherwise that flag would pin the old server forever.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type CliInvocation, configureMCPServer } from "./configure.js";
import { defaultCredentialsPath, loadProfiles, setActiveProfile } from "./credentials.js";
import { defaultSettingsPath, installSessionHook } from "./install-session-hook.js";
import { configureOpencodeMcp, defaultOpencodeConfigDir, detectOpencode } from "./opencode-integration.js";

export interface UseCommandDeps {
  credentialsPath?: string;
  opencodeConfigDir?: string;
  configureMCP?: typeof configureMCPServer;
  configureOpencode?: typeof configureOpencodeMcp;
  detectOpencodeFn?: (configDir: string) => boolean;
  /** Claude Code settings.json whose Membral hooks are refreshed (default ~/.claude/settings.json). */
  settingsPath?: string;
  installHooks?: typeof installSessionHook;
  cliInvocation?: CliInvocation;
  /** Default ~/Library/Application Support/Claude/claude_desktop_config.json. */
  claudeDesktopConfigPath?: string;
  /** Default ~/.cursor/mcp.json. */
  cursorConfigPath?: string;
}

function loginHint(name: string): string {
  const url = name === "local" ? "http://localhost:3000" : "<url>";
  return `membral login --api-url ${url}`;
}

export async function useCommand(name: string | undefined, deps: UseCommandDeps = {}): Promise<void> {
  const credsPath = deps.credentialsPath ?? defaultCredentialsPath();
  const state = loadProfiles(credsPath);

  if (!name) {
    if (!state) {
      console.log(
        "No profiles yet — run `membral local up`, or `membral login --api-url <url>` for a server you run elsewhere.",
      );
      return;
    }
    console.log("Profiles:");
    for (const [profileName, p] of Object.entries(state.profiles)) {
      const mark = profileName === state.activeProfile ? "*" : " ";
      const who = p.email ? `  ${p.email}` : "";
      console.log(`${mark} ${profileName.padEnd(10)} ${p.apiUrl}${who}`);
    }
    console.log("");
    console.log("Switch with `membral use <profile>`; add one with `membral login --api-url <url>`.");
    return;
  }

  const previous = state?.activeProfile;
  const profile = setActiveProfile(name, credsPath);
  if (!profile) {
    const known = state ? Object.keys(state.profiles).join(", ") : "none";
    console.error(`No profile named "${name}" (known: ${known}). Sign in to create it: ${loginHint(name)}`);
    process.exitCode = 1;
    return;
  }

  console.log(
    previous === name
      ? `Profile "${name}" is already active (${profile.apiUrl}) — re-pointing MCP anyway.`
      : `Active profile: ${previous ?? "(none)"} -> ${name} (${profile.apiUrl})`,
  );
  if (process.env.MEMBRAL_API_URL || process.env.MEMBRAL_API_KEY) {
    console.log("  NOTE: MEMBRAL_API_URL/MEMBRAL_API_KEY are set in this shell and override the profile — unset them.");
  }

  const configureMCP = deps.configureMCP ?? configureMCPServer;
  const cc = await configureMCP("claude-code", "", {
    apiUrl: profile.apiUrl,
    apiKey: profile.apiKey,
    replaceExisting: true,
  });
  console.log(
    cc.success ? `  Claude Code MCP: ${profile.apiUrl}/api/mcp` : `  Claude Code MCP: FAILED — ${cc.message}`,
  );
  if (cc.success && cc.message.includes("not found on PATH")) {
    console.log("    (claude not on PATH — nothing re-pointed there)");
  }

  const ocDir = deps.opencodeConfigDir ?? defaultOpencodeConfigDir();
  if ((deps.detectOpencodeFn ?? detectOpencode)(ocDir)) {
    const oc = await (deps.configureOpencode ?? configureOpencodeMcp)({
      apiUrl: profile.apiUrl,
      apiKey: profile.apiKey,
      configDir: ocDir,
    });
    console.log(`  opencode MCP: ${oc.message}`);
    if (!oc.success) process.exitCode = 1;
  } else {
    console.log("  opencode MCP: opencode not found — skipped");
  }
  if (!cc.success) process.exitCode = 1;

  // Claude Desktop + Cursor: only files that already exist, only an existing
  // `membral` entry — `use` switches servers, it doesn't install clients.
  const fileClients = [
    {
      id: "claude-desktop" as const,
      name: "Claude Desktop",
      path:
        deps.claudeDesktopConfigPath ??
        join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json"),
      restart: "restart Claude Desktop to pick it up",
    },
    {
      id: "cursor" as const,
      name: "Cursor",
      path: deps.cursorConfigPath ?? join(homedir(), ".cursor", "mcp.json"),
      restart: "reload the Cursor window to pick it up",
    },
  ];
  for (const client of fileClients) {
    if (!existsSync(client.path)) {
      console.log(`  ${client.name} MCP: no config file — skipped`);
      continue;
    }
    const r = await configureMCP(client.id, client.path, {
      apiUrl: profile.apiUrl,
      apiKey: profile.apiKey,
      onlyExisting: true,
    });
    if (!r.success) {
      console.log(`  ${client.name} MCP: FAILED — ${r.message}`);
      process.exitCode = 1;
    } else if (r.skipped) {
      console.log(`  ${client.name} MCP: ${r.message}`);
    } else if (r.repointed) {
      console.log(`  ${client.name} MCP: re-pointed to ${profile.apiUrl}/api/mcp — ${client.restart}`);
    } else {
      console.log(`  ${client.name} MCP: already pointed at ${profile.apiUrl}/api/mcp`);
    }
  }

  const settingsPath = deps.settingsPath ?? defaultSettingsPath();
  if (existsSync(dirname(settingsPath))) {
    // Rewrites our marker entries in place: drops a legacy `--api-url`, never duplicates.
    await (deps.installHooks ?? installSessionHook)({ settings: settingsPath, cliInvocation: deps.cliInvocation });
    console.log(`  Claude Code hooks: refreshed (${settingsPath}) — they follow the active profile.`);
  } else {
    console.log("  Claude Code hooks: Claude Code not found — skipped");
  }
  console.log("  Hooks, the opencode plugin and the sweep follow the active profile automatically;");
  console.log("  restart running Claude Code/opencode sessions to pick up the MCP change.");
}
