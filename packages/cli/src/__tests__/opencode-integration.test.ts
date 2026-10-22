// opencode MCP config merge + capture plugin. Everything lives in a temp
// config dir — never the real ~/.config/opencode.
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildOpencodePluginSource,
  configureOpencodeMcp,
  defaultOpencodePluginPath,
  installOpencodePlugin,
} from "../opencode-integration.js";

const INVOCATION = { argv: ["/usr/bin/node", "/opt/membral/dist/index.js"] };
const ENTRY = {
  type: "remote",
  url: "http://localhost:3000/api/mcp",
  headers: { Authorization: "Bearer lls_local" },
  enabled: true,
};

describe("configureOpencodeMcp", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "membral-opencode-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const run = () => configureOpencodeMcp({ apiUrl: "http://localhost:3000/", apiKey: "lls_local", configDir: dir });

  it("creates opencode.json when none exists", async () => {
    const r = await run();
    expect(r.success).toBe(true);
    const cfg = JSON.parse(readFileSync(join(dir, "opencode.json"), "utf8"));
    expect(cfg.mcp.membral).toEqual(ENTRY);
    expect(cfg.$schema).toBe("https://opencode.ai/config.json");
  });

  it("merges into an existing config, keeping every other key, and backs it up", async () => {
    const original = JSON.stringify({ model: "x/y", plugin: ["a"], mcp: { other: { type: "local", command: ["z"] } } });
    writeFileSync(join(dir, "opencode.json"), original);

    await run();

    const cfg = JSON.parse(readFileSync(join(dir, "opencode.json"), "utf8"));
    expect(cfg.model).toBe("x/y");
    expect(cfg.plugin).toEqual(["a"]);
    expect(cfg.mcp.other).toEqual({ type: "local", command: ["z"] });
    expect(cfg.mcp.membral).toEqual(ENTRY);
    expect(readFileSync(join(dir, "opencode.json.membral.bak"), "utf8")).toBe(original);
  });

  it("the .membral.bak (which may hold the previous Bearer key) is mode 0600", async () => {
    writeFileSync(
      join(dir, "opencode.json"),
      JSON.stringify({ mcp: { membral: { headers: { Authorization: "Bearer old" } } } }),
      {
        mode: 0o644,
      },
    );
    await run();
    expect(statSync(join(dir, "opencode.json.membral.bak")).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "opencode.json")).mode & 0o777).toBe(0o600);
  });

  it("is idempotent and re-points on a URL change", async () => {
    await run();
    const r2 = await run();
    expect(r2.message).toContain("already points");

    await configureOpencodeMcp({ apiUrl: "https://membral.me", apiKey: "lls_prod", configDir: dir });
    const cfg = JSON.parse(readFileSync(join(dir, "opencode.json"), "utf8"));
    expect(cfg.mcp.membral.url).toBe("https://membral.me/api/mcp");
  });

  it("never rewrites an opencode.jsonc with comments — prints the snippet instead", async () => {
    const jsonc = '{\n  // my settings\n  "model": "x/y"\n}\n';
    writeFileSync(join(dir, "opencode.jsonc"), jsonc);

    const r = await run();

    expect(r.success).toBe(true);
    expect(r.message).toContain("left it untouched");
    expect(r.message).toContain('"membral"');
    expect(readFileSync(join(dir, "opencode.jsonc"), "utf8")).toBe(jsonc);
    expect(existsSync(join(dir, "opencode.json"))).toBe(false);
  });

  it("writes an opencode.jsonc that is plain JSON", async () => {
    writeFileSync(join(dir, "opencode.jsonc"), '{"model":"x/y"}');
    await run();
    const cfg = JSON.parse(readFileSync(join(dir, "opencode.jsonc"), "utf8"));
    expect(cfg.model).toBe("x/y");
    expect(cfg.mcp.membral).toEqual(ENTRY);
  });

  it("writes through a symlinked opencode.json, keeping the link", async () => {
    const real = join(dir, "dotfiles-opencode.json");
    writeFileSync(real, '{"model":"x/y"}');
    symlinkSync(real, join(dir, "opencode.json"));

    await run();

    expect(lstatSync(join(dir, "opencode.json")).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(real, "utf8")).mcp.membral).toEqual(ENTRY);
  });
});

describe("installOpencodePlugin", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "membral-opencode-plugin-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes plugin/membral.js with a version marker, idempotently", async () => {
    const logPath = join(dir, "logs", "opencode-plugin.log");
    const r1 = await installOpencodePlugin({ configDir: dir, logPath, cliInvocation: INVOCATION });
    const r2 = await installOpencodePlugin({ configDir: dir, logPath, cliInvocation: INVOCATION });

    const path = defaultOpencodePluginPath(dir);
    expect(path).toBe(join(dir, "plugin", "membral.js"));
    expect(r1.message).toContain("Installed");
    expect(r2.message).toContain("already installed");
    const src = readFileSync(path, "utf8");
    expect(src.split("\n")[0]).toMatch(/membral-opencode-plugin v\d+/);
    expect(src).toContain('"session.idle"');
    expect(src).toContain(JSON.stringify(INVOCATION.argv));
  });

  it("upgrades an older Membral plugin but never overwrites a foreign file", async () => {
    mkdirSync(join(dir, "plugin"), { recursive: true });
    const path = defaultOpencodePluginPath(dir);

    writeFileSync(path, "// membral-opencode-plugin v0\nexport const Old = async () => ({});\n");
    const up = await installOpencodePlugin({ configDir: dir, cliInvocation: INVOCATION });
    expect(up.message).toContain("Upgraded");

    writeFileSync(path, "export const Mine = async () => ({});\n");
    const foreign = await installOpencodePlugin({ configDir: dir, cliInvocation: INVOCATION });
    expect(foreign.success).toBe(false);
    expect(readFileSync(path, "utf8")).toBe("export const Mine = async () => ({});\n");
  });

  it("dry-run writes nothing", async () => {
    const r = await installOpencodePlugin({ configDir: dir, cliInvocation: INVOCATION, dryRun: true });
    expect(r.message).toContain("[dry-run]");
    expect(existsSync(defaultOpencodePluginPath(dir))).toBe(false);
  });

  it("the plugin exports only functions, ignores other events, and spawns a debounced sessions upload on session.idle", async () => {
    // A fake CLI entry that appends its argv to a file — run by the real node.
    const recordPath = join(dir, "argv.log");
    const fakeCli = join(dir, "fake-cli.mjs");
    writeFileSync(
      fakeCli,
      `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(recordPath)}, JSON.stringify(process.argv.slice(2)) + "\\n");\n`,
    );
    const pluginFile = join(dir, "membral.mjs");
    writeFileSync(pluginFile, buildOpencodePluginSource({ argv: [process.execPath, fakeCli] }, join(dir, "p.log")));

    const mod = await import(pathToFileURL(pluginFile).href);
    for (const v of Object.values(mod)) expect(typeof v).toBe("function");
    const hooks = await (Object.values(mod)[0] as () => Promise<{ event: (i: unknown) => Promise<void> }>)();

    await hooks.event({ event: { type: "message.updated", properties: {} } });
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } });
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } }); // debounced
    await expect(hooks.event({ event: null })).resolves.toBeUndefined();

    const deadline = Date.now() + 5000;
    while (!existsSync(recordPath) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 200));
    const runs = readFileSync(recordPath, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(runs).toHaveLength(1);
    expect(runs[0].slice(0, 3)).toEqual(["sessions", "--source", "opencode"]);
    expect(runs[0][3]).toBe("--since");
    expect(Date.parse(runs[0][4])).toBeLessThan(Date.now() - 9 * 60_000);
    expect(runs[0][5]).toBe("--yes");
  });

  describe("preamble injection", () => {
    // A fake CLI: records argv + stdin, prints PREAMBLE_OUT (default text), optionally hangs or exits 1.
    function setup(name: string, body: string, srcOpts = {}) {
      const fakeCli = join(dir, `${name}-cli.mjs`);
      writeFileSync(fakeCli, body);
      const pluginFile = join(dir, `${name}.mjs`);
      writeFileSync(
        pluginFile,
        buildOpencodePluginSource({ argv: [process.execPath, fakeCli] }, join(dir, `${name}.log`), srcOpts),
      );
      return pluginFile;
    }
    const load = async (pluginFile: string) => {
      const mod = await import(pathToFileURL(pluginFile).href);
      return (await (
        Object.values(mod)[0] as (i: unknown) => Promise<Record<string, (...a: unknown[]) => Promise<void>>>
      )({
        directory: "/work/repo",
      })) as Record<string, (...a: unknown[]) => Promise<void>>;
    };
    const printer = (recordPath: string) =>
      `import { appendFileSync } from "node:fs";
let d = ""; process.stdin.on("data", (c) => (d += c)); process.stdin.on("end", () => {
  appendFileSync(${JSON.stringify(recordPath)}, JSON.stringify({ argv: process.argv.slice(2), stdin: d }) + "\\n");
  process.stdout.write("MEMBRAL PREAMBLE\\n- a line\\n");
});\n`;

    it("registers both hooks; a cache hit pushes the text on every request, fetched once", async () => {
      const rec = join(dir, "pre1.log");
      const hooks = await load(setup("pre1", printer(rec)));
      expect(typeof hooks["experimental.chat.system.transform"]).toBe("function");
      expect(typeof hooks.event).toBe("function");

      await hooks.event({ event: { type: "session.created", properties: { info: { id: "s1", directory: "/x/y" } } } });
      const out1 = { system: ["base"] };
      await hooks["experimental.chat.system.transform"]({ sessionID: "s1", model: {} }, out1);
      const out2 = { system: ["base"] };
      await hooks["experimental.chat.system.transform"]({ sessionID: "s1", model: {} }, out2);
      expect(out1.system).toEqual(["base", "MEMBRAL PREAMBLE\n- a line"]);
      expect(out2.system).toEqual(out1.system);

      const runs = readFileSync(rec, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      expect(runs).toHaveLength(1);
      expect(runs[0].argv).toEqual(["preamble", "--hook", "--format", "text"]);
      expect(JSON.parse(runs[0].stdin)).toEqual({ cwd: "/x/y", session_id: "s1" });
    });

    it("lazily fetches with the plugin directory when no session.created was seen", async () => {
      const rec = join(dir, "pre2.log");
      const hooks = await load(setup("pre2", printer(rec)));
      const out = { system: [] as string[] };
      await hooks["experimental.chat.system.transform"]({ sessionID: "s9", model: {} }, out);
      expect(out.system).toHaveLength(1);
      expect(JSON.parse(JSON.parse(readFileSync(rec, "utf8").trim()).stdin).cwd).toBe("/work/repo");
    });

    it("skips sub-agent sessions (session.created with a parentID): no fetch, nothing pushed (F6)", async () => {
      const rec = join(dir, "pre7.log");
      const hooks = await load(setup("pre7", printer(rec)));
      await hooks.event({
        event: { type: "session.created", properties: { info: { id: "child", parentID: "s1", directory: "/x/y" } } },
      });
      const out = { system: ["base"] };
      await hooks["experimental.chat.system.transform"]({ sessionID: "child", model: {} }, out);
      expect(out.system).toEqual(["base"]);
      expect(existsSync(rec)).toBe(false);

      const top = { system: ["base"] };
      await hooks["experimental.chat.system.transform"]({ sessionID: "s1", model: {} }, top);
      expect(top.system).toEqual(["base", "MEMBRAL PREAMBLE\n- a line"]);
    });

    it("an empty fetch is retried once after the retry window, not on every request (N3)", async () => {
      const rec = join(dir, "pre8.log");
      const flag = join(dir, "pre8.ok");
      // Prints nothing until the flag file exists.
      const body = `import { appendFileSync, existsSync } from "node:fs";
let d = ""; process.stdin.on("data", (c) => (d += c)); process.stdin.on("end", () => {
  appendFileSync(${JSON.stringify(rec)}, "run\\n");
  if (existsSync(${JSON.stringify(flag)})) process.stdout.write("LATE PREAMBLE\\n");
});\n`;
      const hooks = await load(setup("pre8", body, { preambleRetryMs: 200 }));
      const t = hooks["experimental.chat.system.transform"];
      const o1 = { system: [] as string[] };
      await t({ sessionID: "s1", model: {} }, o1);
      expect(o1.system).toEqual([]);
      writeFileSync(flag, "");
      const o2 = { system: [] as string[] };
      await t({ sessionID: "s1", model: {} }, o2);
      expect(o2.system).toEqual([]); // inside the window: cached ""
      await new Promise((r) => setTimeout(r, 250));
      const o3 = { system: [] as string[] };
      await t({ sessionID: "s1", model: {} }, o3);
      expect(o3.system).toEqual(["LATE PREAMBLE"]);
      const runs = () => readFileSync(rec, "utf8").trim().split("\n").length;
      expect(runs()).toBe(2);
      await t({ sessionID: "s1", model: {} }, { system: [] });
      expect(runs()).toBe(2);
    });

    it("a missing sessionID is a no-op", async () => {
      const rec = join(dir, "pre3.log");
      const hooks = await load(setup("pre3", printer(rec)));
      const out = { system: ["base"] };
      await hooks["experimental.chat.system.transform"]({ model: {} }, out);
      expect(out.system).toEqual(["base"]);
      expect(existsSync(rec)).toBe(false);
    });

    it("a slow CLI times out: nothing pushed, no throw", async () => {
      const hooks = await load(
        setup("pre4", "setInterval(() => {}, 1000);\n", { preambleWaitMs: 100, preambleKillMs: 300 }),
      );
      const out = { system: ["base"] };
      const t0 = Date.now();
      await expect(
        hooks["experimental.chat.system.transform"]({ sessionID: "s1", model: {} }, out),
      ).resolves.toBeUndefined();
      expect(Date.now() - t0).toBeLessThan(2000);
      expect(out.system).toEqual(["base"]);
    });

    it("a spawn error or failing CLI pushes nothing and never throws", async () => {
      const pluginFile = join(dir, "pre5.mjs");
      writeFileSync(
        pluginFile,
        buildOpencodePluginSource({ argv: ["/nonexistent/node-binary", "x"] }, join(dir, "pre5.log")),
      );
      const hooks = await load(pluginFile);
      const out = { system: ["base"] };
      await expect(
        hooks["experimental.chat.system.transform"]({ sessionID: "s1", model: {} }, out),
      ).resolves.toBeUndefined();
      expect(out.system).toEqual(["base"]);

      const failing = await load(setup("pre6", "process.exit(1);\n"));
      const out2 = { system: ["base"] };
      await failing["experimental.chat.system.transform"]({ sessionID: "s1", model: {} }, out2);
      expect(out2.system).toEqual(["base"]);
    });
  });

  it("debounce is global: idles from many sessions collapse into one immediate run plus one trailing run; the log rotates past 1 MB", async () => {
    const recordPath = join(dir, "argv-global.log");
    const fakeCli = join(dir, "fake-cli-global.mjs");
    writeFileSync(
      fakeCli,
      `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(recordPath)}, JSON.stringify(process.argv.slice(2)) + "\\n");\n`,
    );
    const logPath = join(dir, "plugin.log");
    writeFileSync(logPath, "x".repeat(1024 * 1024 + 1));
    const pluginFile = join(dir, "membral-global.mjs");
    writeFileSync(
      pluginFile,
      buildOpencodePluginSource({ argv: [process.execPath, fakeCli] }, logPath, { minIntervalMs: 400 }),
    );
    const mod = await import(pathToFileURL(pluginFile).href);
    const hooks = await (Object.values(mod)[0] as () => Promise<{ event: (i: unknown) => Promise<void> }>)();

    for (const id of ["parent", "sub1", "sub2", "sub3"]) {
      await hooks.event({ event: { type: "session.idle", properties: { sessionID: id } } });
    }
    expect(existsSync(`${logPath}.1`)).toBe(true);

    const count = () =>
      existsSync(recordPath) ? readFileSync(recordPath, "utf8").trim().split("\n").filter(Boolean).length : 0;
    const deadline = Date.now() + 5000;
    while (count() < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 300));
    expect(count()).toBe(2);
  });
});
