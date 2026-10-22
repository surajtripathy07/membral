import { describe, expect, it } from "vitest";
import { installCommand } from "../install-command";

describe("installCommand", () => {
  it("installs the served tarball, not an npm package name", () => {
    const cmd = installCommand("https://membral.me");
    expect(cmd).toBe("npm i -g https://membral.me/membral-cli.tgz && membral setup");
    expect(cmd).not.toMatch(/npm i -g membral\b/);
  });

  it("adds --api-url when the app is not the CLI's default server", () => {
    expect(installCommand("https://membral.example.com")).toBe(
      "npm i -g https://membral.example.com/membral-cli.tgz && membral setup --api-url https://membral.example.com",
    );
  });

  it("strips trailing slashes", () => {
    expect(installCommand("https://membral.me///")).toBe(
      "npm i -g https://membral.me/membral-cli.tgz && membral setup",
    );
  });
});
