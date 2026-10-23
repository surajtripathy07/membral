import { describe, expect, it } from "vitest";
import { installCommand, START_COMMAND } from "../install-command";

describe("installCommand", () => {
  it("installs the CLI from a clone, with no hosted tarball or npm package name", () => {
    const cmd = installCommand();
    expect(cmd).toBe(
      "git clone https://github.com/surajtripathy07/membral && cd membral && npm ci && npm run cli:install",
    );
    expect(cmd).not.toMatch(/membral\.me|membral-cli\.tgz|npm i -g/);
  });

  it("does not depend on the app URL", () => {
    expect(installCommand("https://membral.example.com")).toBe(installCommand());
  });

  it("starts the local stack with Ollama embeddings", () => {
    expect(START_COMMAND).toBe("membral local up --embeddings ollama");
  });
});
