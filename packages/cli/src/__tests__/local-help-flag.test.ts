// `membral local <sub> --help` prints usage without touching Docker (public issue #8).
import { afterEach, describe, expect, it, vi } from "vitest";
import { localCommand } from "../commands/local.js";
import { HELP } from "../help.js";
import { SERVICES } from "../local-command.js";

describe("membral local --help", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it.each(["up", "down", "status", "logs"])("%s --help and -h print usage, exit 0", async (sub) => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((m: unknown) => {
      logs.push(String(m));
    });
    await localCommand.run([sub, "--help"]);
    await localCommand.run([sub, "-h"]);
    expect(logs).toEqual([HELP.local, HELP.local]);
    expect(process.exitCode).toBeUndefined();
  });

  it("the logs usage line names every service `local logs` accepts, and --project", () => {
    const line = HELP.local.split("\n").find((l) => l.includes("local logs"))!;
    for (const svc of SERVICES) expect(line).toContain(svc);
    expect(line).toContain("--project");
  });
});
