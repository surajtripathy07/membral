// Profiles in ~/.membral/credentials.json (local <-> prod switch). Every
// test writes a temp file — never the real ~/.membral.
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadCredentials,
  loadProfile,
  loadProfiles,
  profileNameForUrl,
  removeActiveProfile,
  saveCredentials,
  setActiveProfile,
} from "../credentials.js";

const base = { email: "a@b.com", userId: "u1", createdAt: "2026-09-25T00:00:00Z" };
const PROD = { ...base, apiUrl: "https://membral.me", apiKey: "lls_prod" };
const LOCAL = { ...base, apiUrl: "http://localhost:3000", apiKey: "lls_local" };

describe("credential profiles", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "membral-profiles-"));
    path = join(dir, "credentials.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("names profiles from the URL", () => {
    expect(profileNameForUrl("http://localhost:3000")).toBe("local");
    expect(profileNameForUrl("http://localhost")).toBe("local");
    expect(profileNameForUrl("http://127.0.0.1:3001/")).toBe("local-3001");
    expect(profileNameForUrl("http://localhost:3002")).toBe("local-3002");
    expect(profileNameForUrl("https://membral.me")).toBe("prod");
    expect(profileNameForUrl("https://membral.example.org")).toBe("membral.example.org");
    expect(profileNameForUrl("https://staging.example.org:8443")).toBe("staging.example.org:8443");
  });

  it("removeActiveProfile drops only the active profile, promotes prod, deletes the file when none remain", () => {
    saveCredentials(PROD, path);
    saveCredentials({ ...base, apiUrl: "http://localhost:3002", apiKey: "lls_l2" }, path);
    saveCredentials(LOCAL, path);

    expect(removeActiveProfile(path)).toEqual({ removed: "local", nowActive: "prod" });
    expect(Object.keys(loadProfiles(path)?.profiles ?? {}).sort()).toEqual(["local-3002", "prod"]);
    expect(loadCredentials(path)).toEqual(PROD);

    expect(removeActiveProfile(path)).toEqual({ removed: "prod", nowActive: "local-3002" });
    expect(removeActiveProfile(path)).toEqual({ removed: "local-3002", nowActive: null });
    expect(existsSync(path)).toBe(false);
    expect(removeActiveProfile(path)).toBeNull();
  });

  it("saves each URL into its own profile, activates the latest, and mirrors it at top level", () => {
    saveCredentials(PROD, path);
    saveCredentials(LOCAL, path);

    const raw = JSON.parse(readFileSync(path, "utf8"));
    expect(raw.activeProfile).toBe("local");
    expect(Object.keys(raw.profiles).sort()).toEqual(["local", "prod"]);
    expect(raw.apiUrl).toBe("http://localhost:3000");
    expect(raw.apiKey).toBe("lls_local");
    expect(loadCredentials(path)).toEqual(LOCAL);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("switches the active profile and rewrites the top-level mirror", () => {
    saveCredentials(PROD, path);
    saveCredentials(LOCAL, path);

    expect(setActiveProfile("prod", path)).toMatchObject({ apiUrl: "https://membral.me" });
    expect(loadCredentials(path)).toEqual(PROD);
    expect(JSON.parse(readFileSync(path, "utf8")).apiKey).toBe("lls_prod");
    expect(loadProfile("local", path)).toMatchObject({ apiKey: "lls_local" });
  });

  it("unknown profile: returns null and writes nothing", () => {
    saveCredentials(PROD, path);
    const before = readFileSync(path, "utf8");
    expect(setActiveProfile("staging", path)).toBeNull();
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("reads an old single-profile file and migrates it on the next write", () => {
    writeFileSync(path, JSON.stringify(LOCAL));

    expect(loadCredentials(path)).toEqual(LOCAL);
    expect(loadProfiles(path)).toEqual({ activeProfile: "local", profiles: { local: LOCAL } });

    saveCredentials(PROD, path);
    const raw = JSON.parse(readFileSync(path, "utf8"));
    expect(raw.profiles.local).toEqual(LOCAL);
    expect(raw.profiles.prod).toEqual(PROD);
    expect(raw.activeProfile).toBe("prod");
  });

  it("re-login to the same server replaces that profile only", () => {
    saveCredentials(PROD, path);
    saveCredentials(LOCAL, path);
    saveCredentials({ ...PROD, apiKey: "lls_prod2" }, path);
    const state = loadProfiles(path);
    expect(state?.activeProfile).toBe("prod");
    expect(state?.profiles.prod.apiKey).toBe("lls_prod2");
    expect(state?.profiles.local.apiKey).toBe("lls_local");
  });
});
