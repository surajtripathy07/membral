import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deleteCredentials,
  describeAuthRejection,
  describeKeySource,
  describeSource,
  describeUrlSource,
  loadCredentials,
  maskApiKey,
  resolveApiKey,
  resolveApiUrl,
  resolveCredentials,
  resolveValidatedCredentials,
  saveCredentials,
  validateApiKey,
} from "../credentials.js";

describe("credentials", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "membral-creds-"));
    path = join(dir, "credentials.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("loadCredentials returns null when the file doesn't exist", () => {
    expect(loadCredentials(path)).toBeNull();
  });

  it("loadCredentials returns null for corrupt JSON", () => {
    saveCredentials(
      { apiUrl: "https://membral.me", apiKey: "k", email: "a@b.com", userId: "u1", createdAt: "now" },
      path,
    );
    // Corrupt it after a valid write.
    writeFileSync(path, "not json");
    expect(loadCredentials(path)).toBeNull();
  });

  it("saveCredentials writes mode 0600 and loadCredentials reads it back", () => {
    const creds = { apiUrl: "https://membral.me", apiKey: "lls_abc", email: "a@b.com", userId: "u1", createdAt: "now" };
    saveCredentials(creds, path);

    expect(existsSync(path)).toBe(true);
    expect(loadCredentials(path)).toEqual(creds);

    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("deleteCredentials removes the file and reports whether one existed", () => {
    expect(deleteCredentials(path)).toBe(false);
    saveCredentials({ apiUrl: "u", apiKey: "k", email: "e", userId: "i", createdAt: "c" }, path);
    expect(deleteCredentials(path)).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  describe("resolveApiUrl / resolveApiKey", () => {
    it("falls back through flag > env > credentials.json > default", () => {
      saveCredentials(
        { apiUrl: "https://from-creds.example", apiKey: "lls_from_creds", email: "e", userId: "i", createdAt: "c" },
        path,
      );

      expect(resolveApiUrl(undefined, undefined, "https://default.example", path)).toBe("https://from-creds.example");
      expect(resolveApiUrl(undefined, "https://from-env.example", "https://default.example", path)).toBe(
        "https://from-env.example",
      );
      expect(
        resolveApiUrl("https://from-flag.example", "https://from-env.example", "https://default.example", path),
      ).toBe("https://from-flag.example");

      expect(resolveApiKey(undefined, undefined, path)).toBe("lls_from_creds");
      expect(resolveApiKey(undefined, "lls_from_env", path)).toBe("lls_from_env");
      expect(resolveApiKey("lls_from_flag", "lls_from_env", path)).toBe("lls_from_flag");
    });

    it("falls back to the default URL and empty key when no credentials file exists", () => {
      expect(resolveApiUrl(undefined, undefined, "https://default.example", path)).toBe("https://default.example");
      expect(resolveApiKey(undefined, undefined, path)).toBe("");
    });

    it("strips trailing slashes from the resolved URL", () => {
      saveCredentials(
        { apiUrl: "https://from-creds.example/", apiKey: "k", email: "e", userId: "i", createdAt: "c" },
        path,
      );
      expect(resolveApiUrl(undefined, undefined, "https://default.example", path)).toBe("https://from-creds.example");
    });
  });

  // Issue #136: the ONE shared, source-reporting resolver every command
  // should go through.
  describe("resolveCredentials", () => {
    it("reports source 'none' for both key and url when nothing is configured", () => {
      const r = resolveCredentials({ defaultUrl: "https://default.example", credsPath: path });
      expect(r).toEqual({
        apiKey: "",
        apiKeySource: "none",
        apiUrl: "https://default.example",
        apiUrlSource: "none",
      });
    });

    it("reports source 'credentials' when only credentials.json has a key/url", () => {
      saveCredentials(
        { apiUrl: "https://from-creds.example", apiKey: "lls_from_creds", email: "e", userId: "i", createdAt: "c" },
        path,
      );
      const r = resolveCredentials({ defaultUrl: "https://default.example", credsPath: path });
      expect(r).toEqual({
        apiKey: "lls_from_creds",
        apiKeySource: "credentials",
        apiUrl: "https://from-creds.example",
        apiUrlSource: "credentials",
      });
    });

    it("reports source 'env' when an env key/url is set, even with a DIFFERENT credentials.json entry present (the #136 bug shape)", () => {
      saveCredentials(
        { apiUrl: "https://from-creds.example", apiKey: "lls_from_creds", email: "e", userId: "i", createdAt: "c" },
        path,
      );
      const r = resolveCredentials({
        envKey: "lls_from_env",
        envUrl: "https://from-env.example",
        defaultUrl: "https://default.example",
        credsPath: path,
      });
      expect(r.apiKey).toBe("lls_from_env");
      expect(r.apiKeySource).toBe("env");
      expect(r.apiUrl).toBe("https://from-env.example");
      expect(r.apiUrlSource).toBe("env");
    });

    it("reports source 'flag' when a flag is given, outranking env and credentials.json", () => {
      saveCredentials(
        { apiUrl: "https://from-creds.example", apiKey: "lls_from_creds", email: "e", userId: "i", createdAt: "c" },
        path,
      );
      const r = resolveCredentials({
        flagKey: "lls_from_flag",
        flagUrl: "https://from-flag.example",
        envKey: "lls_from_env",
        envUrl: "https://from-env.example",
        defaultUrl: "https://default.example",
        credsPath: path,
      });
      expect(r.apiKeySource).toBe("flag");
      expect(r.apiUrlSource).toBe("flag");
    });
  });

  describe("maskApiKey", () => {
    it("masks down to a short prefix, never the full key", () => {
      expect(maskApiKey("lls_mTsupersecretvalue")).toBe("lls_mT…");
      expect(maskApiKey("lls_mTsupersecretvalue")).not.toContain("supersecret");
    });

    it("reports '(none)' for an empty key", () => {
      expect(maskApiKey("")).toBe("(none)");
    });

    // m2 (adversarial round 1): a <=6-char key used to print in full
    // (`maskApiKey("abc123")` -> `"abc123…"`) — nothing masked at all.
    // Anything at/under 8 chars now shows none of itself.
    it("shows none of a short (<=8 char) key, never the whole thing", () => {
      expect(maskApiKey("abc123")).toBe("…");
      expect(maskApiKey("12345678")).toBe("…");
    });

    it("still masks down to a 6-char prefix once the key is long enough", () => {
      expect(maskApiKey("123456789")).toBe("123456…");
    });
  });

  describe("describeSource / describeKeySource / describeUrlSource", () => {
    it("names each source distinctly and mentions the underlying mechanism", () => {
      expect(describeKeySource("env")).toContain("MEMBRAL_API_KEY");
      expect(describeKeySource("credentials")).toContain("credentials.json");
      expect(describeKeySource("flag")).toContain("--api-key");
      expect(describeUrlSource("env")).toContain("MEMBRAL_API_URL");
      expect(describeUrlSource("credentials")).toContain("credentials.json");
      expect(describeSource("none")).toBeTruthy();
    });
  });

  describe("validateApiKey", () => {
    it("returns invalid for an empty key without calling fetch", async () => {
      const fetchMock = vi.fn();
      const result = await validateApiKey("https://membral.me", "", fetchMock);
      expect(result.status).toBe("invalid");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("returns invalid with httpStatus 401 on a definite 401", async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));
      const result = await validateApiKey("https://membral.me", "lls_bad", fetchMock);
      expect(result).toEqual({ status: "invalid", httpStatus: 401 });
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("https://membral.me/api/code-sessions/stats?days=1");
      expect((init.headers as Record<string, string>).authorization).toBe("Bearer lls_bad");
    });

    it("returns valid on a 200", async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ totals: {} }), { status: 200 }));
      const result = await validateApiKey("https://membral.me", "lls_good", fetchMock);
      expect(result.status).toBe("valid");
    });

    it("returns 'unknown' (never 'invalid') on a network error — a transient outage must never look like a bad key", async () => {
      const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
      const result = await validateApiKey("https://membral.me", "lls_key", fetchMock);
      expect(result.status).toBe("unknown");
    });

    it("returns 'unknown' on a non-401 error status (e.g. a transient 500)", async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 500 }));
      const result = await validateApiKey("https://membral.me", "lls_key", fetchMock);
      expect(result.status).toBe("unknown");
    });

    it("strips trailing slashes from the URL before hitting the validate path", async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
      await validateApiKey("https://membral.me/", "lls_key", fetchMock);
      expect(fetchMock.mock.calls[0][0]).toBe("https://membral.me/api/code-sessions/stats?days=1");
    });

    // m3 (adversarial round 1): a captive portal / proxy / mistyped --api-url
    // that happens to answer 200 must not read as "key valid".
    it("returns 'unknown' (not 'valid') on a 200 whose body doesn't look like /api/code-sessions/stats", async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response("<html>captive portal</html>", { status: 200 }));
      const result = await validateApiKey("https://membral.me", "totally-not-a-key", fetchMock);
      expect(result.status).toBe("unknown");
    });

    it("returns 'unknown' on a 200 with a JSON body missing the 'totals' object", async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      const result = await validateApiKey("https://membral.me", "lls_key", fetchMock);
      expect(result.status).toBe("unknown");
    });

    // m4 (adversarial round 1): a black-holed self-hosted URL must not hang
    // setup/login for undici's ~5 minute default headers timeout.
    it("passes an AbortSignal with a bounded timeout on every request", async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ totals: {} }), { status: 200 }));
      await validateApiKey("https://membral.me", "lls_key", fetchMock);
      const [, init] = fetchMock.mock.calls[0];
      expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
    });
  });

  // Issue #136 req 3: the precedence matrix — this is the whole bug.
  describe("resolveValidatedCredentials", () => {
    function fetchReturning(status: number) {
      // m3 (round 1): a bare 200 with no recognizable body is no longer
      // enough to validate — give every 200 the real success shape.
      const body = status === 200 ? JSON.stringify({ totals: {} }) : null;
      return vi.fn().mockResolvedValue(new Response(body, { status }));
    }

    it("uses the env key as-is when it validates (no credentials.json needed)", async () => {
      const fetchMock = fetchReturning(200);
      const result = await resolveValidatedCredentials(
        { envKey: "lls_from_env", defaultUrl: "https://default.example", credsPath: path },
        fetchMock,
      );
      expect(result.apiKeySource).toBe("env");
      expect(result.apiKey).toBe("lls_from_env");
      expect(result.validation.status).toBe("valid");
      expect(result.fallbackWarning).toBeUndefined();
    });

    it("ENV FAILS, CREDENTIALS.JSON SUCCEEDS: falls back to the credentials.json key and reports the fallback (the #136 bug shape)", async () => {
      saveCredentials(
        { apiUrl: "https://from-creds.example", apiKey: "lls_from_creds", email: "e", userId: "i", createdAt: "c" },
        path,
      );
      // First call (env key against the resolved url) -> 401; second call
      // (credentials.json key against ITS OWN recorded url) -> 200.
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 401 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ totals: {} }), { status: 200 }));

      const result = await resolveValidatedCredentials(
        { envKey: "lls_stale_env", defaultUrl: "https://default.example", credsPath: path },
        fetchMock,
      );

      expect(result.apiKeySource).toBe("credentials");
      expect(result.apiKey).toBe("lls_from_creds");
      expect(result.apiUrl).toBe("https://from-creds.example");
      expect(result.validation.status).toBe("valid");
      expect(result.fallbackWarning).toContain("MEMBRAL_API_KEY");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("ENV FAILS, CREDENTIALS.JSON ALSO FAILS: reports invalid, no fallback, no fabricated success", async () => {
      saveCredentials(
        { apiUrl: "https://from-creds.example", apiKey: "lls_from_creds", email: "e", userId: "i", createdAt: "c" },
        path,
      );
      const fetchMock = fetchReturning(401);

      const result = await resolveValidatedCredentials(
        { envKey: "lls_stale_env", defaultUrl: "https://default.example", credsPath: path },
        fetchMock,
      );

      expect(result.apiKeySource).toBe("env"); // never silently swapped to a source that didn't work
      expect(result.validation.status).toBe("invalid");
      expect(result.fallbackWarning).toBeUndefined();
    });

    it("ENV FAILS, NO credentials.json AT ALL: reports invalid, no fallback attempted", async () => {
      const fetchMock = fetchReturning(401);
      const result = await resolveValidatedCredentials(
        { envKey: "lls_stale_env", defaultUrl: "https://default.example", credsPath: path },
        fetchMock,
      );
      expect(result.apiKeySource).toBe("env");
      expect(result.validation.status).toBe("invalid");
      expect(fetchMock).toHaveBeenCalledTimes(1); // never even tried a fallback with nothing to try
    });

    it("does not fall back to credentials.json when it holds the SAME key as env (nothing new to try)", async () => {
      saveCredentials(
        { apiUrl: "https://from-creds.example", apiKey: "lls_same_key", email: "e", userId: "i", createdAt: "c" },
        path,
      );
      const fetchMock = fetchReturning(401);
      const result = await resolveValidatedCredentials(
        { envKey: "lls_same_key", defaultUrl: "https://default.example", credsPath: path },
        fetchMock,
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result.validation.status).toBe("invalid");
    });

    it("never falls back away from an explicit --api-key flag, even when it's invalid", async () => {
      saveCredentials(
        { apiUrl: "https://from-creds.example", apiKey: "lls_from_creds", email: "e", userId: "i", createdAt: "c" },
        path,
      );
      const fetchMock = fetchReturning(401);
      const result = await resolveValidatedCredentials(
        { flagKey: "lls_from_flag", defaultUrl: "https://default.example", credsPath: path },
        fetchMock,
      );
      expect(result.apiKeySource).toBe("flag");
      expect(result.apiKey).toBe("lls_from_flag");
      expect(result.validation.status).toBe("invalid");
      expect(fetchMock).toHaveBeenCalledTimes(1); // no credentials.json fallback attempted for an explicit flag
    });

    it("reports invalid with no network call when there's no key configured at all", async () => {
      const fetchMock = vi.fn();
      const result = await resolveValidatedCredentials(
        { defaultUrl: "https://default.example", credsPath: path },
        fetchMock,
      );
      expect(result.apiKeySource).toBe("none");
      expect(result.validation.status).toBe("invalid");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("respects an explicit --api-url flag as the URL to validate the credentials.json fallback key against", async () => {
      saveCredentials(
        { apiUrl: "https://from-creds.example", apiKey: "lls_from_creds", email: "e", userId: "i", createdAt: "c" },
        path,
      );
      // n1 (adversarial round 2): credentials.json's key was minted for a
      // DIFFERENT url (from-creds.example) than the explicit --api-url flag
      // (flag.example.com) — that untried pair must never be sent
      // anywhere, so this mock only ever needs to answer ONE call (the env
      // key's own, expected 401). A second call would mean the creds key
      // leaked to the flag's url — assert exactly one call below.
      const fetchMock = vi.fn().mockResolvedValueOnce(new Response(null, { status: 401 }));

      const result = await resolveValidatedCredentials(
        {
          envKey: "lls_stale_env",
          flagUrl: "https://flag.example.com",
          defaultUrl: "https://default.example",
          credsPath: path,
        },
        fetchMock,
      );

      // The explicit --api-url flag is still respected (never silently
      // swapped for credentials.json's own url — that's B1) ...
      expect(result.apiUrl).toBe("https://flag.example.com");
      expect(result.apiUrlSource).toBe("flag");
      // ... but since credentials.json's key was never proven to work at
      // that url, it's never even tried there (n1) — one fetch call total.
      expect(result.validation.status).toBe("invalid");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toBe("https://flag.example.com/api/code-sessions/stats?days=1");
      expect(result.fallbackWarning).toContain("never sent anywhere");
    });

    // B1 (adversarial round 1 BLOCKER): an explicit MEMBRAL_API_URL must
    // never be silently swapped out for credentials.json's OWN url just
    // because that (url, key) pair happens to validate — a self-hoster with
    // a stale env key + an old hosted credentials.json must not have their
    // setup silently retargeted at the public cloud. Reproduces the exact
    // D2 transcript shape: env key invalid + env URL selfhost + creds key
    // valid at membral.me -> stop (never proceed at membral.me).
    it("B1: never retargets an explicit MEMBRAL_API_URL to credentials.json's URL, even when that URL's key would validate", async () => {
      saveCredentials(
        { apiUrl: "https://membral.me", apiKey: "lls_cloud_key", email: "e", userId: "i", createdAt: "c" },
        path,
      );
      const fetchMock = vi.fn().mockImplementation(async (url: string) => {
        // membral.me would happily accept the cloud key — but that
        // combination must never even be TRIED (n1), let alone silently
        // used, since credentials.json's key was minted for a different URL.
        if (url.startsWith("https://selfhost.internal")) return new Response(null, { status: 401 });
        return new Response(JSON.stringify({ totals: {} }), { status: 200 });
      });

      const result = await resolveValidatedCredentials(
        {
          envKey: "lls_selfhost_stale",
          envUrl: "https://selfhost.internal",
          defaultUrl: "https://default.example",
          credsPath: path,
        },
        fetchMock,
      );

      // Stopped, not silently proceeding at membral.me with the cloud key.
      expect(result.validation.status).toBe("invalid");
      expect(result.apiUrl).toBe("https://selfhost.internal");
      expect(result.apiKeySource).toBe("env");
      // n1 (adversarial round 2): the credentials.json key must never be
      // TRANSMITTED to a URL it wasn't minted for — only the env key's own
      // (definite, expected) 401 against the self-hosted URL should ever
      // hit the network; membral.me is never contacted at all.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toBe("https://selfhost.internal/api/code-sessions/stats?days=1");
      const [, init] = fetchMock.mock.calls[0];
      expect((init.headers as Record<string, string>).authorization).toBe("Bearer lls_selfhost_stale");
      // The warning names both URLs and both sources (B1: "hard-stop with a
      // message naming both URLs and both sources") without claiming the
      // creds key was tried.
      expect(result.fallbackWarning).toContain("selfhost.internal");
      expect(result.fallbackWarning).toContain("membral.me");
      expect(result.fallbackWarning).toContain("MEMBRAL_API_URL");
      expect(result.fallbackWarning).toContain("credentials.json");
      expect(result.fallbackWarning).toContain("never sent anywhere");
    });

    it("B1: DOES fall back to credentials.json's own URL when no explicit --api-url/MEMBRAL_API_URL was given for this run", async () => {
      saveCredentials(
        { apiUrl: "https://membral.me", apiKey: "lls_cloud_key", email: "e", userId: "i", createdAt: "c" },
        path,
      );
      // No envUrl/flagUrl at all -> resolved.apiUrl already comes from
      // credentials.json itself (same as before this fix), so the fallback
      // legitimately validates against that same url.
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 401 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ totals: {} }), { status: 200 }));

      const result = await resolveValidatedCredentials(
        { envKey: "lls_stale_env", defaultUrl: "https://default.example", credsPath: path },
        fetchMock,
      );

      expect(result.apiKeySource).toBe("credentials");
      expect(result.apiUrl).toBe("https://membral.me");
      expect(result.validation.status).toBe("valid");
    });
  });

  describe("describeAuthRejection", () => {
    it("names the key source, the api url, and the url's own source", () => {
      const msg = describeAuthRejection({ apiKeySource: "env", apiUrl: "https://membral.me", apiUrlSource: "env" });
      expect(msg).toContain("MEMBRAL_API_KEY");
      expect(msg).toContain("https://membral.me");
      expect(msg).toContain("401");
      expect(msg).toContain("unset MEMBRAL_API_KEY");
    });

    it("gives a login-oriented hint for a rejected credentials.json key", () => {
      const msg = describeAuthRejection({
        apiKeySource: "credentials",
        apiUrl: "https://membral.me",
        apiUrlSource: "credentials",
      });
      expect(msg).toContain("membral login");
    });

    // m1 (adversarial round 1): with an env key + NO credentials.json at
    // all, the hint used to still claim "no working key was found in
    // ~/.membral/credentials.json either" — asserting a file was checked
    // that never existed.
    it("does not claim a nonexistent credentials.json was checked when there wasn't one (m1)", () => {
      const msg = describeAuthRejection({
        apiKeySource: "env",
        apiUrl: "https://membral.me",
        apiUrlSource: "env",
        credentialsFileFound: false,
      });
      expect(msg).not.toContain("no working key was found in ~/.membral/credentials.json either");
      expect(msg).toContain("membral login");
    });

    it("still says a credentials.json key was tried and failed too when one existed (m1)", () => {
      const msg = describeAuthRejection({
        apiKeySource: "env",
        apiUrl: "https://membral.me",
        apiUrlSource: "env",
        credentialsFileFound: true,
      });
      expect(msg).toContain("no working key was found in ~/.membral/credentials.json either");
    });
  });
});
