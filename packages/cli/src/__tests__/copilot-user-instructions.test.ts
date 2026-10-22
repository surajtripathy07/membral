import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RECALL_VS_STATE_FULL } from "@membral/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { INSTRUCTIONS_CONTENT, userInstructionsPath, writeUserInstructions } from "../copilot-user-instructions.js";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "copilot-user-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("writeUserInstructions", () => {
  it("creates the applyTo ** instructions file, then is byte-identical and unchanged on rerun", async () => {
    const r = await writeUserInstructions(home);
    expect(r).toEqual({ path: join(home, ".copilot", "instructions", "membral.instructions.md"), outcome: "created" });
    const text = await readFile(r.path, "utf-8");
    expect(text).toBe(INSTRUCTIONS_CONTENT);
    expect(text.startsWith('---\napplyTo: "**"\n---\n')).toBe(true);
    expect(text).toContain(RECALL_VS_STATE_FULL);
    expect(await writeUserInstructions(home)).toEqual({ path: r.path, outcome: "unchanged" });
    expect(await readFile(r.path, "utf-8")).toBe(text);
  });

  it("rewrites a drifted file whole", async () => {
    await mkdir(join(home, ".copilot", "instructions"), { recursive: true });
    await writeFile(userInstructionsPath(home), "old");
    expect((await writeUserInstructions(home)).outcome).toBe("updated");
    expect(await readFile(userInstructionsPath(home), "utf-8")).toBe(INSTRUCTIONS_CONTENT);
  });
});
