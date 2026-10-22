// 3C-3: precedence-matrix test written FIRST, before extracting
// resolveLoginUrl out of login-command.ts. Locks the exact current
// behaviour of every credential-resolution site — including the two
// different "empty string" rules already in this file (see notes below) —
// so the extraction in credentials.ts / login-command.ts cannot silently
// change what any of them resolve to.
//
// Sites covered:
//   - resolveApiUrl / resolveApiKey (credentials.ts): flag ?? env ?? file ?? default,
//     trailing slash trimmed on the URL. `??` only treats null/undefined as
//     absent, so an EMPTY STRING flag or env value WINS outright (it is not
//     treated as "unset").
//   - resolveCredentials (credentials.ts): same source order, but each
//     source is tested with a plain truthy `if`, so an empty string flag/env
//     is treated as ABSENT and falls through to the next source. The URL is
//     always trailing-slash-trimmed regardless of which source won.
//   - login-command.ts's inline `opts.apiUrl ?? process.env.MEMBRAL_API_URL ??
//     DEFAULT_API_URL` (line 125): same `??`/empty-wins rule as resolveApiUrl,
//     but must NEVER read the credentials file for the URL (login is what
//     writes that file). This is exercised directly through loginCommand's
//     injectable deps today (no seam without a production change), locked by
//     asserting the resolved apiUrl loginCommand actually calls
//     startDeviceAuth/saveCredentials with — the same value the future
//     resolveLoginUrl must return.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveApiKey, resolveApiUrl, resolveCredentials, saveCredentials } from "../credentials.js";
import { loginCommand } from "../login-command.js";

const DEFAULT_URL = "https://default.example";

type Presence = "set" | "empty" | "unset";

function flagUrl(p: Presence): string | undefined {
  return p === "set" ? "https://from-flag.example/" : p === "empty" ? "" : undefined;
}
function envUrl(p: Presence): string | undefined {
  return p === "set" ? "https://from-env.example/" : p === "empty" ? "" : undefined;
}
function flagKey(p: Presence): string | undefined {
  return p === "set" ? "lls_from_flag" : p === "empty" ? "" : undefined;
}
function envKey(p: Presence): string | undefined {
  return p === "set" ? "lls_from_env" : p === "empty" ? "" : undefined;
}

const PRESENCES: Presence[] = ["set", "empty", "unset"];
const FILE_STATES = [true, false] as const;

describe("credential resolution precedence matrix (3x3x2, locked before refactor)", () => {
  let dir: string;
  let credsPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "membral-creds-matrix-"));
    credsPath = join(dir, "credentials.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeCredsFile() {
    saveCredentials(
      {
        apiUrl: "https://from-creds.example/",
        apiKey: "lls_from_creds",
        email: "e@example.com",
        userId: "u1",
        createdAt: "now",
      },
      credsPath,
    );
  }

  describe("resolveApiUrl — ?? chain, empty string wins", () => {
    for (const flag of PRESENCES) {
      for (const env of PRESENCES) {
        for (const fileState of FILE_STATES) {
          it(`flag=${flag} env=${env} file=${fileState ? "present" : "absent"}`, () => {
            if (fileState) writeCredsFile();
            const result = resolveApiUrl(flagUrl(flag), envUrl(env), DEFAULT_URL, credsPath);

            let expected: string;
            if (flag !== "unset") expected = flagUrl(flag) as string;
            else if (env !== "unset") expected = envUrl(env) as string;
            else if (fileState) expected = "https://from-creds.example/";
            else expected = DEFAULT_URL;

            expect(result).toBe(expected.replace(/\/+$/, ""));
          });
        }
      }
    }
  });

  describe("resolveApiKey — ?? chain, empty string wins", () => {
    for (const flag of PRESENCES) {
      for (const env of PRESENCES) {
        for (const fileState of FILE_STATES) {
          it(`flag=${flag} env=${env} file=${fileState ? "present" : "absent"}`, () => {
            if (fileState) writeCredsFile();
            const result = resolveApiKey(flagKey(flag), envKey(env), credsPath);

            let expected: string;
            if (flag !== "unset") expected = flagKey(flag) as string;
            else if (env !== "unset") expected = envKey(env) as string;
            else if (fileState) expected = "lls_from_creds";
            else expected = "";

            expect(result).toBe(expected);
          });
        }
      }
    }
  });

  describe("resolveCredentials — truthy chain, empty string treated as absent", () => {
    for (const flag of PRESENCES) {
      for (const env of PRESENCES) {
        for (const fileState of FILE_STATES) {
          it(`URL: flag=${flag} env=${env} file=${fileState ? "present" : "absent"}`, () => {
            if (fileState) writeCredsFile();
            const r = resolveCredentials({
              flagUrl: flagUrl(flag),
              envUrl: envUrl(env),
              defaultUrl: DEFAULT_URL,
              credsPath,
            });

            let expected: string;
            let expectedSource: string;
            if (flag === "set") {
              expected = flagUrl("set") as string;
              expectedSource = "flag";
            } else if (env === "set") {
              expected = envUrl("set") as string;
              expectedSource = "env";
            } else if (fileState) {
              expected = "https://from-creds.example/";
              expectedSource = "credentials";
            } else {
              expected = DEFAULT_URL;
              expectedSource = "none";
            }
            expect(r.apiUrl).toBe(expected.replace(/\/+$/, ""));
            expect(r.apiUrlSource).toBe(expectedSource);
          });

          it(`KEY: flag=${flag} env=${env} file=${fileState ? "present" : "absent"}`, () => {
            if (fileState) writeCredsFile();
            const r = resolveCredentials({
              flagKey: flagKey(flag),
              envKey: envKey(env),
              defaultUrl: DEFAULT_URL,
              credsPath,
            });

            let expected: string;
            let expectedSource: string;
            if (flag === "set") {
              expected = flagKey("set") as string;
              expectedSource = "flag";
            } else if (env === "set") {
              expected = envKey("set") as string;
              expectedSource = "env";
            } else if (fileState) {
              expected = "lls_from_creds";
              expectedSource = "credentials";
            } else {
              expected = "";
              expectedSource = "none";
            }
            expect(r.apiKey).toBe(expected);
            expect(r.apiKeySource).toBe(expectedSource);
          });
        }
      }
    }
  });

  describe("login URL resolution (login-command.ts:125 today, resolveLoginUrl after) — file-skip rule", () => {
    async function runLoginAndCaptureUrl(opts: { apiUrl?: string }): Promise<string> {
      let capturedUrl: string | undefined;
      await loginCommand(opts, {
        startDeviceAuth: async (apiUrl) => {
          capturedUrl = apiUrl;
          return {
            deviceCode: "dc",
            userCode: "UC",
            verificationUriComplete: "https://verify.example",
            expiresIn: 1,
            interval: 1,
          };
        },
        pollDeviceAuth: async () => ({ status: "expired" }) as never,
        openBrowser: () => {},
        loadOrCreateDeviceIdentity: () => ({ id: "d1", name: "test-device" }) as never,
        saveCredentials: () => {},
        sleep: async () => {},
        now: () => Date.now(),
        credentialsPath: credsPath,
      });
      return capturedUrl as string;
    }

    for (const flag of PRESENCES) {
      for (const env of PRESENCES) {
        for (const fileState of FILE_STATES) {
          it(`flag=${flag} env=${env} file=${fileState ? "present" : "absent"} — file is NEVER consulted`, async () => {
            if (fileState) writeCredsFile(); // must have zero effect on the login URL

            const envValue = envUrl(env);
            if (envValue === undefined) vi.stubEnv("MEMBRAL_API_URL", "");
            else vi.stubEnv("MEMBRAL_API_URL", envValue);
            if (envValue === undefined) {
              delete process.env.MEMBRAL_API_URL;
            }

            const result = await runLoginAndCaptureUrl({ apiUrl: flagUrl(flag) });

            let expected: string;
            if (flag !== "unset") expected = flagUrl(flag) as string;
            else if (env !== "unset") expected = envUrl(env) as string;
            else expected = "https://membral.me"; // DEFAULT_API_URL

            expect(result).toBe(expected.replace(/\/+$/, ""));

            vi.unstubAllEnvs();
          });
        }
      }
    }
  });
});
