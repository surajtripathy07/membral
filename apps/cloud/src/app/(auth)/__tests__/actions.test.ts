import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock next/navigation
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));

// Mock next/cache
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

// Server actions have no NextRequest — actions.ts reads next/headers'
// request-scoped headers() instead (see requestIp()). Outside an actual
// Next.js request context this throws, so it's mocked here; a null
// x-forwarded-for/x-real-ip makes clientIp() fall back to "unknown", which
// is fine — the rate-limit mock below controls allow/deny directly anyway.
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
}));

const mockEnforceRateLimit = vi.fn();
vi.mock("@/lib/rate-limit", () => ({
  enforceRateLimit: (...args: unknown[]) => mockEnforceRateLimit(...args),
  ipBucket: vi.fn((name: string, ip: string) => `${name}:ip:${ip}`),
  clientIp: vi.fn(() => "127.0.0.1"),
}));

const mockSignInWithPassword = vi.fn();
const mockSignUp = vi.fn();
const mockSignOut = vi.fn();
const mockSignInWithOAuth = vi.fn();
const mockResend = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(() =>
    Promise.resolve({
      auth: {
        signInWithPassword: mockSignInWithPassword,
        signUp: mockSignUp,
        signOut: mockSignOut,
        signInWithOAuth: mockSignInWithOAuth,
        resend: mockResend,
      },
    }),
  ),
}));

// #134 adversarial review round 3/4: signup() and signInWithGoogle() both
// call ensureSignupsDisabledMarker() when they observe MEMBRAL_SIGNUPS_
// DISABLED reading true, to eagerly stamp the durable signups_disabled_at
// marker (lib/signups-disabled-marker.ts — its own dedicated test files
// exercise the real DB behaviour). R4-M2: neither ever clears it — that's
// scripts/flags.ts's `signups on` alone now. Mocked here so this file can
// assert the stamp call without a fake DB.
const mockEnsureSignupsDisabledMarker = vi.fn();
vi.mock("@/lib/signups-disabled-marker", () => ({
  ensureSignupsDisabledMarker: () => mockEnsureSignupsDisabledMarker(),
}));

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { login, logout, resendConfirmation, signInWithGoogle, signup } from "../actions";

function makeFormData(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) {
    fd.set(k, v);
  }
  return fd;
}

describe("auth actions", () => {
  const originalSignupsDisabled = process.env.MEMBRAL_SIGNUPS_DISABLED;

  beforeEach(() => {
    vi.clearAllMocks();
    mockEnforceRateLimit.mockResolvedValue({ allowed: true, retryAfter: 0 });
    mockEnsureSignupsDisabledMarker.mockResolvedValue(undefined);
    delete process.env.MEMBRAL_SIGNUPS_DISABLED;
  });

  afterEach(() => {
    if (originalSignupsDisabled === undefined) {
      delete process.env.MEMBRAL_SIGNUPS_DISABLED;
    } else {
      process.env.MEMBRAL_SIGNUPS_DISABLED = originalSignupsDisabled;
    }
  });

  describe("login", () => {
    it("calls signInWithPassword with email and password from form data", async () => {
      mockSignInWithPassword.mockResolvedValue({ error: null });

      const fd = makeFormData({
        email: "test@example.com",
        password: "secret123",
      });

      await expect(login(fd)).rejects.toThrow("REDIRECT:/");

      expect(mockSignInWithPassword).toHaveBeenCalledWith({
        email: "test@example.com",
        password: "secret123",
      });
    });

    it("redirects to /login with error on failure", async () => {
      mockSignInWithPassword.mockResolvedValue({
        error: { code: "invalid_credentials", message: "Invalid login credentials" },
      });

      const fd = makeFormData({
        email: "bad@example.com",
        password: "wrong",
      });

      await expect(login(fd)).rejects.toThrow("REDIRECT:");
      expect(redirect).toHaveBeenCalledWith("/login?error=invalid_credentials");
    });

    it.each([
      ["email not confirmed", { code: "email_not_confirmed", message: "Email not confirmed" }, "email_not_confirmed"],
      [
        "rate limited (429)",
        { code: "over_request_rate_limit", status: 429, message: "Request rate limit reached" },
        "rate_limited",
      ],
      [
        "unknown error (raw text never shown)",
        { code: "unexpected_failure", message: "internal GoTrue detail" },
        "generic",
      ],
    ])("login failure: %s -> truthful copy", async (_name, err, expected) => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      mockSignInWithPassword.mockResolvedValue({ error: err });
      await expect(login(makeFormData({ email: "a@b.co", password: "x" }))).rejects.toThrow("REDIRECT:");
      expect(redirect).toHaveBeenCalledWith(`/login?error=${expected}`);
      expect(consoleError).toHaveBeenCalled(); // raw error logged server-side
      consoleError.mockRestore();
    });

    it("device-code sign-in: redirects to the `next` path on success (e.g. /device?code=...)", async () => {
      mockSignInWithPassword.mockResolvedValue({ error: null });

      const fd = makeFormData({
        email: "test@example.com",
        password: "secret123",
        next: "/device?code=WM7K-4F2Q",
      });

      await expect(login(fd)).rejects.toThrow("REDIRECT:/device?code=WM7K-4F2Q");
    });

    it("carries `next` through the error redirect too", async () => {
      mockSignInWithPassword.mockResolvedValue({
        error: { code: "invalid_credentials", message: "Invalid login credentials" },
      });

      const fd = makeFormData({
        email: "bad@example.com",
        password: "wrong",
        next: "/device",
      });

      await expect(login(fd)).rejects.toThrow("REDIRECT:");
      expect(redirect).toHaveBeenCalledWith("/login?error=invalid_credentials&next=%2Fdevice");
    });

    it("ATTACK: an absolute/protocol-relative `next` is never honored (open-redirect guard) — falls back to /", async () => {
      mockSignInWithPassword.mockResolvedValue({ error: null });

      const fd = makeFormData({
        email: "test@example.com",
        password: "secret123",
        next: "//evil.example.com/phish",
      });

      await expect(login(fd)).rejects.toThrow("REDIRECT:/");
    });

    it("M11 ATTACK: a leading-backslash `next` (browser-normalized to protocol-relative) falls back to /", async () => {
      mockSignInWithPassword.mockResolvedValue({ error: null });

      for (const evil of ["/\\evil.com", "/\\\\evil.com", "/\\/evil.com"]) {
        const fd = makeFormData({ email: "test@example.com", password: "secret123", next: evil });
        await expect(login(fd)).rejects.toThrow("REDIRECT:/");
      }
    });

    it(
      "NEW-5: a backslash NOT at the start normalizes to a same-origin path rather than " +
        "being rejected (the WHATWG parser only treats a LEADING slash+backslash as an " +
        "authority marker; a mid-path backslash is just a safe path separator, never a " +
        "redirect off this origin)",
      async () => {
        mockSignInWithPassword.mockResolvedValue({ error: null });

        for (const [evil, expected] of [
          ["/foo/bar\\evil.com", "/foo/bar/evil.com"],
          ["/a\\b", "/a/b"],
        ] as const) {
          const fd = makeFormData({ email: "test@example.com", password: "secret123", next: evil });
          await expect(login(fd)).rejects.toThrow(`REDIRECT:${expected}`);
        }
      },
    );

    it("ATTACK: `//` anywhere via a doubled slash mid-path is rejected only when it's the leading pair", async () => {
      mockSignInWithPassword.mockResolvedValue({ error: null });

      // Leading "//" is the actual open-redirect shape and must fall back to /.
      const fd = makeFormData({ email: "test@example.com", password: "secret123", next: "//evil.com" });
      await expect(login(fd)).rejects.toThrow("REDIRECT:/");
    });

    it(
      "a disguised-looking scheme in the path (colon after the leading slash) resolves to a " +
        "same-origin path, not an open redirect — the browser never treats it as a new scheme " +
        "because it isn't the start of the string",
      async () => {
        mockSignInWithPassword.mockResolvedValue({ error: null });

        for (const [evil, expected] of [
          ["/javascript:alert(1)", "/javascript:alert(1)"],
          ["/data:text/html,evil", "/data:text/html,evil"],
        ] as const) {
          const fd = makeFormData({ email: "test@example.com", password: "secret123", next: evil });
          await expect(login(fd)).rejects.toThrow(`REDIRECT:${expected}`);
        }
      },
    );

    it("M11: an ordinary root-relative path with a query string is still honored", async () => {
      mockSignInWithPassword.mockResolvedValue({ error: null });

      const fd = makeFormData({ email: "test@example.com", password: "secret123", next: "/device?code=WM7K-4F2Q" });
      await expect(login(fd)).rejects.toThrow("REDIRECT:/device?code=WM7K-4F2Q");
    });

    it(
      "NEW-5 ATTACK: a raw TAB/CR/LF in `next` (WHATWG strips these before parsing — " +
        "'/\\t/evil.com' would otherwise resolve to '//evil.com') falls back to /",
      async () => {
        mockSignInWithPassword.mockResolvedValue({ error: null });

        for (const evil of ["/\t/evil.com", "/\r/evil.com", "/\n/evil.com", "/\r\n/evil.com"]) {
          const fd = makeFormData({ email: "test@example.com", password: "secret123", next: evil });
          await expect(login(fd)).rejects.toThrow("REDIRECT:/");
        }
      },
    );

    it("NEW-5 ATTACK: a percent-encoded control char (e.g. /%09/evil.com) falls back to /", async () => {
      mockSignInWithPassword.mockResolvedValue({ error: null });

      for (const evil of ["/%09/evil.com", "/%0d%0a/evil.com", "/%00/evil.com", "/%7f/evil.com"]) {
        const fd = makeFormData({ email: "test@example.com", password: "secret123", next: evil });
        await expect(login(fd)).rejects.toThrow("REDIRECT:/");
      }
    });

    it("NEW-5 ATTACK: any other raw C0 control char falls back to /", async () => {
      mockSignInWithPassword.mockResolvedValue({ error: null });

      const fd = makeFormData({ email: "test@example.com", password: "secret123", next: "/\x00/evil.com" });
      await expect(login(fd)).rejects.toThrow("REDIRECT:/");
    });

    it(
      "NEW-6 ATTACK: `..`/duplicate-slash traversal that WHATWG-normalizes to a " +
        "protocol-relative output ('//evil.com') falls back to / — the pre-fix code " +
        "validated only the raw input and returned the normalized output unchecked",
      async () => {
        mockSignInWithPassword.mockResolvedValue({ error: null });

        for (const evil of [
          "/..//evil.com",
          "/.//evil.com",
          "/a/..//evil.com",
          "/../\\evil.com",
          "/%2e%2e//evil.com",
        ]) {
          const fd = makeFormData({ email: "test@example.com", password: "secret123", next: evil });
          await expect(login(fd)).rejects.toThrow("REDIRECT:/");
        }
      },
    );

    it("NEW-6: an ordinary path with query and hash is still honored", async () => {
      mockSignInWithPassword.mockResolvedValue({ error: null });

      const fd = makeFormData({ email: "test@example.com", password: "secret123", next: "/ok?next=1#x" });
      await expect(login(fd)).rejects.toThrow("REDIRECT:/ok?next=1#x");
    });

    // ---- Issue #127: per-IP login throttle ----

    it("refuses with a friendly error when the per-IP login rate limit is hit, without calling signInWithPassword", async () => {
      mockEnforceRateLimit.mockResolvedValueOnce({ allowed: false, retryAfter: 60 });

      const fd = makeFormData({ email: "test@example.com", password: "secret123" });

      await expect(login(fd)).rejects.toThrow("REDIRECT:");
      expect(redirect).toHaveBeenCalledWith(expect.stringContaining("error=rate_limited"));
      expect(mockSignInWithPassword).not.toHaveBeenCalled();
    });
  });

  describe("signup", () => {
    // Sign-up only works on a local runtime (D-081); hosted cases opt out below.
    beforeEach(() => {
      vi.stubEnv("MEMBRAL_LOCAL", "1");
      vi.stubEnv("VERCEL", "");
    });
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("D-081: refuses on hosted (MEMBRAL_LOCAL unset) without calling signUp, even with the kill switch off", async () => {
      vi.stubEnv("MEMBRAL_LOCAL", "");
      const fd = makeFormData({ email: "new@example.com", password: "newpass123" });
      await expect(signup(fd)).rejects.toThrow("REDIRECT:/signup?error=signups_closed");
      expect(mockSignUp).not.toHaveBeenCalled();
    });

    it("D-081: refuses when VERCEL is set even if MEMBRAL_LOCAL=1", async () => {
      vi.stubEnv("VERCEL", "1");
      const fd = makeFormData({ email: "new@example.com", password: "newpass123" });
      await expect(signup(fd)).rejects.toThrow("REDIRECT:/signup?error=signups_closed");
      expect(mockSignUp).not.toHaveBeenCalled();
    });

    it("calls signUp with email and password from form data", async () => {
      mockSignUp.mockResolvedValue({ data: { session: { access_token: "tok" } }, error: null });

      const fd = makeFormData({
        email: "new@example.com",
        password: "newpass123",
      });

      await expect(signup(fd)).rejects.toThrow("REDIRECT:/");

      expect(mockSignUp).toHaveBeenCalledWith({
        email: "new@example.com",
        password: "newpass123",
        options: { emailRedirectTo: "http://localhost:3000/login" },
      });
    });

    it("redirects to /signup with error on failure", async () => {
      mockSignUp.mockResolvedValue({
        error: { message: "User already exists" },
      });

      const fd = makeFormData({
        email: "dup@example.com",
        password: "pass123",
      });

      await expect(signup(fd)).rejects.toThrow("REDIRECT:");
      expect(redirect).toHaveBeenCalledWith("/signup?error=signup_failed");
    });

    it("device-code sign-in: redirects to the `next` path on success", async () => {
      mockSignUp.mockResolvedValue({ data: { session: { access_token: "tok" } }, error: null });

      const fd = makeFormData({
        email: "new@example.com",
        password: "newpass123",
        next: "/device?code=WM7K-4F2Q",
      });

      await expect(signup(fd)).rejects.toThrow("REDIRECT:/device?code=WM7K-4F2Q");
    });

    // ---- Issue #127 (D9): email confirmation on -> no session returned ----

    it("redirects to /signup/check-email when signUp succeeds with no session (email confirmation on)", async () => {
      mockSignUp.mockResolvedValue({ data: { session: null, user: { id: "u1" } }, error: null });

      const fd = makeFormData({ email: "new@example.com", password: "newpass123" });

      await expect(signup(fd)).rejects.toThrow("REDIRECT:/signup/check-email");
      expect(revalidatePath).not.toHaveBeenCalled();
    });

    // ---- Issue #127: MEMBRAL_SIGNUPS_DISABLED kill-switch ----

    it("refuses with a friendly error when MEMBRAL_SIGNUPS_DISABLED=1, without calling signUp", async () => {
      process.env.MEMBRAL_SIGNUPS_DISABLED = "1";

      const fd = makeFormData({ email: "new@example.com", password: "newpass123" });

      await expect(signup(fd)).rejects.toThrow("REDIRECT:");
      expect(redirect).toHaveBeenCalledWith(expect.stringContaining("error=signups_closed"));
      expect(mockSignUp).not.toHaveBeenCalled();
    });

    // ---- Issue #134 adversarial review round 3/4 (R3-B1/R3-M1/R4-M2) ----

    it("R3: eagerly stamps the durable marker when MEMBRAL_SIGNUPS_DISABLED=1", async () => {
      process.env.MEMBRAL_SIGNUPS_DISABLED = "1";

      const fd = makeFormData({ email: "new@example.com", password: "newpass123" });

      await expect(signup(fd)).rejects.toThrow("REDIRECT:");
      expect(mockEnsureSignupsDisabledMarker).toHaveBeenCalledTimes(1);
    });

    it("R4-M2: never touches the marker on an ordinary signup when signups are open (the app never clears it)", async () => {
      mockSignUp.mockResolvedValue({ data: { session: { access_token: "tok" } }, error: null });

      const fd = makeFormData({ email: "new@example.com", password: "newpass123" });

      await expect(signup(fd)).rejects.toThrow("REDIRECT:/");
      expect(mockEnsureSignupsDisabledMarker).not.toHaveBeenCalled();
    });

    it.each([
      [{ code: "weak_password", message: "Password should be at least 8 characters." }, "weak_password&min=8"],
      [{ code: "weak_password", message: "Password is too weak" }, "weak_password"],
      [{ code: "email_address_invalid", message: "Email address is invalid" }, "email_invalid"],
      [{ code: "user_already_exists", message: "User already registered" }, "user_exists"],
    ])("signup error %j -> key %s", async (err, expected) => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      mockSignUp.mockResolvedValue({ data: { user: null, session: null }, error: err });
      await expect(signup(makeFormData({ email: "a@b.co", password: "x" }))).rejects.toThrow("REDIRECT:");
      expect(redirect).toHaveBeenCalledWith(`/signup?error=${expected}`);
      consoleError.mockRestore();
    });

    // ---- Issue #133: resubmit inside GoTrue's per-address cooldown ----

    it(
      "redirects to /signup/check-email (never /signup?error=) when signUp fails with " +
        "over_email_send_rate_limit (a resubmit inside GoTrue's ~60s post-signup cooldown " +
        "— the first submit already created the account and sent the email)",
      async () => {
        mockSignUp.mockResolvedValue({
          data: { user: { id: "u1" }, session: null },
          error: {
            code: "over_email_send_rate_limit",
            status: 429,
            message: "For security purposes, you can only request this after 52 seconds.",
          },
        });

        const fd = makeFormData({ email: "new@example.com", password: "newpass123" });

        await expect(signup(fd)).rejects.toThrow("REDIRECT:/signup/check-email");
        expect(redirect).not.toHaveBeenCalledWith(expect.stringContaining("/signup?error="));
      },
    );

    // ---- Issue #133 adversarial review round 1, MAJOR M1 ----

    it(
      "M1: shows a plain per-network rate-limit error (NEVER check-email) when signUp fails with " +
        "over_request_rate_limit — the per-IP endpoint limiter, which fires before any account exists",
      async () => {
        mockSignUp.mockResolvedValue({
          error: {
            code: "over_request_rate_limit",
            status: 429,
            message: "Request rate limit reached",
          },
        });

        const fd = makeFormData({ email: "new@example.com", password: "newpass123" });

        await expect(signup(fd)).rejects.toThrow("REDIRECT:");
        expect(redirect).toHaveBeenCalledWith(expect.stringContaining("error=rate_limited"));
        expect(redirect).not.toHaveBeenCalledWith(expect.stringContaining("/signup/check-email"));
      },
    );

    // ---- Issue #133 adversarial review round 1, MAJOR M2 ----

    it(
      "M2: shows a distinct 'try again in an hour' error (NEVER check-email) when over_email_send_rate_limit " +
        "lacks the per-address cooldown message shape — the project's hourly email quota, not a resubmit; " +
        "GoTrue rolled the signup back, so nothing was created and no email was sent",
      async () => {
        mockSignUp.mockResolvedValue({
          error: {
            code: "over_email_send_rate_limit",
            status: 429,
            message: "Email rate limit exceeded",
          },
        });

        const fd = makeFormData({ email: "new@example.com", password: "newpass123" });

        await expect(signup(fd)).rejects.toThrow("REDIRECT:");
        expect(redirect).toHaveBeenCalledWith(expect.stringContaining("error=email_quota"));
        expect(redirect).not.toHaveBeenCalledWith(expect.stringContaining("/signup/check-email"));
      },
    );

    // ---- Issue #133 adversarial review round 2, minor R2-m3 ----

    it(
      "R2-m3: still lands on check-email (not the raw 'only request this after' text on the error banner) " +
        "when the cooldown error arrives with NO `code` at all — an SDK version/proxy that doesn't surface it",
      async () => {
        mockSignUp.mockResolvedValue({
          error: { message: "For security purposes, you can only request this after 30 seconds." },
        });

        const fd = makeFormData({ email: "new@example.com", password: "newpass123" });

        await expect(signup(fd)).rejects.toThrow("REDIRECT:/signup/check-email?resent=1");
        expect(redirect).not.toHaveBeenCalledWith(expect.stringContaining("/signup?error="));
      },
    );

    // ---- Round-2 review HIGH 5: migration 079's DB-level trigger ----

    it("translates the local-GoTrue form of a blocked-signup DB error into the friendly message", async () => {
      mockSignUp.mockResolvedValue({ error: { message: "signups_disabled" } });
      const fd = makeFormData({ email: "new@example.com", password: "newpass123" });
      await expect(signup(fd)).rejects.toThrow("REDIRECT:");
      expect(redirect).toHaveBeenCalledWith(expect.stringContaining("error=signups_closed"));
    });

    it("translates the generic hosted-GoTrue form of a blocked-signup DB error into the friendly message", async () => {
      mockSignUp.mockResolvedValue({ error: { message: "Database error saving new user" } });
      const fd = makeFormData({ email: "new@example.com", password: "newpass123" });
      await expect(signup(fd)).rejects.toThrow("REDIRECT:");
      expect(redirect).toHaveBeenCalledWith(expect.stringContaining("error=signups_closed"));
    });

    // ---- Issue #127: per-IP signup throttle ----

    it("refuses with a friendly error when the per-IP signup rate limit is hit", async () => {
      mockEnforceRateLimit.mockResolvedValueOnce({ allowed: false, retryAfter: 60 });

      const fd = makeFormData({ email: "new@example.com", password: "newpass123" });

      await expect(signup(fd)).rejects.toThrow("REDIRECT:");
      expect(redirect).toHaveBeenCalledWith(expect.stringContaining("error=rate_limited"));
      expect(mockSignUp).not.toHaveBeenCalled();
    });
  });

  describe("resendConfirmation", () => {
    // ---- Issue #133 adversarial review round 1, minor m1 ----

    it("redirects to check-email?resent=1 when resend() succeeds", async () => {
      mockResend.mockResolvedValue({ error: null });

      const fd = makeFormData({ email: "new@example.com" });

      await expect(resendConfirmation(fd)).rejects.toThrow("REDIRECT:/signup/check-email?resent=1");
      expect(mockResend).toHaveBeenCalledWith({ type: "signup", email: "new@example.com" });
    });

    it("redirects to check-email?resent=1 when resend() hits the per-address cooldown (not a failure)", async () => {
      mockResend.mockResolvedValue({
        error: {
          code: "over_email_send_rate_limit",
          message: "For security purposes, you can only request this after 52 seconds.",
        },
      });

      const fd = makeFormData({ email: "new@example.com" });

      await expect(resendConfirmation(fd)).rejects.toThrow("REDIRECT:/signup/check-email?resent=1");
    });

    it("shows the hourly-quota error (not resent=1) when resend()'s over_email_send_rate_limit lacks the cooldown message shape", async () => {
      mockResend.mockResolvedValue({
        error: { code: "over_email_send_rate_limit", message: "Email rate limit exceeded" },
      });

      const fd = makeFormData({ email: "new@example.com" });

      await expect(resendConfirmation(fd)).rejects.toThrow("REDIRECT:");
      expect(redirect).toHaveBeenCalledWith(expect.stringContaining("error=email_quota"));
    });

    it("asks for an email instead of calling resend() when the field is blank", async () => {
      const fd = makeFormData({ email: "" });

      await expect(resendConfirmation(fd)).rejects.toThrow("REDIRECT:");
      expect(redirect).toHaveBeenCalledWith(expect.stringContaining("error=email_required"));
      expect(mockResend).not.toHaveBeenCalled();
    });

    it("refuses with a friendly error when the per-IP rate limit is hit, without calling resend()", async () => {
      mockEnforceRateLimit.mockResolvedValueOnce({ allowed: false, retryAfter: 60 });

      const fd = makeFormData({ email: "new@example.com" });

      await expect(resendConfirmation(fd)).rejects.toThrow("REDIRECT:");
      expect(redirect).toHaveBeenCalledWith(expect.stringContaining("error=rate_limited"));
      expect(mockResend).not.toHaveBeenCalled();
    });

    // ---- Issue #133 adversarial review round 2, minor R2-m1 ----

    it("R2-m1: collapses any other resend() error (already-confirmed address, GoTrue internals, ...) to one generic sentence, never the raw text", async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      mockResend.mockResolvedValue({
        error: { message: "Email link is invalid or has expired" },
      });

      const fd = makeFormData({ email: "new@example.com" });

      await expect(resendConfirmation(fd)).rejects.toThrow("REDIRECT:");
      expect(redirect).toHaveBeenCalledWith(expect.stringContaining("error=resend_failed"));
      expect(redirect).not.toHaveBeenCalledWith(expect.stringContaining("Email%20link%20is%20invalid"));
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining("[resendConfirmation]"),
        expect.stringContaining("Email link is invalid"),
      );
      consoleError.mockRestore();
    });
  });

  describe("signInWithGoogle", () => {
    it("calls signInWithOAuth with provider google and a redirectTo ending in /auth/callback, then redirects to the returned url", async () => {
      mockSignInWithOAuth.mockResolvedValue({
        data: { url: "https://accounts.google.com/o/oauth2/v2/auth?client_id=abc" },
        error: null,
      });

      const fd = makeFormData({});
      await expect(signInWithGoogle(fd)).rejects.toThrow(
        "REDIRECT:https://accounts.google.com/o/oauth2/v2/auth?client_id=abc",
      );

      expect(mockSignInWithOAuth).toHaveBeenCalledWith({
        provider: "google",
        options: { redirectTo: "http://localhost:3000/auth/callback?next=%2F" },
      });
    });

    it("rewrites a SUPABASE_INTERNAL_URL authorize url to the public NEXT_PUBLIC_SUPABASE_URL for the browser", async () => {
      vi.stubEnv("SUPABASE_INTERNAL_URL", "http://gateway:8000");
      vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://localhost:54321");
      try {
        mockSignInWithOAuth.mockResolvedValue({
          data: { url: "http://gateway:8000/auth/v1/authorize?provider=google&redirect_to=x" },
          error: null,
        });
        await expect(signInWithGoogle(makeFormData({}))).rejects.toThrow(
          "REDIRECT:http://localhost:54321/auth/v1/authorize?provider=google&redirect_to=x",
        );
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it("leaves a non-internal url (Google) untouched even when SUPABASE_INTERNAL_URL is set", async () => {
      vi.stubEnv("SUPABASE_INTERNAL_URL", "http://gateway:8000");
      vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://localhost:54321");
      try {
        mockSignInWithOAuth.mockResolvedValue({ data: { url: "https://accounts.google.com/x" }, error: null });
        await expect(signInWithGoogle(makeFormData({}))).rejects.toThrow("REDIRECT:https://accounts.google.com/x");
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it("carries a validated `next` through the redirectTo's next= param", async () => {
      mockSignInWithOAuth.mockResolvedValue({ data: { url: "https://accounts.google.com/x" }, error: null });

      const fd = makeFormData({ next: "/device?code=WM7K-4F2Q" });
      await expect(signInWithGoogle(fd)).rejects.toThrow("REDIRECT:https://accounts.google.com/x");

      expect(mockSignInWithOAuth).toHaveBeenCalledWith({
        provider: "google",
        options: { redirectTo: "http://localhost:3000/auth/callback?next=%2Fdevice%3Fcode%3DWM7K-4F2Q" },
      });
    });

    it("ATTACK: an absolute/protocol-relative `next` is sanitised to / before being embedded in redirectTo", async () => {
      mockSignInWithOAuth.mockResolvedValue({ data: { url: "https://accounts.google.com/x" }, error: null });

      const fd = makeFormData({ next: "//evil.example.com/phish" });
      await expect(signInWithGoogle(fd)).rejects.toThrow("REDIRECT:https://accounts.google.com/x");

      expect(mockSignInWithOAuth).toHaveBeenCalledWith({
        provider: "google",
        options: { redirectTo: "http://localhost:3000/auth/callback?next=%2F" },
      });
    });

    it("redirects to /login?error= when signInWithOAuth errors", async () => {
      mockSignInWithOAuth.mockResolvedValue({ data: { url: null }, error: { message: "provider not enabled" } });

      const fd = makeFormData({});
      await expect(signInWithGoogle(fd)).rejects.toThrow("REDIRECT:/login?error=generic");
    });

    // ---- Issue #134 adversarial review round 1, minor m5 ----

    it("m5: preserves `next` on the error redirect when signInWithOAuth fails, matching login()/signup() (previously dropped)", async () => {
      mockSignInWithOAuth.mockResolvedValue({ data: { url: null }, error: { message: "provider not enabled" } });

      const fd = makeFormData({ next: "/device?code=WM7K-4F2Q" });
      await expect(signInWithGoogle(fd)).rejects.toThrow(
        "REDIRECT:/login?error=generic&next=%2Fdevice%3Fcode%3DWM7K-4F2Q",
      );
    });

    it("m5: refuses with a friendly error when the per-IP throttle is hit, without calling signInWithOAuth (previously the one unthrottled auth entry point)", async () => {
      mockEnforceRateLimit.mockResolvedValueOnce({ allowed: false, retryAfter: 60 });

      const fd = makeFormData({});
      await expect(signInWithGoogle(fd)).rejects.toThrow("REDIRECT:");
      expect(redirect).toHaveBeenCalledWith(expect.stringContaining("error=rate_limited"));
      expect(mockSignInWithOAuth).not.toHaveBeenCalled();
    });

    // ---- Issue #134 adversarial review round 3/4 (R3-M1/R4-M2) ----

    it(
      "R3-M1: eagerly stamps the durable marker BEFORE redirecting to Google — closes the race where GoTrue " +
        "creates the auth.users row (during its own callback hop) faster than the app's own callback route " +
        "could stamp the marker after the fact",
      async () => {
        process.env.MEMBRAL_SIGNUPS_DISABLED = "1";
        mockSignInWithOAuth.mockResolvedValue({ data: { url: "https://accounts.google.com/x" }, error: null });

        const fd = makeFormData({});
        await expect(signInWithGoogle(fd)).rejects.toThrow("REDIRECT:https://accounts.google.com/x");

        expect(mockEnsureSignupsDisabledMarker).toHaveBeenCalledTimes(1);
      },
    );

    it("R4-M2: never touches the marker when signups are open (the app never clears it), and still redirects to Google", async () => {
      mockSignInWithOAuth.mockResolvedValue({ data: { url: "https://accounts.google.com/x" }, error: null });

      const fd = makeFormData({});
      await expect(signInWithGoogle(fd)).rejects.toThrow("REDIRECT:https://accounts.google.com/x");

      expect(mockEnsureSignupsDisabledMarker).not.toHaveBeenCalled();
    });
  });

  describe("logout", () => {
    it("calls signOut and redirects to /login", async () => {
      mockSignOut.mockResolvedValue({ error: null });

      await expect(logout()).rejects.toThrow("REDIRECT:/login");
      expect(mockSignOut).toHaveBeenCalled();
    });
  });
});
