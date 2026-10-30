import { describe, expect, it } from "vitest";
import { installCommand, localInstallCommand, START_COMMAND } from "../install-command";

const CLONE_COMMAND =
  "git clone https://github.com/surajtripathy07/membral && cd membral && npm ci && npm run cli:install";

describe("installCommand", () => {
  it("hosted: installs the served tarball, then signs in", () => {
    const cmd = installCommand("https://membral.me", {});
    expect(cmd).toBe("npm i -g https://membral.me/membral-cli.tgz && membral setup");
    expect(cmd).not.toMatch(/npm i -g membral\b/);
  });

  it("hosted: uses the app's own origin, without trailing slashes, and no --api-url", () => {
    const cmd = installCommand("https://membral.example.com///", {});
    expect(cmd).toBe("npm i -g https://membral.example.com/membral-cli.tgz && membral setup");
    expect(cmd).not.toContain("--api-url");
  });

  it("local mode: installs from a clone, with no tarball or npm package name", () => {
    const cmd = installCommand("http://localhost:3000", { MEMBRAL_LOCAL: "1" });
    expect(cmd).toBe(CLONE_COMMAND);
    expect(cmd).not.toMatch(/membral-cli\.tgz|npm i -g/);
  });

  it("a stray MEMBRAL_LOCAL on Vercel still shows the hosted install", () => {
    expect(installCommand("https://membral.me", { MEMBRAL_LOCAL: "1", VERCEL: "1" })).toBe(
      "npm i -g https://membral.me/membral-cli.tgz && membral setup",
    );
  });

  it("localInstallCommand is the clone install in every mode", () => {
    expect(localInstallCommand()).toBe(CLONE_COMMAND);
  });

  it("starts the local stack with Ollama embeddings", () => {
    expect(START_COMMAND).toBe("membral local up --embeddings ollama");
  });
});
