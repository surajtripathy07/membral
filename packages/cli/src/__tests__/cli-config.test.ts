import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadCliConfig, promptRecallEnabled, setPromptRecall } from "../cli-config.js";

describe("~/.membral/config.json prompt_recall", () => {
  let root: string;
  let path: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "membral-cli-config-"));
    path = join(root, "nested", "config.json");
  });
  afterEach(async () => rm(root, { recursive: true, force: true }));

  it("defaults to on when the file is missing or corrupt", async () => {
    expect(promptRecallEnabled(path)).toBe(true);
    await writeFile(join(root, "bad.json"), "{not json");
    expect(promptRecallEnabled(join(root, "bad.json"))).toBe(true);
  });

  it("stores the opt-out, keeps other keys, and --prompt-recall clears it", async () => {
    expect(setPromptRecall(false, path)).toBe(true);
    expect(promptRecallEnabled(path)).toBe(false);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ prompt_recall: false });

    await writeFile(path, JSON.stringify({ prompt_recall: false, other: 1 }));
    setPromptRecall(true, path);
    expect(loadCliConfig(path)).toEqual({ other: 1 });
    expect(promptRecallEnabled(path)).toBe(true);
  });

  it("writes atomically: mode 0600 and no temp file left behind", async () => {
    setPromptRecall(false, path);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readdir(join(root, "nested"))).toEqual(["config.json"]);
  });
});
