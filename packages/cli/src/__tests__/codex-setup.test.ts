import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RECALL_VS_STATE_FULL } from "@membral/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AGENTS_BEGIN,
  AGENTS_BLOCK,
  AGENTS_END,
  buildCodexMcpTable,
  CODEX_PREAMBLE_TIMEOUT_SEC,
  codexVersionWarning,
  detectCodex,
  mergeAgentsMd,
  mergeCodexConfigToml,
  mergeCodexHooksJson,
  setupCodex,
} from "../codex-setup.js";
import type { CliInvocation } from "../configure.js";
import { saveCredentials } from "../credentials.js";
import { buildMcpHeaders } from "../mcp-headers.js";

const CLI: CliInvocation = { argv: ["/opt/node/bin/node", "/opt/membral/cli/dist/index.js"] };
const API = "https://membral.me";
const TABLE = buildCodexMcpTable(CLI, API);
const KEY = "lls_secret_key_never_in_files_0123";

const REALISTIC = `# Codex config
model = "gpt-5-codex"
approval_policy = "on-request"

[profiles.fast]
model = "gpt-5-mini" # quick one
args = [
  ["nested", "array"],
  "x",
]

# GitHub server
[mcp_servers.github]
command = "gh-mcp"
args = ["--stdio"]

[mcp_servers.github.env]
GH_HOST = "example.test"

# Linear server comes next
[mcp_servers.linear]
url = "https://linear.example.test/mcp"
`;

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "membral-codex-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function run() {
  return setupCodex({ apiUrl: API, codexHome: home, cliInvocation: CLI, codexVersion: null });
}
const read = (f: string) => readFile(join(home, f), "utf-8");

describe("Codex config.toml [mcp_servers.membral]", () => {
  it("fresh write: the exact table, no key", async () => {
    const r = await run();
    expect(r.mcp.outcome).toBe("created");
    expect(await read("config.toml")).toBe(TABLE);
    expect(TABLE).toContain("url = 'https://membral.me/api/mcp'");
    expect(TABLE).toContain(
      `http_headers_helper = '"/opt/node/bin/node" "/opt/membral/cli/dist/index.js" mcp-headers --api-url "https://membral.me"'`,
    );
    expect(TABLE).toContain('default_tools_approval_mode = "approve"');
  });

  it("merges into a realistic file, keeping every other byte, and is idempotent", async () => {
    await writeFile(join(home, "config.toml"), REALISTIC);
    await run();
    const once = await read("config.toml");
    expect(once).toBe(`${REALISTIC}\n${TABLE}`);
    const s1 = await stat(join(home, "config.toml"));
    const r2 = await run();
    expect(r2.mcp.outcome).toBe("unchanged");
    expect(await read("config.toml")).toBe(once);
    expect((await stat(join(home, "config.toml"))).mtimeMs).toBe(s1.mtimeMs);
  });

  it("updates an outdated membral table in place: own keys replaced, the conflicting auth key dropped, sub-tables kept", async () => {
    const old = `model = "x"

[mcp_servers.membral]
url = "https://old.example.test/api/mcp"
bearer_token_env_var = "MEMBRAL_API_KEY"

[mcp_servers.membral.tools.memory_search]
approval_mode = "prompt"

# Linear server comes next
[mcp_servers.linear]
url = "https://linear.example.test/mcp"
`;
    await writeFile(join(home, "config.toml"), old);
    const r = await run();
    expect(r.mcp.outcome).toBe("updated");
    expect(await read("config.toml")).toBe(`model = "x"

${TABLE}
[mcp_servers.membral.tools.memory_search]
approval_mode = "prompt"

# Linear server comes next
[mcp_servers.linear]
url = "https://linear.example.test/mcp"
`);
  });

  it("handles quoted keys, CRLF and a missing trailing newline", () => {
    const crlf = 'a = 1\r\n\r\n[mcp_servers."membral"]\r\nurl = "old"';
    const r = mergeCodexConfigToml(crlf, TABLE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).toBe(
      `a = 1\r\n\r\n${TABLE.replace("[mcp_servers.membral]", '[mcp_servers."membral"]').replace(/\n/g, "\r\n")}`,
    );
    const again = mergeCodexConfigToml(r.text, TABLE);
    expect(again.ok && again.text).toBe(r.text);

    const noNl = mergeCodexConfigToml('a = 1\n[mcp_servers.x]\nurl = "u"', TABLE);
    expect(noNl.ok && noNl.text).toBe(`a = 1\n[mcp_servers.x]\nurl = "u"\n\n${TABLE}`);
  });

  it.each([
    ["inline table", 'mcp_servers = { membral = { url = "x" } }\n'],
    ["dotted key at root", 'mcp_servers.membral.url = "x"\n'],
    ["key inside [mcp_servers]", '[mcp_servers]\nmembral = { url = "x" }\n'],
    ["dotted key inside [mcp_servers]", '[mcp_servers]\nmembral.url = "x"\n'],
    ["array of tables", '[[mcp_servers.membral]]\nurl = "x"\n'],
    ["duplicate table", '[mcp_servers.membral]\nurl = "x"\n[mcp_servers.membral]\nenabled = true\n'],
    ["inline Authorization header", '[mcp_servers.membral]\nhttp_headers = { Authorization = "Bearer x" }\n'],
  ])("unsafe form (%s): file untouched, warning", async (_name, body) => {
    await writeFile(join(home, "config.toml"), body);
    const r = await run();
    expect(r.mcp.outcome).toBe("skipped");
    expect(r.mcp.warning).toMatch(/left untouched/);
    expect(await read("config.toml")).toBe(body);
  });

  it("keeps the user's own keys and sub-tables; drops stdio and auth keys that conflict; idempotent", async () => {
    const mine = `[mcp_servers.membral]
enabled = false
url = "https://old.example.test/api/mcp"
tool_timeout_sec = 120
bearer_token_env_var = "MEMBRAL_API_KEY"
command = "npx"
args = [
  "membral-mcp",
]

[mcp_servers.membral.env]
FOO = "bar"

[mcp_servers.membral.http_headers]
Authorization = "Bearer stale"
X-Team = "codehub"

[mcp_servers.membral.tools.memory_search]
approval_mode = "prompt"
`;
    await writeFile(join(home, "config.toml"), mine);
    await run();
    const once = await read("config.toml");
    expect(once).toBe(`${TABLE}enabled = false
tool_timeout_sec = 120


[mcp_servers.membral.http_headers]
X-Team = "codehub"

[mcp_servers.membral.tools.memory_search]
approval_mode = "prompt"
`);
    expect((await run()).mcp.outcome).toBe("unchanged");
    expect(await read("config.toml")).toBe(once);
  });

  it("writes config.toml.membral.bak once, before the first change, and never overwrites it", async () => {
    const first = 'model = "x"\n';
    await writeFile(join(home, "config.toml"), first);
    await run();
    expect(await read("config.toml.membral.bak")).toBe(first);
    expect((await stat(join(home, "config.toml.membral.bak"))).mode & 0o777).toBe(0o600);
    await writeFile(join(home, "config.toml"), 'model = "y"\n');
    await run();
    expect(await read("config.toml")).toContain('model = "y"');
    expect(await read("config.toml.membral.bak")).toBe(first);
  });

  it("no backup for a fresh file or an unchanged one", async () => {
    await run();
    await run();
    await expect(stat(join(home, "config.toml.membral.bak"))).rejects.toThrow();
  });

  it("triple quotes inside a one-line string do not open a multi-line string (N1)", () => {
    const tq = "'".repeat(3);
    const dq = '"'.repeat(3);
    const body = `a = "has ${tq} inside"\nb = 'has ${dq} inside'\n`;
    const r = mergeCodexConfigToml(body, TABLE);
    expect(r.ok && r.text).toBe(`${body}\n${TABLE}`);
    expect(mergeCodexConfigToml(`a = ${dq}\nopen`, TABLE).ok).toBe(false);
  });

  it("keeps the file mode", async () => {
    await writeFile(join(home, "config.toml"), REALISTIC);
    await chmod(join(home, "config.toml"), 0o640);
    await run();
    expect((await stat(join(home, "config.toml"))).mode & 0o777).toBe(0o640);
  });
});

describe("Codex hooks.json SessionStart", () => {
  const ours = {
    type: "command",
    command: '"/opt/node/bin/node" "/opt/membral/cli/dist/index.js" preamble --hook',
    timeout: CODEX_PREAMBLE_TIMEOUT_SEC,
  };

  it("fresh write", async () => {
    await run();
    expect(JSON.parse(await read("hooks.json"))).toEqual({ hooks: { SessionStart: [{ hooks: [ours] }] } });
    expect(CODEX_PREAMBLE_TIMEOUT_SEC).toBe(25);
  });

  it("merges with a foreign hook, replaces an old Membral one, idempotent, never writes a trusted_hash", async () => {
    const foreign = { matcher: "startup", hooks: [{ type: "command", command: "echo hi" }] };
    const stale = { hooks: [{ type: "command", command: '"/old/node" "/old/@membral/cli/index.js" preamble --hook' }] };
    const body = {
      description: "mine",
      hooks: { SessionStart: [foreign, stale], Stop: [{ hooks: [{ type: "command", command: "say done" }] }] },
    };
    await writeFile(join(home, "hooks.json"), JSON.stringify(body));
    const r = await run();
    expect(r.hooks.outcome).toBe("updated");
    const once = await read("hooks.json");
    expect(JSON.parse(once)).toEqual({
      description: "mine",
      hooks: { SessionStart: [foreign, { hooks: [ours] }], Stop: body.hooks.Stop },
    });
    expect(once).not.toContain("trusted_hash");
    expect((await run()).hooks.outcome).toBe("unchanged");
    expect(await read("hooks.json")).toBe(once);
  });

  it("never moves a foreign handler: ours is updated in place, extras removed only where nothing foreign follows", () => {
    const old = (p: string) => ({
      type: "command",
      command: `"/old/node" "/old/${p}/membral/index.js" preamble --hook`,
    });
    const user = (c: string) => ({ type: "command", command: c });
    const body = {
      hooks: {
        SessionStart: [
          { hooks: [old("a"), user("my-hook.sh")] },
          { hooks: [old("b")] },
          { matcher: "resume", hooks: [user("user.sh"), old("c"), user("after.sh")] },
          { hooks: [old("d")] },
        ],
      },
    };
    const positions = (groups: { hooks: { command: string }[] }[]) =>
      groups.flatMap((g, gi) =>
        g.hooks.map((h, hi) => [h.command, `${gi}:${hi}`]).filter(([c]) => !String(c).includes("preamble --hook")),
      );
    const r = mergeCodexHooksJson(JSON.stringify(body), CLI);
    expect(r.ok).toBe(true);
    if (!r.ok || !r.text) throw new Error("expected a write");
    const next = JSON.parse(r.text).hooks.SessionStart;
    expect(positions(next)).toEqual(positions(body.hooks.SessionStart));
    expect(next[0].hooks[0]).toEqual(ours);
    expect(next[1]).toEqual({ hooks: [] });
    expect(next[2].hooks[1]).toEqual(ours);
    expect(next).toHaveLength(3);
    expect(r.warning).toMatch(/1 extra Membral/);
    const again = mergeCodexHooksJson(r.text, CLI);
    expect(again.ok && again.text).toBeUndefined();
  });

  it("appends a new group when no Membral handler exists, leaving every foreign group where it was", () => {
    const body = { hooks: { SessionStart: [{ hooks: [{ type: "command", command: "a.sh" }] }] } };
    const r = mergeCodexHooksJson(JSON.stringify(body), CLI);
    expect(r.ok && r.text && JSON.parse(r.text).hooks.SessionStart).toEqual([
      body.hooks.SessionStart[0],
      { hooks: [ours] },
    ]);
  });

  it("invalid JSON: untouched, warning", async () => {
    await writeFile(join(home, "hooks.json"), "{nope");
    const r = await run();
    expect(r.hooks.outcome).toBe("skipped");
    expect(await read("hooks.json")).toBe("{nope");
  });
});

describe("Codex AGENTS.md block", () => {
  it("created when absent, carries the shared recall-vs-state rule", async () => {
    await run();
    expect(await read("AGENTS.md")).toBe(`${AGENTS_BLOCK}\n`);
    expect(AGENTS_BLOCK).toBe(`${AGENTS_BEGIN}\n${RECALL_VS_STATE_FULL}\n${AGENTS_END}`);
    expect(AGENTS_BLOCK).toContain("It is not live state.");
  });

  it("inserted after existing text, replaced in place, idempotent", async () => {
    await writeFile(join(home, "AGENTS.md"), "# Mine\nUse tabs.\n");
    await run();
    expect(await read("AGENTS.md")).toBe(`# Mine\nUse tabs.\n\n${AGENTS_BLOCK}\n`);
    await writeFile(join(home, "AGENTS.md"), `top\n${AGENTS_BEGIN}\nold text\n${AGENTS_END}\nbottom\n`);
    expect((await run()).agents.outcome).toBe("updated");
    const once = await read("AGENTS.md");
    expect(once).toBe(`top\n${AGENTS_BLOCK}\nbottom\n`);
    expect((await run()).agents.outcome).toBe("unchanged");
    expect(await read("AGENTS.md")).toBe(once);
  });

  it("begin marker without end: left alone", () => {
    expect(mergeAgentsMd(`x\n${AGENTS_BEGIN}\nno end\n`)).toBeNull();
  });
});

describe("Codex: no key in any written file; mcp-headers supplies it", () => {
  it("writes no key, and the helper prints the header only for the matching server", async () => {
    const creds = join(home, "credentials.json");
    saveCredentials({ apiUrl: API, apiKey: KEY, email: "a@b.test", userId: "u", createdAt: "now" }, creds);
    await mkdir(home, { recursive: true });
    await run();
    for (const f of ["config.toml", "hooks.json", "AGENTS.md"]) expect(await read(f)).not.toContain(KEY);
    expect(buildMcpHeaders(API, creds)).toBe(`{"Authorization":"Bearer ${KEY}"}\n`);
    expect(buildMcpHeaders(`${API}/`, creds)).toBe(`{"Authorization":"Bearer ${KEY}"}\n`);
    expect(buildMcpHeaders("http://localhost:3000", creds)).toBeNull();
    expect(buildMcpHeaders(undefined, creds)).toBeNull();
  });
});

describe("codexVersionWarning (N4)", () => {
  it("warns below 0.152.0 only; unreadable output is no warning", () => {
    expect(codexVersionWarning("codex-cli 0.151.0")).toMatch(/older than 0\.152\.0/);
    expect(codexVersionWarning("codex-cli 0.152.0")).toBeUndefined();
    expect(codexVersionWarning("codex-cli 0.160.2")).toBeUndefined();
    expect(codexVersionWarning("codex-cli 1.0.0")).toBeUndefined();
    expect(codexVersionWarning(null)).toBeUndefined();
    expect(codexVersionWarning("garbage")).toBeUndefined();
  });

  it("setupCodex surfaces it", async () => {
    const r = await setupCodex({ apiUrl: API, codexHome: home, cliInvocation: CLI, codexVersion: "codex-cli 0.150.1" });
    expect(r.versionWarning).toMatch(/0\.150\.1/);
  });
});

describe("detectCodex", () => {
  it("off: no codex on PATH, no CODEX_HOME dir", async () => {
    expect(await detectCodex({ env: { PATH: join(home, "bin"), CODEX_HOME: join(home, "missing") } })).toBe(false);
  });
  it("on: CODEX_HOME exists", async () => {
    expect(await detectCodex({ env: { PATH: "", CODEX_HOME: home } })).toBe(true);
  });
  it("on: codex on PATH", async () => {
    await mkdir(join(home, "bin"));
    await writeFile(join(home, "bin", "codex"), "");
    expect(await detectCodex({ env: { PATH: join(home, "bin"), CODEX_HOME: join(home, "missing") } })).toBe(true);
  });
});
