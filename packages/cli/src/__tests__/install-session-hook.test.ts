import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setPromptRecall } from "../cli-config.js";
import { type CliInvocation, configureSessionEndHook } from "../configure.js";
import { defaultSettingsPath, installSessionHook, PROMPT_RECALL_DISCLOSURE } from "../install-session-hook.js";

// P10 review finding 2: hook commands are now built from a resolved
// node+entry invocation (configure.ts's resolveCliInvocation), not a bare
// `npx -y @membral/cli ...` string. Fixed here for deterministic assertions
// instead of depending on this test runner's own process.argv[1].
const FIXTURE_INVOCATION: CliInvocation = { argv: ["/usr/bin/node", "/opt/membral/dist/index.js"] };
const FIXTURE_SESSION_END_CMD = '"/usr/bin/node" "/opt/membral/dist/index.js" session-end-hook';
const FIXTURE_PREAMBLE_CMD = '"/usr/bin/node" "/opt/membral/dist/index.js" preamble --hook';

interface HookEntry {
  type: string;
  command: string;
}
interface HookGroup {
  matcher?: string;
  hooks: HookEntry[];
}
interface Settings {
  hooks?: { SessionEnd?: HookGroup[]; SessionStart?: HookGroup[]; [k: string]: unknown };
  [k: string]: unknown;
}

async function readSettings(path: string): Promise<Settings> {
  return JSON.parse(await readFile(path, "utf-8"));
}

function allSessionEndCommands(settings: Settings): string[] {
  return (settings.hooks?.SessionEnd ?? []).flatMap((g) => g.hooks.map((h) => h.command));
}

function allSessionStartCommands(settings: Settings): string[] {
  return (settings.hooks?.SessionStart ?? []).flatMap((g) => g.hooks.map((h) => h.command));
}

describe("installSessionHook", () => {
  let root: string;
  let settingsPath: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "membral-install-session-hook-"));
    settingsPath = join(root, "settings.json");
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it("creates settings.json (and its parent dir) with a SessionEnd hook when none exists", async () => {
    const nested = join(root, "nested", "settings.json");

    await installSessionHook({ settings: nested, cliInvocation: FIXTURE_INVOCATION });

    const settings = await readSettings(nested);
    const commands = allSessionEndCommands(settings);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toBe(FIXTURE_SESSION_END_CMD);
    expect(process.exitCode).toBeUndefined();
  });

  it("never embeds --api-url (resolved at run time from the active profile) nor an API key", async () => {
    await installSessionHook({ settings: settingsPath, apiUrl: "https://cloud.example.com" });

    const settings = await readSettings(settingsPath);
    const commands = allSessionEndCommands(settings);
    expect(commands).toHaveLength(1);
    expect(commands[0]).not.toContain("--api-url");
    expect(commands[0]).not.toContain("https://cloud.example.com");
    expect(allSessionStartCommands(settings)[0]).not.toContain("--api-url");

    // No-key-in-settings assertion: nothing resembling an API key/secret
    // ever makes it into the file, and there is no --api-key flag at all.
    const raw = await readFile(settingsPath, "utf-8");
    expect(raw).not.toMatch(/--api-key/);
    expect(raw).not.toMatch(/lls_/);
    expect(raw).not.toMatch(/MEMBRAL_API_KEY\s*=/);
  });

  it("#334: writes the SessionEnd entry with timeout 10 (seconds), and only the SessionEnd entry", async () => {
    await installSessionHook({ settings: settingsPath, cliInvocation: FIXTURE_INVOCATION });

    const settings = await readSettings(settingsPath);
    expect(settings.hooks?.SessionEnd).toEqual([
      { hooks: [{ type: "command", command: FIXTURE_SESSION_END_CMD, timeout: 10 }] },
    ]);
    expect(settings.hooks?.SessionStart).toEqual([{ hooks: [{ type: "command", command: FIXTURE_PREAMBLE_CMD }] }]);
  });

  it("#334: upgrades an existing SessionEnd entry without a timeout in place, keeps its other fields, and is then a no-op", async () => {
    await writeFile(
      settingsPath,
      JSON.stringify({
        hooks: {
          SessionEnd: [{ hooks: [{ type: "command", command: FIXTURE_SESSION_END_CMD, statusMessage: "kept" }] }],
        },
      }),
    );

    const first = await configureSessionEndHook(settingsPath, { cliInvocation: FIXTURE_INVOCATION });
    expect(first.message).toContain("Updated");
    const settings = await readSettings(settingsPath);
    expect(settings.hooks?.SessionEnd).toEqual([
      { hooks: [{ type: "command", command: FIXTURE_SESSION_END_CMD, statusMessage: "kept", timeout: 10 }] },
    ]);

    const second = await configureSessionEndHook(settingsPath, { cliInvocation: FIXTURE_INVOCATION });
    expect(second.message).toContain("already installed");
    expect(allSessionEndCommands(await readSettings(settingsPath))).toHaveLength(1);
  });

  it("#334 F3: keeps a user's own larger timeout (a match, no rewrite) but raises a smaller one to 10", async () => {
    const entry = (timeout: number) => ({
      hooks: { SessionEnd: [{ hooks: [{ type: "command", command: FIXTURE_SESSION_END_CMD, timeout }] }] },
    });

    await writeFile(settingsPath, JSON.stringify(entry(30)));
    const kept = await configureSessionEndHook(settingsPath, { cliInvocation: FIXTURE_INVOCATION });
    expect(kept.message).toContain("already installed");
    expect(await readSettings(settingsPath)).toEqual(entry(30));

    await writeFile(settingsPath, JSON.stringify(entry(5)));
    const raised = await configureSessionEndHook(settingsPath, { cliInvocation: FIXTURE_INVOCATION });
    expect(raised.message).toContain("Updated");
    expect(await readSettings(settingsPath)).toEqual(entry(10));
  });

  it("is idempotent: installing twice with the same options does not duplicate the entry", async () => {
    await installSessionHook({ settings: settingsPath, apiUrl: "https://cloud.example.com" });
    await installSessionHook({ settings: settingsPath, apiUrl: "https://cloud.example.com" });

    const settings = await readSettings(settingsPath);
    expect(allSessionEndCommands(settings)).toHaveLength(1);
  });

  it("migrates old entries that baked in --api-url to the URL-free form, idempotently", async () => {
    await mkdir(root, { recursive: true });
    await writeFile(
      settingsPath,
      JSON.stringify({
        hooks: {
          SessionEnd: [
            { hooks: [{ type: "command", command: `${FIXTURE_SESSION_END_CMD} --api-url "http://localhost:3000"` }] },
          ],
          SessionStart: [
            { hooks: [{ type: "command", command: `${FIXTURE_PREAMBLE_CMD} --api-url "http://localhost:3000"` }] },
          ],
        },
      }),
    );

    await installSessionHook({ settings: settingsPath, cliInvocation: FIXTURE_INVOCATION });
    await installSessionHook({ settings: settingsPath, cliInvocation: FIXTURE_INVOCATION });

    const settings = await readSettings(settingsPath);
    expect(allSessionEndCommands(settings)).toEqual([FIXTURE_SESSION_END_CMD]);
    expect(allSessionStartCommands(settings)).toEqual([FIXTURE_PREAMBLE_CMD]);
  });

  it("preserves unrelated settings.json content (other hooks, top-level keys)", async () => {
    await mkdir(root, { recursive: true });
    await writeFile(
      settingsPath,
      JSON.stringify({
        someOtherSetting: true,
        hooks: {
          PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] }],
        },
      }),
    );

    await installSessionHook({ settings: settingsPath });

    const settings = await readSettings(settingsPath);
    expect(settings.someOtherSetting).toBe(true);
    expect(settings.hooks?.PreToolUse).toEqual([{ matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] }]);
    expect(allSessionEndCommands(settings)).toHaveLength(1);
  });

  it("--remove removes only the Membral SessionEnd hook, leaving other hooks intact", async () => {
    await installSessionHook({ settings: settingsPath });
    await mkdir(root, { recursive: true });
    let settings = await readSettings(settingsPath);
    settings.hooks = settings.hooks ?? {};
    (settings.hooks as Record<string, unknown>).PreToolUse = [
      { matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] },
    ];
    await writeFile(settingsPath, JSON.stringify(settings, null, 2));

    await installSessionHook({ settings: settingsPath, remove: true });

    settings = await readSettings(settingsPath);
    expect(allSessionEndCommands(settings)).toHaveLength(0);
    expect(settings.hooks?.SessionEnd).toBeUndefined();
    expect((settings.hooks as Record<string, unknown>).PreToolUse).toBeDefined();
  });

  it("--remove is a harmless no-op (success) when nothing is installed", async () => {
    await installSessionHook({ settings: settingsPath, remove: true });

    expect(process.exitCode).toBeUndefined();
  });

  it("defaultSettingsPath() points at ~/.claude/settings.json", () => {
    expect(defaultSettingsPath()).toContain(join(".claude", "settings.json"));
  });

  // P4 (memory-on-prod-new-user goal): the SessionStart preamble hook,
  // installed alongside SessionEnd by this same call.
  describe("SessionStart (preamble) hook", () => {
    it("installs a SessionStart hook running `membral preamble --hook` alongside SessionEnd", async () => {
      await installSessionHook({ settings: settingsPath, cliInvocation: FIXTURE_INVOCATION });

      const settings = await readSettings(settingsPath);
      expect(allSessionEndCommands(settings)).toHaveLength(1);
      const startCommands = allSessionStartCommands(settings);
      expect(startCommands).toHaveLength(1);
      expect(startCommands[0]).toBe(FIXTURE_PREAMBLE_CMD);
    });

    it("is idempotent: installing twice does not duplicate either hook", async () => {
      await installSessionHook({ settings: settingsPath, apiUrl: "https://cloud.example.com" });
      await installSessionHook({ settings: settingsPath, apiUrl: "https://cloud.example.com" });

      const settings = await readSettings(settingsPath);
      expect(allSessionEndCommands(settings)).toHaveLength(1);
      expect(allSessionStartCommands(settings)).toHaveLength(1);
    });

    it("preserves the user's unrelated hooks (other events, other SessionStart entries)", async () => {
      await mkdir(root, { recursive: true });
      await writeFile(
        settingsPath,
        JSON.stringify({
          hooks: {
            PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] }],
            SessionStart: [{ hooks: [{ type: "command", command: "echo custom-start-hook" }] }],
          },
        }),
      );

      await installSessionHook({ settings: settingsPath, cliInvocation: FIXTURE_INVOCATION });

      const settings = await readSettings(settingsPath);
      expect((settings.hooks as Record<string, unknown>).PreToolUse).toEqual([
        { matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] },
      ]);
      const startCommands = allSessionStartCommands(settings);
      expect(startCommands).toContain("echo custom-start-hook");
      expect(startCommands).toContain(FIXTURE_PREAMBLE_CMD);
      expect(startCommands).toHaveLength(2);
    });

    it("--remove removes only the Membral SessionStart hook, leaving SessionEnd and other hooks intact", async () => {
      await installSessionHook({ settings: settingsPath });

      await installSessionHook({ settings: settingsPath, remove: true });

      const settings = await readSettings(settingsPath);
      expect(allSessionStartCommands(settings)).toHaveLength(0);
      expect(settings.hooks?.SessionStart).toBeUndefined();
      expect(allSessionEndCommands(settings)).toHaveLength(0);
      expect(settings.hooks?.SessionEnd).toBeUndefined();
    });
  });

  // P10 review M5: a settings.json that fails to parse must never be
  // overwritten, and the user must be told which file and why.
  describe("malformed settings.json (M5)", () => {
    it("leaves a settings.json with invalid JSON untouched and reports which file failed to parse", async () => {
      await mkdir(root, { recursive: true });
      const original = '{ "hooks": { "PreToolUse": [ /* trailing comma */ ], }, }';
      await writeFile(settingsPath, original);

      await installSessionHook({ settings: settingsPath, cliInvocation: FIXTURE_INVOCATION });

      const rawAfter = await readFile(settingsPath, "utf-8");
      expect(rawAfter).toBe(original);
      expect(process.exitCode).toBe(1);
    });

    it("prints a message naming the file and stating hooks weren't installed", async () => {
      await mkdir(root, { recursive: true });
      await writeFile(settingsPath, "{ not valid json");
      const logSpy = vi.spyOn(console, "log");

      await installSessionHook({ settings: settingsPath, cliInvocation: FIXTURE_INVOCATION });

      const printed = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(printed).toContain(settingsPath);
      expect(printed).toMatch(/not installed/i);
    });
  });

  // P10 review M5: a backup of the prior file is written before any
  // overwrite of an EXISTING settings.json (missing file -> nothing to back
  // up). Exercised directly against configureSessionEndHook (a single
  // read-modify-write pass) rather than installSessionHook, which chains
  // TWO such passes (SessionEnd then SessionStart) against the same path —
  // each pass's own bak would otherwise capture the OTHER pass's output,
  // which is correct per-write behavior but not what a single assertion
  // here should depend on.
  describe("settings.json backup (M5)", () => {
    it("writes <file>.membral.bak with the prior content before rewriting an existing file", async () => {
      await mkdir(root, { recursive: true });
      const original = JSON.stringify({ someOtherSetting: true });
      await writeFile(settingsPath, original);

      await configureSessionEndHook(settingsPath, { cliInvocation: FIXTURE_INVOCATION });

      const bak = await readFile(`${settingsPath}.membral.bak`, "utf-8");
      expect(bak).toBe(original);
    });

    it("overwrites a prior .bak rather than accumulating history", async () => {
      await mkdir(root, { recursive: true });
      await writeFile(settingsPath, JSON.stringify({ round: 1 }));
      await configureSessionEndHook(settingsPath, { cliInvocation: FIXTURE_INVOCATION });
      const firstBak = await readFile(`${settingsPath}.membral.bak`, "utf-8");
      expect(JSON.parse(firstBak)).toEqual({ round: 1 });

      // Same cliInvocation would be a no-op (nothing to write) — force a
      // real second rewrite with a different CLI invocation.
      await configureSessionEndHook(settingsPath, {
        cliInvocation: { argv: ["/usr/local/bin/node", "/opt/membral/dist/index.js"] },
      });
      const secondBak = await readFile(`${settingsPath}.membral.bak`, "utf-8");
      expect(secondBak).not.toBe(firstBak);
      const settings = await readSettings(settingsPath);
      expect(allSessionEndCommands(settings)[0]).toContain("/usr/local/bin/node");
    });

    it("does not write a .bak when the settings file did not previously exist", async () => {
      await configureSessionEndHook(settingsPath, { cliInvocation: FIXTURE_INVOCATION });

      await expect(readFile(`${settingsPath}.membral.bak`, "utf-8")).rejects.toThrow();
    });
  });

  // N-m3 (P10 re-review): a symlinked settings.json (e.g. a dotfiles repo
  // symlinking ~/.claude/settings.json to a tracked file elsewhere) must be
  // written THROUGH to the real target, keeping the symlink itself intact,
  // and must preserve that target's existing file mode.
  describe("symlinked settings.json (N-m3)", () => {
    it("writes through the symlink to the real target and leaves the symlink itself intact", async () => {
      await mkdir(root, { recursive: true });
      const realDir = join(root, "real");
      await mkdir(realDir, { recursive: true });
      const realPath = join(realDir, "settings.json");
      await writeFile(realPath, JSON.stringify({ someOtherSetting: true }));
      await symlink(realPath, settingsPath);

      const result = await configureSessionEndHook(settingsPath, { cliInvocation: FIXTURE_INVOCATION });
      expect(result.success).toBe(true);

      const link = await stat(settingsPath); // stat follows the link
      expect(link.isFile()).toBe(true);
      const settings = await readSettings(realPath);
      expect(allSessionEndCommands(settings)).toContain(FIXTURE_SESSION_END_CMD);
      // The link itself must still be a symlink, not replaced by a plain file.
      const { lstat } = await import("node:fs/promises");
      expect((await lstat(settingsPath)).isSymbolicLink()).toBe(true);
    });

    it("preserves the real target's file mode across the write", async () => {
      await mkdir(root, { recursive: true });
      const realDir = join(root, "real");
      await mkdir(realDir, { recursive: true });
      const realPath = join(realDir, "settings.json");
      await writeFile(realPath, JSON.stringify({ someOtherSetting: true }), { mode: 0o640 });
      await chmod(realPath, 0o640); // belt and suspenders, as configure-file-mode.test.ts does
      await symlink(realPath, settingsPath);

      await configureSessionEndHook(settingsPath, { cliInvocation: FIXTURE_INVOCATION });

      const mode = (await stat(realPath)).mode & 0o777;
      expect(mode).toBe(0o640);
    });

    // P10 round 3 R3-m3: a link whose target is missing reads as ENOENT, but
    // it is not "missing" — writing would replace the link with a plain file.
    it("aborts on a broken symlink and leaves the link intact", async () => {
      await mkdir(root, { recursive: true });
      const missingTarget = join(root, "real", "gone.json");
      await symlink(missingTarget, settingsPath);

      const result = await configureSessionEndHook(settingsPath, { cliInvocation: FIXTURE_INVOCATION });
      expect(result.success).toBe(false);
      expect(result.message).toContain(settingsPath);
      expect(result.message).toMatch(/symlink to a missing file/);
      expect(result.message).toMatch(/not installed/i);

      const { lstat } = await import("node:fs/promises");
      expect((await lstat(settingsPath)).isSymbolicLink()).toBe(true);
      await expect(stat(missingTarget)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  // N-m3 (P10 re-review): a read failure that is NOT "the file doesn't
  // exist" (e.g. no permission to read it) must abort like a parse error,
  // never be treated as "missing" (which would silently overwrite it).
  describe("unreadable settings.json (N-m3)", () => {
    it("aborts and leaves the file untouched when read fails for a reason other than ENOENT", async () => {
      await mkdir(root, { recursive: true });
      const original = JSON.stringify({ someOtherSetting: true });
      await writeFile(settingsPath, original, { mode: 0o000 });

      try {
        const result = await configureSessionEndHook(settingsPath, { cliInvocation: FIXTURE_INVOCATION });
        // Root (or an unusual CI sandbox) can bypass the 0o000 permission bit —
        // only assert the abort behavior when the read genuinely failed.
        if (result.success) return;

        expect(result.message).toContain(settingsPath);
        expect(result.message).toMatch(/not installed/i);
      } finally {
        await chmod(settingsPath, 0o644); // restore so afterEach's rm can clean up
      }

      const rawAfter = await readFile(settingsPath, "utf-8");
      expect(rawAfter).toBe(original);
    });
  });

  // P10 review finding 2: an old npx-based entry must be migrated to the
  // new direct-invocation command, not left in place or duplicated.
  describe("migrating an old npx-based hook entry (finding 2)", () => {
    it("replaces an old `npx -y @membral/cli session-end-hook` entry with the absolute command, no duplicate", async () => {
      await mkdir(root, { recursive: true });
      await writeFile(
        settingsPath,
        JSON.stringify({
          hooks: {
            SessionEnd: [{ hooks: [{ type: "command", command: "npx -y @membral/cli session-end-hook" }] }],
            SessionStart: [{ hooks: [{ type: "command", command: "npx -y @membral/cli preamble --hook" }] }],
          },
        }),
      );

      await installSessionHook({ settings: settingsPath, cliInvocation: FIXTURE_INVOCATION });

      const settings = await readSettings(settingsPath);
      const endCommands = allSessionEndCommands(settings);
      const startCommands = allSessionStartCommands(settings);
      expect(endCommands).toEqual([FIXTURE_SESSION_END_CMD]);
      expect(startCommands).toEqual([FIXTURE_PREAMBLE_CMD]);
    });

    it("running the migrated install a second time is a no-op (no duplicate entries)", async () => {
      await mkdir(root, { recursive: true });
      await writeFile(
        settingsPath,
        JSON.stringify({
          hooks: { SessionEnd: [{ hooks: [{ type: "command", command: "npx -y @membral/cli session-end-hook" }] }] },
        }),
      );

      await installSessionHook({ settings: settingsPath, cliInvocation: FIXTURE_INVOCATION });
      await installSessionHook({ settings: settingsPath, cliInvocation: FIXTURE_INVOCATION });

      const settings = await readSettings(settingsPath);
      expect(allSessionEndCommands(settings)).toHaveLength(1);
      expect(allSessionEndCommands(settings)[0]).toBe(FIXTURE_SESSION_END_CMD);
    });
  });
});

describe("installSessionHook: UserPromptSubmit (prompt-time recall)", () => {
  const FIXTURE_PROMPT_CMD = '"/usr/bin/node" "/opt/membral/dist/index.js" prompt-hook';
  let root: string;
  let settingsPath: string;
  const promptEntries = async () => {
    const s = (await readSettings(settingsPath)) as {
      hooks?: { UserPromptSubmit?: { hooks: { command: string; timeout?: number }[] }[] };
    };
    return (s.hooks?.UserPromptSubmit ?? []).flatMap((g) => g.hooks);
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "membral-install-prompt-hook-"));
    settingsPath = join(root, "settings.json");
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it("installs one UserPromptSubmit entry next to SessionStart, with a 5 s timeout, idempotently", async () => {
    await installSessionHook({ settings: settingsPath, cliInvocation: FIXTURE_INVOCATION });
    await installSessionHook({ settings: settingsPath, cliInvocation: FIXTURE_INVOCATION });
    expect(await promptEntries()).toEqual([{ type: "command", command: FIXTURE_PROMPT_CMD, timeout: 5 }]);
    expect(allSessionStartCommands(await readSettings(settingsPath))).toEqual([FIXTURE_PREAMBLE_CMD]);
  });

  it("upgrades an old entry in place (stale command, no timeout) and keeps a user's larger timeout", async () => {
    await writeFile(
      settingsPath,
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            { hooks: [{ type: "command", command: "echo mine" }] },
            { hooks: [{ type: "command", command: '"/old/node" "/old/index.js" prompt-hook' }] },
          ],
        },
      }),
    );
    await installSessionHook({ settings: settingsPath, cliInvocation: FIXTURE_INVOCATION });
    expect(await promptEntries()).toEqual([
      { type: "command", command: "echo mine" },
      { type: "command", command: FIXTURE_PROMPT_CMD, timeout: 5 },
    ]);

    const s = await readSettings(settingsPath);
    const groups = (s.hooks as Record<string, { hooks: { timeout?: number }[] }[]>).UserPromptSubmit;
    groups[1].hooks[0].timeout = 30;
    await writeFile(settingsPath, JSON.stringify(s));
    await installSessionHook({ settings: settingsPath, cliInvocation: FIXTURE_INVOCATION });
    expect((await promptEntries())[1]).toMatchObject({ command: FIXTURE_PROMPT_CMD, timeout: 30 });
  });

  it("a foreign command that merely contains prompt-hook is never treated as ours", async () => {
    const foreign = "bash ~/.claude/hooks/user-prompt-hook.sh";
    await writeFile(
      settingsPath,
      JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: foreign }] }] } }),
    );
    await installSessionHook({ settings: settingsPath, cliInvocation: FIXTURE_INVOCATION });
    expect(await promptEntries()).toEqual([
      { type: "command", command: foreign },
      { type: "command", command: FIXTURE_PROMPT_CMD, timeout: 5 },
    ]);
    await installSessionHook({ settings: settingsPath, remove: true });
    expect(await promptEntries()).toEqual([{ type: "command", command: foreign }]);
  });

  it("prints the disclosure line when it registers the hook; promptRecall:false removes only our hook", async () => {
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    await installSessionHook({ settings: settingsPath, cliInvocation: FIXTURE_INVOCATION });
    expect(logs).toHaveBeenCalledWith(PROMPT_RECALL_DISCLOSURE);
    expect(PROMPT_RECALL_DISCLOSURE).toContain("membral setup --no-prompt-recall");

    logs.mockClear();
    await installSessionHook({ settings: settingsPath, cliInvocation: FIXTURE_INVOCATION, promptRecall: false });
    expect(logs).not.toHaveBeenCalledWith(PROMPT_RECALL_DISCLOSURE);
    expect(await promptEntries()).toEqual([]);
    expect(allSessionStartCommands(await readSettings(settingsPath))).toEqual([FIXTURE_PREAMBLE_CMD]);
  });

  it("honours a stored opt-out when promptRecall is not passed (install-session-hook, later setups)", async () => {
    const cliConfigPath = join(root, "config.json");
    await installSessionHook({ settings: settingsPath, cliInvocation: FIXTURE_INVOCATION, cliConfigPath });
    expect(await promptEntries()).toHaveLength(1);
    setPromptRecall(false, cliConfigPath);
    await installSessionHook({ settings: settingsPath, cliInvocation: FIXTURE_INVOCATION, cliConfigPath });
    expect(await promptEntries()).toEqual([]);
    setPromptRecall(true, cliConfigPath);
    await installSessionHook({ settings: settingsPath, cliInvocation: FIXTURE_INVOCATION, cliConfigPath });
    expect(await promptEntries()).toHaveLength(1);
  });

  it("the disclosure says what leaves the machine and where it goes", () => {
    for (const fact of ["4+ words", "2,000 chars", "repo and session id", "embeds them", "not stored"]) {
      expect(PROMPT_RECALL_DISCLOSURE).toContain(fact);
    }
  });

  it("--remove takes the prompt hook out and leaves the user's own UserPromptSubmit hooks", async () => {
    await writeFile(
      settingsPath,
      JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo mine" }] }] } }),
    );
    await installSessionHook({ settings: settingsPath, cliInvocation: FIXTURE_INVOCATION });
    await installSessionHook({ settings: settingsPath, remove: true });
    expect(await promptEntries()).toEqual([{ type: "command", command: "echo mine" }]);
  });
});

describe("installSessionHook: Stop hook (open-session upload)", () => {
  let root: string;
  let settingsPath: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "membral-install-stop-hook-"));
    settingsPath = join(root, "settings.json");
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  const stopCmds = async () =>
    (((await readSettings(settingsPath)).hooks?.Stop as HookGroup[] | undefined) ?? []).flatMap((g) =>
      g.hooks.map((h) => h.command),
    );

  it("registers one Stop entry, idempotent, leaving the user's own Stop hooks and the SessionEnd entry alone", async () => {
    await writeFile(
      settingsPath,
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "echo mine" }] }] } }),
    );
    const opts = { settings: settingsPath, cliInvocation: FIXTURE_INVOCATION, promptRecall: false };
    await installSessionHook(opts);
    await installSessionHook(opts);
    expect(await stopCmds()).toEqual(["echo mine", `${FIXTURE_SESSION_END_CMD} --stop`]);
    expect(allSessionEndCommands(await readSettings(settingsPath))).toEqual([FIXTURE_SESSION_END_CMD]);
  });

  it("--remove deletes only the Membral Stop entry", async () => {
    await writeFile(
      settingsPath,
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "echo mine" }] }] } }),
    );
    const opts = { settings: settingsPath, cliInvocation: FIXTURE_INVOCATION, promptRecall: false };
    await installSessionHook(opts);
    await installSessionHook({ ...opts, remove: true });
    expect(await stopCmds()).toEqual(["echo mine"]);
  });
});
