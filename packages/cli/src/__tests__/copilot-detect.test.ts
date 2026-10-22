import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectCopilot, vscodeUserDirCandidates } from "../harness-scan.js";

let home: string;
let binDir: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "copilot-detect-"));
  binDir = join(home, "bin");
  await mkdir(binDir);
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const detect = (env: NodeJS.ProcessEnv = { PATH: binDir }) => detectCopilot({ env, home, platform: "darwin" });

describe("detectCopilot", () => {
  it("none: nothing on PATH, no ~/.copilot, no VS Code", async () => {
    const r = await detect();
    expect(r).toEqual({
      cliOnPath: false,
      copilotHome: false,
      vscodeUserDirs: [],
      vscodeExtension: false,
      present: false,
    });
  });

  it("PATH only: a copilot executable on PATH", async () => {
    const bin = join(binDir, "copilot");
    await writeFile(bin, "#!/bin/sh\n");
    await chmod(bin, 0o755);
    const r = await detect({ PATH: `/nonexistent:${binDir}` });
    expect(r.cliOnPath).toBe(true);
    expect(r.copilotHome).toBe(false);
    expect(r.vscodeUserDirs).toEqual([]);
    expect(r.present).toBe(true);
  });

  it("~/.copilot only (and COPILOT_HOME overrides it)", async () => {
    await mkdir(join(home, ".copilot"));
    expect((await detect()).copilotHome).toBe(true);
    expect((await detect()).present).toBe(true);
    // COPILOT_HOME points elsewhere and does not exist -> not present
    expect((await detect({ PATH: binDir, COPILOT_HOME: join(home, "nope") })).present).toBe(false);
  });

  it("VS Code only: the User dir (Copilot Chat is built in)", async () => {
    const userDir = join(home, "Library", "Application Support", "Code", "User");
    await mkdir(userDir, { recursive: true });
    const r = await detect();
    expect(r.vscodeUserDirs).toEqual([userDir]);
    expect(r.cliOnPath).toBe(false);
    expect(r.copilotHome).toBe(false);
    expect(r.present).toBe(true);
  });

  it("VS Code only: the Copilot Chat extension dir", async () => {
    await mkdir(join(home, ".vscode", "extensions", "github.copilot-chat-0.30.1"), { recursive: true });
    const r = await detect();
    expect(r.vscodeExtension).toBe(true);
    expect(r.vscodeUserDirs).toEqual([]);
    expect(r.present).toBe(true);
  });

  it("finds both Code and Code - Insiders", async () => {
    const base = join(home, "Library", "Application Support");
    await mkdir(join(base, "Code", "User"), { recursive: true });
    await mkdir(join(base, "Code - Insiders", "User"), { recursive: true });
    expect((await detect()).vscodeUserDirs).toEqual([
      join(base, "Code", "User"),
      join(base, "Code - Insiders", "User"),
    ]);
  });
});

describe("vscodeUserDirCandidates", () => {
  it("per platform", () => {
    expect(vscodeUserDirCandidates({ home: "/h", platform: "linux", env: {} })).toEqual([
      join("/h", ".config", "Code", "User"),
      join("/h", ".config", "Code - Insiders", "User"),
    ]);
    expect(vscodeUserDirCandidates({ home: "/h", platform: "win32", env: { APPDATA: "/appdata" } })[0]).toBe(
      join("/appdata", "Code", "User"),
    );
    expect(vscodeUserDirCandidates({ home: "/h", platform: "darwin", env: {} })[1]).toBe(
      join("/h", "Library", "Application Support", "Code - Insiders", "User"),
    );
  });
});
