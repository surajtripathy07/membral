// The help/version/dispatch surface (issue #138, ADR 0050). Two kinds of
// assertion, deliberately kept in one file per the task spec:
//
//   1. Spawn tests that run the BUILT `dist/index.js` and assert stdout +
//      exit code together — a green test on an exported string constant is
//      fully compatible with index.ts keeping its own separate literal, or
//      with -h/help/no-args/unknown taking a different code path. Only a
//      real spawn can catch that class of bug.
//   2. A registry-membership test (test-supersede, step 3C-4: formerly a
//      case-label scan of index.ts's source text, before the switch became
//      the COMMANDS registry in commands/index.ts) that confirms every
//      hidden command still has a live registry entry — the only
//      non-vacuous way to assert "hidden but still dispatched" without
//      executing daemons, hooks, and other side-effecting commands for
//      real.
//
// item 0: fail loud, not mysteriously, if dist/ is stale or missing.
import { execFile as execFileCb } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import { COMMANDS } from "../commands/index.js";
import { ALL_COMMANDS_HELP, HELP, HIDDEN_COMMANDS, PUBLIC_COMMANDS, TOP_LEVEL_HELP } from "../help.js";

const execFile = promisify(execFileCb);
const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_BIN = resolve(__dirname, "../../dist/index.js");

interface Run {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function run(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<Run> {
  try {
    const { stdout, stderr } = await execFile(process.execPath, [CLI_BIN, ...args], { env, timeout: 10_000 });
    return { stdout, stderr, exitCode: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number | string };
    return {
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
      exitCode: typeof e.code === "number" ? e.code : 1,
    };
  }
}

// Every spawn runs with MEMBRAL_API_KEY stripped and, unless a test passes
// its own, an empty temp HOME — so the result never depends on whatever the
// outer shell exports or on the developer's real ~/.membral (F7).
const emptyHome = mkdtempSync(join(tmpdir(), "membral-help-home-"));
function cleanEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, HOME: emptyHome, ...overrides };
  delete env.MEMBRAL_API_KEY;
  return env;
}

beforeAll(() => {
  if (!existsSync(CLI_BIN)) {
    throw new Error("dist/index.js missing — run 'npx turbo build --filter=@membral/cli' first");
  }
});

describe("membral --help / -h / help — all byte-identical, exit 0", () => {
  it("--help prints TOP_LEVEL_HELP exactly and exits 0", async () => {
    const r = await run(["--help"], cleanEnv());
    expect(r.stdout).toBe(`${TOP_LEVEL_HELP}\n`);
    expect(r.exitCode).toBe(0);
  });

  it("-h is byte-identical to --help", async () => {
    const [dash, long] = await Promise.all([run(["-h"], cleanEnv()), run(["--help"], cleanEnv())]);
    expect(dash.stdout).toBe(long.stdout);
    expect(dash.exitCode).toBe(0);
  });

  it("help is byte-identical to --help", async () => {
    const [bare, long] = await Promise.all([run(["help"], cleanEnv()), run(["--help"], cleanEnv())]);
    expect(bare.stdout).toBe(long.stdout);
    expect(bare.exitCode).toBe(0);
  });

  it("no args is byte-identical to --help (D11)", async () => {
    const [none, long] = await Promise.all([run([], cleanEnv()), run(["--help"], cleanEnv())]);
    expect(none.stdout).toBe(long.stdout);
    expect(none.exitCode).toBe(0);
  });
});

describe("membral help --all", () => {
  it("lists only the hook internals (HIDDEN_COMMANDS), one line each", async () => {
    const r = await run(["help", "--all"], cleanEnv());
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(`${ALL_COMMANDS_HELP}\n`);
    for (const name of HIDDEN_COMMANDS) {
      expect(r.stdout).toContain(name);
    }
  });

  // 2026-09-12 refocus goal, W4/D5: `help --all` is the hook-internals
  // escape hatch only — the seven public commands already have their own
  // listing in TOP_LEVEL_HELP, so this block must name exactly the hidden
  // commands and nothing else (no re-listing of setup/login/etc.).
  it("names exactly HIDDEN_COMMANDS as command entries, not the public ones", () => {
    const entryLines = ALL_COMMANDS_HELP.split("\n").filter((l) => /^ {2}\S/.test(l));
    const listedNames = entryLines.map((l) => l.trim().split(/\s+/)[0]);
    expect(new Set(listedNames)).toEqual(new Set(HIDDEN_COMMANDS));
  });

  // MIN-1 (review-138-impl.md): the ALL_HELP block is bound by the same
  // §2.4 rule 5 cap (88) that TOP_LEVEL_HELP's width test already covers —
  // this repo tightens that to 84, matching the top-level block's own
  // measured width, so it wraps on neither an 80- nor a 100-column terminal.
  it("every indented line is at most 84 columns", () => {
    for (const line of ALL_COMMANDS_HELP.split("\n")) {
      if (/^ {2}\S/.test(line)) {
        expect(line.length).toBeLessThanOrEqual(84);
      }
    }
  });
});

describe("membral --version / -v (D10)", () => {
  it("--version prints package.json's version + newline, exit 0", async () => {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, "../../package.json"), "utf8"));
    const r = await run(["--version"], cleanEnv());
    expect(r.stdout).toBe(`${pkg.version}\n`);
    expect(r.exitCode).toBe(0);
  });

  it("-v is byte-identical to --version", async () => {
    const [dash, long] = await Promise.all([run(["-v"], cleanEnv()), run(["--version"], cleanEnv())]);
    expect(dash.stdout).toBe(long.stdout);
    expect(dash.exitCode).toBe(0);
  });
});

describe("unknown command", () => {
  it("nonsense: stderr names it, stdout ends with TOP_LEVEL_HELP, exit 1", async () => {
    const r = await run(["nonsense"], cleanEnv());
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("Unknown command: nonsense");
    expect(r.stdout.endsWith(`${TOP_LEVEL_HELP}\n`)).toBe(true);
  });

  it("nonsense --help: unknown-command error wins over the help guard, exit 1 (not 0)", async () => {
    const r = await run(["nonsense", "--help"], cleanEnv());
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("Unknown command: nonsense");
    expect(r.stdout.endsWith(`${TOP_LEVEL_HELP}\n`)).toBe(true);
  });
});

describe("per-command help does not fire on a flag VALUE that looks like --help", () => {
  it('sessions --source "--help" does NOT print help — it runs the (dry-run, offline) import instead', async () => {
    const r = await run(["sessions", "--source", "--help", "--dry-run"], cleanEnv());
    expect(r.stdout).not.toBe(`${TOP_LEVEL_HELP}\n`);
    expect(r.stdout).not.toBe(HELP.sessions);
    // Whatever it printed, it was not the help block.
    expect(r.stdout.includes("Usage\n  membral sessions")).toBe(false);
  }, 15_000);
});

describe("per-command help — data-loss guard (B1)", () => {
  let tmpHome: string;

  beforeAll(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "membral-help-test-"));
    // ~/.membral/credentials.json — the file `logout` deletes for real.
    const membralDir = join(tmpHome, ".membral");
    mkdirSync(membralDir, { recursive: true });
    writeFileSync(
      join(membralDir, "credentials.json"),
      JSON.stringify({ apiKey: "test-key", apiUrl: "http://example.test" }),
    );
  });

  it("logout --help exits 0 and leaves credentials.json untouched — the single most important assertion in this file", async () => {
    const credPath = join(tmpHome, ".membral", "credentials.json");
    const before = readFileSync(credPath, "utf8");
    const r = await run(["logout", "--help"], cleanEnv({ HOME: tmpHome }));
    expect(r.exitCode).toBe(0);
    expect(existsSync(credPath)).toBe(true);
    expect(readFileSync(credPath, "utf8")).toBe(before);
    expect(r.stdout).toBe(`${HELP.logout}\n`);
  });

  it("logout -h: same guard, same result", async () => {
    const credPath = join(tmpHome, ".membral", "credentials.json");
    const before = readFileSync(credPath, "utf8");
    const r = await run(["logout", "-h"], cleanEnv({ HOME: tmpHome }));
    expect(r.exitCode).toBe(0);
    expect(existsSync(credPath)).toBe(true);
    expect(readFileSync(credPath, "utf8")).toBe(before);
  });
});

// MIN-2 (review-138-impl.md): §5.1 item 10 — whoami --help and status --help
// were verified by hand in the review, not automated. Both parse flags but
// (at HEAD) ignore flags.help for their real command bodies, so this pins
// the before-any-side-effect guard for the two names that fail that way,
// distinct from logout's zero-parseFlags failure covered above. Run under a
// temp HOME seeded with fake credentials: exit 0, the real help block (not
// account/status output), and no side effect — proxy evidence of no network
// call, since whoamiCommand/statusCommand would otherwise hit the API and
// print account info instead of the help usage block.
describe("per-command help — whoami and status (§5.1 item 10)", () => {
  let tmpHome: string;
  let credPath: string;

  beforeAll(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "membral-help-test-whoami-status-"));
    const membralDir = join(tmpHome, ".membral");
    mkdirSync(membralDir, { recursive: true });
    credPath = join(membralDir, "credentials.json");
    writeFileSync(credPath, JSON.stringify({ apiKey: "test-key", apiUrl: "http://10.255.255.1:1" }));
  });

  it("whoami --help: exits 0, prints whoami's own help block, credentials untouched, no network call", async () => {
    const before = readFileSync(credPath, "utf8");
    const r = await run(["whoami", "--help"], cleanEnv({ HOME: tmpHome }));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(`${HELP.whoami}\n`);
    expect(readFileSync(credPath, "utf8")).toBe(before);
  });

  it("status --help: exits 0, prints status's own help block, credentials untouched, no network call", async () => {
    const before = readFileSync(credPath, "utf8");
    const r = await run(["status", "--help"], cleanEnv({ HOME: tmpHome }));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(`${HELP.status}\n`);
    expect(readFileSync(credPath, "utf8")).toBe(before);
  });
});

describe("per-command help — the other public commands", () => {
  it.each(PUBLIC_COMMANDS)("%s --help exits 0 and prints that command's own block", async (name) => {
    const r = await run([name, "--help"], cleanEnv());
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(`${HELP[name]}\n`);
  });

  it("setup -h exits 0, produces setup's block, does not run the wizard (no hang)", async () => {
    const r = await run(["setup", "-h"], cleanEnv());
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(`${HELP.setup}\n`);
  });
});

describe("the import-sessions -> sessions rename (D2/D7) — old name fully removed, no alias", () => {
  it("sessions --help works", async () => {
    const r = await run(["sessions", "--help"], cleanEnv());
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(`${HELP.sessions}\n`);
  });

  it("import-sessions is gone — treated as an unknown command, not an alias", async () => {
    const r = await run(["import-sessions", "--help"], cleanEnv());
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("Unknown command: import-sessions");
  });
});

// #143 follow-up: `--root` used to be silently applied only when
// `--source claude-code` was given (or implied) — an opencode root passed
// via `--root` was dropped on the floor and the real
// `~/.local/share/opencode` got scanned instead. With no `--source` at all,
// `membral sessions` walks BOTH harnesses, so a bare `--root` has no single
// harness to apply to — refuse it outright rather than guessing (and
// possibly scanning/uploading the wrong, real directory).
describe("sessions --root requires --source (#143 follow-up)", () => {
  it("--root without --source exits 1 with a one-line error, no import attempted", async () => {
    const r = await run(["sessions", "--root", "/tmp/wherever", "--dry-run"], cleanEnv());
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain(
      "--root needs --source <claude-code|opencode|copilot-cli|codex> because each harness has its own root",
    );
    expect(r.stdout).toBe("");
  });

  it("--root WITH --source opencode is accepted (does not hit the guard)", async () => {
    const r = await run(["sessions", "--root", "/tmp/wherever", "--source", "opencode", "--dry-run"], cleanEnv());
    expect(r.stderr).not.toContain("--root needs --source");
  });
});

describe("TOP_LEVEL_HELP copy rules", () => {
  it("is at most 40 lines", () => {
    expect(TOP_LEVEL_HELP.split("\n").length).toBeLessThanOrEqual(40);
  });

  it("names every public command and none of the hidden ones", () => {
    for (const name of PUBLIC_COMMANDS) expect(TOP_LEVEL_HELP).toContain(name);
    for (const name of HIDDEN_COMMANDS) expect(TOP_LEVEL_HELP).not.toContain(name);
  });

  it("never says npx @membral/cli, cites no ADR/issue numbers, and doesn't apologize", () => {
    expect(TOP_LEVEL_HELP).not.toMatch(/npx @membral|ADR\s*\d|stopgap|demo command|deliverable|NON-NEGOTIABLE/i);
  });

  it("every indented line is at most 84 columns", () => {
    for (const line of TOP_LEVEL_HELP.split("\n")) {
      if (/^ {2}\S/.test(line)) {
        expect(line.length).toBeLessThanOrEqual(84);
      }
    }
  });

  it("PUBLIC_COMMANDS is exactly the 12 public names (2026-09-12 refocus goal W4/D5 — 'help' is now one of them; 'use' added for profiles; 'local' — W7; 'up', 'down', 'logs' — embedded-store server)", () => {
    expect(new Set(PUBLIC_COMMANDS)).toEqual(
      new Set([
        "setup",
        "login",
        "logout",
        "use",
        "status",
        "import",
        "sessions",
        "local",
        "up",
        "down",
        "logs",
        "help",
      ]),
    );
  });

  it("sweep help says MEMBRAL_SWEEP_FETCH=1 runs git fetch --prune in your checkout", () => {
    const text = HELP.sweep;
    expect(text).toContain("MEMBRAL_SWEEP_FETCH=1");
    expect(text).toContain("git fetch --prune origin");
  });

  it("session-end-hook help documents --stop", () => {
    expect(HELP["session-end-hook"]).toContain("--stop");
  });

  it("HIDDEN_COMMANDS is exactly the 10 hidden names ('dogfood' — recall-precision W3b) ('sweep' added for the launchd backstop; 'mcp' — stdio MCP server; 'mcp-headers' — W9, Codex's http_headers_helper; 'prompt-hook' — prompt-time recall) (import-sessions is REMOVED, not hidden — D7(c); start/continue/agent/context/render-membral-md/draft-handoff removed with the bridge — 2026-09-12 refocus goal's kill list; 'preamble' added — P4, memory-on-prod-new-user goal)", () => {
    expect(new Set(HIDDEN_COMMANDS)).toEqual(
      new Set([
        "whoami",
        "import-session",
        "session-end-hook",
        "preamble",
        "prompt-hook",
        "mcp-headers",
        "mcp",
        "install-session-hook",
        "sweep",
        "dogfood",
      ]),
    );
  });
});

// test-supersede (step 3C-4, rung G3): the switch's `case` labels are gone
// (see commands/index.ts) — this scanned index.ts's source text for
// `case "..."` labels; the same "every command still dispatched, nothing
// extra" assertion now reads the COMMANDS registry itself instead.
describe("command registry — the only non-vacuous way to assert 'hidden but still dispatched'", () => {
  it("every PUBLIC_COMMANDS + HIDDEN_COMMANDS name is a live entry in COMMANDS, and nothing else is", () => {
    const names = COMMANDS.map((c) => c.name);
    expect(new Set(names)).toEqual(new Set([...PUBLIC_COMMANDS, ...HIDDEN_COMMANDS]));
    // 8 public (setup/use/login/logout/status/import/sessions/help) + 6 hidden
    // (whoami/import-session/session-end-hook/preamble/install-session-hook/
    // sweep) = 14 (2026-09-12 refocus goal's kill list removed
    // start/continue/agent/context/render-membral-md/draft-handoff with the
    // bridge; W4/D5 folded 'help' into PUBLIC_COMMANDS; 'preamble' added —
    // P4, memory-on-prod-new-user goal; 'use' + 'sweep' added for profiles;
    // 'mcp-headers' added — W9, Codex http_headers_helper; 'local' added — W7;
    // 'prompt-hook' added — prompt-time recall; 'dogfood' — recall-precision W3b).
    expect(names).toHaveLength(22); // + up/down/logs (embedded-store server)
    expect(new Set(names).size).toBe(names.length); // no duplicate registry entries
  });

  it("every hidden command has a HELP[] entry (the before-any-side-effect guard looks these up unconditionally)", () => {
    for (const name of HIDDEN_COMMANDS) {
      expect(typeof HELP[name]).toBe("string");
      expect(HELP[name].length).toBeGreaterThan(0);
    }
  });

  it("every hidden command is documented in INTERNALS.md", () => {
    const internals = readFileSync(resolve(__dirname, "../../INTERNALS.md"), "utf8");
    for (const name of HIDDEN_COMMANDS) {
      expect(internals).toContain(`\`${name}\``);
    }
  });
});
