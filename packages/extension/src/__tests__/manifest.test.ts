import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type BaseManifest,
  buildManifest,
  HOSTED_ORIGIN_PATTERN,
  OPTIONAL_HOST_PERMISSIONS,
  targetHostPermissions,
} from "../../build-manifest.js";

// The checked-in manifest.json carries only the chat providers; the Membral target comes from the build.
const base = JSON.parse(readFileSync(resolve(__dirname, "../../manifest.json"), "utf8")) as BaseManifest;

const PROVIDER_ORIGINS = [
  "https://claude.ai/*",
  "https://*.claude.ai/*",
  "https://chatgpt.com/*",
  "https://chat.openai.com/*",
];
const LOCAL_ORIGINS = ["http://localhost:3000/*", "http://127.0.0.1:3000/*"];

describe("manifest.json (checked in)", () => {
  it("lists only the chat provider origins, never a Membral target", () => {
    expect(base.host_permissions).toEqual(PROVIDER_ORIGINS);
  });
});

describe("buildManifest", () => {
  it("default build: local Membral only, no hosted origin", () => {
    const m = buildManifest(base, {});
    expect(m.host_permissions).toEqual([...PROVIDER_ORIGINS, ...LOCAL_ORIGINS]);
    expect(m.host_permissions).not.toContain(HOSTED_ORIGIN_PATTERN);
    expect(m.optional_host_permissions).toEqual(["http://*/*", "https://*/*"]);
  });

  it("VITE_MEMBRAL_PROD=1: membral.me only, no localhost", () => {
    const m = buildManifest(base, { VITE_MEMBRAL_PROD: "1" });
    expect(m.host_permissions).toEqual([...PROVIDER_ORIGINS, "https://membral.me/*"]);
    expect(m.host_permissions.join(" ")).not.toContain("localhost");
    expect(m.host_permissions.join(" ")).not.toContain("127.0.0.1");
    expect(m.optional_host_permissions).toEqual(["http://*/*", "https://*/*"]);
  });

  it("any VITE_MEMBRAL_PROD value other than 1 is a default (local) build", () => {
    for (const flag of ["0", "true", ""]) {
      expect(targetHostPermissions({ VITE_MEMBRAL_PROD: flag })).toEqual(LOCAL_ORIGINS);
    }
  });

  it("VITE_CLOUD_URL replaces the default target in either flavour", () => {
    expect(targetHostPermissions({ VITE_CLOUD_URL: "https://membral.me" })).toEqual(["https://membral.me/*"]);
    expect(
      targetHostPermissions({ VITE_CLOUD_URL: "https://stage.example.com:8443/x", VITE_MEMBRAL_PROD: "1" }),
    ).toEqual(["https://stage.example.com:8443/*"]);
  });

  it("a loopback VITE_CLOUD_URL also gets its localhost/127.0.0.1 twin on the same port", () => {
    expect(targetHostPermissions({ VITE_CLOUD_URL: "http://localhost:3400" })).toEqual([
      "http://localhost:3400/*",
      "http://127.0.0.1:3400/*",
    ]);
    expect(targetHostPermissions({ VITE_CLOUD_URL: "http://127.0.0.1:3400" })).toEqual([
      "http://localhost:3400/*",
      "http://127.0.0.1:3400/*",
    ]);
  });

  it("an unparseable VITE_CLOUD_URL falls back to the flavour default", () => {
    expect(targetHostPermissions({ VITE_CLOUD_URL: "not a url" })).toEqual(LOCAL_ORIGINS);
    expect(targetHostPermissions({ VITE_CLOUD_URL: "ftp://x.example", VITE_MEMBRAL_PROD: "1" })).toEqual([
      HOSTED_ORIGIN_PATTERN,
    ]);
  });

  it("keeps the provider origins and the rest of the base manifest untouched", () => {
    for (const env of [{}, { VITE_MEMBRAL_PROD: "1" }]) {
      const m = buildManifest(base, env);
      for (const origin of PROVIDER_ORIGINS) expect(m.host_permissions).toContain(origin);
      expect(m).toMatchObject({ manifest_version: 3, name: "Membral", options_page: "options.html" });
    }
  });

  it("OPTIONAL_HOST_PERMISSIONS is exactly the two wildcard schemes", () => {
    expect(OPTIONAL_HOST_PERMISSIONS).toEqual(["http://*/*", "https://*/*"]);
  });
});
