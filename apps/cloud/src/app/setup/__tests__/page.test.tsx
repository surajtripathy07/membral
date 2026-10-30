// /setup page — round-3 review HIGH 11: extensionZipAvailable now comes
// from public/downloads/manifest.json (written by scripts/package-
// extension.mjs at build time) instead of an existsSync probe of the zip
// itself at render time. This test controls the manifest file via a mocked
// node:fs and asserts both states render distinctly — the download button
// (available) vs. the "download not available on this deployment" copy
// (not available/missing manifest).
import { describe, expect, it, vi } from "vitest";

let manifestExists = false;
let manifestContent = "";

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => manifestExists),
  readFileSync: vi.fn(() => manifestContent),
}));

import { getAppUrl } from "@/lib/env";
import { installCommand } from "@/lib/install-command";
import SetupPage, { dynamic } from "../page";

/** Walks a React element tree collecting every string child — good enough to assert on visible copy without a full DOM render (this is an async Server Component). */
function collectText(node: unknown, out: string[] = []): string[] {
  if (node == null) return out;
  if (typeof node === "string") {
    out.push(node);
    return out;
  }
  if (Array.isArray(node)) {
    for (const n of node) collectText(n, out);
    return out;
  }
  if (typeof node === "object") {
    const el = node as { props?: { children?: unknown; href?: unknown; command?: unknown } };
    if (el.props?.href) out.push(String(el.props.href));
    if (el.props?.command) out.push(String(el.props.command));
    if (el.props && "children" in el.props) collectText(el.props.children, out);
  }
  return out;
}

describe("/setup page", () => {
  it("is pinned force-static (round-3 review HIGH 11 — never at risk of becoming dynamic and losing public/ filesystem access)", () => {
    expect(dynamic).toBe("force-static");
  });

  it("renders the download button when manifest.json says available:true", async () => {
    manifestExists = true;
    manifestContent = JSON.stringify({ available: true, builtAt: "2026-09-06T00:00:00.000Z", cloudUrl: "https://membral.me" });

    const result = await SetupPage();
    const text = collectText(result).join(" ");

    expect(text).toContain("/downloads/membral-extension.zip");
    expect(text).toContain("Download membral-extension.zip");
    expect(text).not.toContain("Download not available on this deployment");
  });

  it("renders the 'not available' copy when manifest.json says available:false", async () => {
    manifestExists = true;
    manifestContent = JSON.stringify({ available: false, builtAt: null, cloudUrl: null });

    const result = await SetupPage();
    const text = collectText(result).join(" ");

    expect(text).toContain("Download not available on this deployment");
    expect(text).not.toContain("/downloads/membral-extension.zip");
  });

  it("renders the 'not available' copy when manifest.json is missing entirely (fresh checkout, prebuild never ran)", async () => {
    manifestExists = false;
    manifestContent = "";

    const result = await SetupPage();
    const text = collectText(result).join(" ");

    expect(text).toContain("Download not available on this deployment");
  });

  it("degrades to 'not available' on malformed manifest JSON, never throws", async () => {
    manifestExists = true;
    manifestContent = "{not json";

    await expect(SetupPage()).resolves.toBeTruthy();
    const result = await SetupPage();
    const text = collectText(result).join(" ");
    expect(text).toContain("Download not available on this deployment");
  });

  it("shows the shared install command and what happens next", async () => {
    manifestExists = false;
    const result = await SetupPage();
    const text = collectText(result).join(" ");
    expect(text).toContain(installCommand(getAppUrl()));
    expect(text).toContain("What happens next");
    expect(text).toContain("membral status");
    expect(text).not.toContain("isn't on npm yet");
  });

  it("says plain setup covers Copilot, with --copilot optional for the repo", async () => {
    manifestExists = false;
    const text = collectText(await SetupPage()).join(" ");
    expect(text).toContain("membral setup --copilot");
    expect(text).toContain("covers Copilot CLI and VS Code");
    expect(text).not.toContain("membral setup --copilot-cli");
    expect(text).toContain(".vscode/mcp.json");
  });

  it("hosted: shows the served tarball install, then membral setup", async () => {
    manifestExists = false;
    const text = collectText(await SetupPage()).join(" ");
    expect(text).toContain("membral-cli.tgz && membral setup");
    expect(text).not.toContain("npm run cli:install");
  });

  it("local mode: keeps the clone install", async () => {
    manifestExists = false;
    vi.stubEnv("MEMBRAL_LOCAL", "1");
    const text = collectText(await SetupPage()).join(" ");
    vi.unstubAllEnvs();
    expect(text).toContain("npm run cli:install");
    expect(text).not.toContain("membral-cli.tgz");
  });

  it("leads with the plugin path, then the CLI install", async () => {
    manifestExists = false;
    const text = collectText(await SetupPage()).join(" ");
    expect(text).toContain("/plugin marketplace add surajtripathy07/membral-plugin");
    expect(text).toContain("/plugin install membral@membral");
    expect(text).toContain("claude plugin install membral@membral --config api_key=<your key>");
    expect(text).toContain("shell history");
    expect(text).toContain("hook error");
    expect(text).toContain("catches up once a day");
    expect(text).toContain("Node 22.5");
    expect(text).toContain("/settings#keys");
    expect(text).toContain("Generate API Key");
    expect(text).toContain("last 30 days");
    expect(text.indexOf("/plugin marketplace add")).toBeLessThan(text.indexOf("membral-cli.tgz"));
    expect(text).not.toMatch(new RegExp(`npm i -g ${"membral"}(?![-./\\w])`));
  });

  it("never links to /signup, hosted or local", async () => {
    manifestExists = false;
    for (const local of ["", "1"]) {
      vi.stubEnv("MEMBRAL_LOCAL", local);
      const text = collectText(await SetupPage()).join(" ");
      expect(text).not.toContain("/signup");
    }
    vi.unstubAllEnvs();
  });
});
