import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks ---

const mockExchangeCodeForSession = vi.fn();
const mockSignOut = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(() =>
    Promise.resolve({
      auth: { exchangeCodeForSession: mockExchangeCodeForSession, signOut: mockSignOut },
    }),
  ),
}));

const mockSignupsDisabled = vi.fn(() => false);
vi.mock("@/lib/env", () => ({
  signupsDisabled: () => mockSignupsDisabled(),
}));

// #134 adversarial review round 2/3/4: the durable-marker decision
// (lib/signups-disabled-marker.ts) has its own dedicated test files
// (lib/__tests__/signups-disabled-marker.test.ts for the unit-level
// upsert/select-against-Postgres behaviour, and
// signups-disabled-marker.lifecycle.test.ts for the full two-incident
// lifecycle proof — cases (2)/(3)/(4) from round 3's brief). Here it's
// mocked directly so this file can control "blocked" vs. "not blocked" per
// test without standing up a fake DB. R4-M2: this route no longer imports
// or calls anything that CLEARS the marker — see the module's own comment
// for why an app-side clear was removed entirely (only scripts/flags.ts's
// `signups on` clears it now).
const mockWasCreatedWhileSignupsDisabled = vi.fn();
vi.mock("@/lib/signups-disabled-marker", () => ({
  wasCreatedWhileSignupsDisabled: (createdAtIso: string) => mockWasCreatedWhileSignupsDisabled(createdAtIso),
}));

// getAppUrl() is no longer used by this route (issue #134 adversarial
// review round 1, minor m3) — redirects resolve against `request.url`
// instead, which is why every expected `location` below shares the
// request's own http://localhost:3000 host without any env setup.

import { APP_ROUTES } from "@/lib/app-routes";
import { GET } from "../route";

function req(url: string): NextRequest {
  return new NextRequest(new Request(url));
}

const EXISTING_USER = {
  id: "u-existing",
  created_at: "2026-01-01T00:00:00.000Z",
  last_sign_in_at: "2026-09-08T12:00:00.000Z",
  identities: [{ provider: "google" }],
};

function justCreatedUser(id = "u-new") {
  const now = new Date().toISOString();
  return { id, created_at: now, last_sign_in_at: now, identities: [{ provider: "google" }] };
}

describe("GET /auth/callback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSignupsDisabled.mockReturnValue(false);
    mockWasCreatedWhileSignupsDisabled.mockResolvedValue(false);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("exchanges a valid code and redirects to the validated `next` path", async () => {
    mockExchangeCodeForSession.mockResolvedValue({ error: null, data: { user: EXISTING_USER } });

    const res = await GET(req("http://localhost:3000/auth/callback?code=abc123&next=%2Fconversations"));

    expect(mockExchangeCodeForSession).toHaveBeenCalledWith("abc123");
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://localhost:3000/conversations");
  });

  // ---- #134 adversarial review round 1, BLOCKER B1 ----

  it("BLOCKER B1: defaults to the same landing route email/password login uses on success (not the deleted /dashboard route)", async () => {
    mockExchangeCodeForSession.mockResolvedValue({ error: null, data: { user: EXISTING_USER } });

    const res = await GET(req("http://localhost:3000/auth/callback?code=abc123"));

    const location = res.headers.get("location");
    // (auth)/actions.ts's login()/signup() both redirect(next) where next
    // defaults to safeNext(null) === "/" — the exact same value this route
    // now falls back to.
    expect(location).toBe("http://localhost:3000/");
    const path = new URL(location as string).pathname;
    expect(APP_ROUTES).toContain(path);
  });

  it("redirects to /login?error= with no exchange attempt when `code` is missing", async () => {
    const res = await GET(req("http://localhost:3000/auth/callback?next=%2Fconversations"));

    expect(mockExchangeCodeForSession).not.toHaveBeenCalled();
    expect(res.headers.get("location")).toBe("http://localhost:3000/login?error=missing_code");
  });

  // ---- #134 adversarial review round 1, MAJOR M4: raw GoTrue error text ----

  it("M4: maps a PKCE verifier-missing error to a short plain sentence, not the raw ~300-char GoTrue message", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mockExchangeCodeForSession.mockResolvedValue({
      error: {
        message:
          "PKCE code verifier not found in storage. This can happen if the auth flow was initiated in a different browser or device, or if the storage was cleared. For SSR frameworks (Next.js, SvelteKit, etc.), use @supabase/ssr on both the server and client to store the code verifier in cookies.",
      },
    });

    const res = await GET(req("http://localhost:3000/auth/callback?code=bad"));

    expect(res.headers.get("location")).toBe(`http://localhost:3000/login?error=oauth_expired`);
    // the raw message is still available server-side for diagnosis
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("[auth/callback]"),
      expect.stringContaining("PKCE"),
    );
    consoleError.mockRestore();
  });

  it("M4: maps any other exchange error to a generic sentence, never the raw provider text", async () => {
    mockExchangeCodeForSession.mockResolvedValue({ error: { message: "something unexpected" } });

    const res = await GET(req("http://localhost:3000/auth/callback?code=bad"));

    expect(res.headers.get("location")).toBe(`http://localhost:3000/login?error=generic`);
  });

  it("M3: maps migration 079's DB-level signups-disabled trigger error to the same friendly copy signup() uses", async () => {
    mockExchangeCodeForSession.mockResolvedValue({ error: { message: "signups_disabled" } });

    const res = await GET(req("http://localhost:3000/auth/callback?code=bad"));

    expect(res.headers.get("location")).toBe(`http://localhost:3000/login?error=signups_closed`);
  });

  // ---- #134 adversarial review round 1, MAJOR M3: env kill-switch parity ----
  // (round 2, R2-B1: the "is this new" test is now delegated to the durable
  // marker in lib/signups-disabled-marker.ts, mocked here — see that
  // module's own test file for the retry-proof guarantee itself.)

  it("M3: signs out and refuses when the durable marker says this identity was created while signups are disabled", async () => {
    mockSignupsDisabled.mockReturnValue(true);
    mockWasCreatedWhileSignupsDisabled.mockResolvedValue(true);
    const newUser = justCreatedUser();
    mockExchangeCodeForSession.mockResolvedValue({ error: null, data: { user: newUser } });

    const res = await GET(req("http://localhost:3000/auth/callback?code=abc123"));

    expect(mockWasCreatedWhileSignupsDisabled).toHaveBeenCalledWith(newUser.created_at);
    expect(mockSignOut).toHaveBeenCalled();
    expect(res.headers.get("location")).toBe(`http://localhost:3000/login?error=signups_closed`);
  });

  it("M3: an EXISTING user's Google login still works while MEMBRAL_SIGNUPS_DISABLED is set (marker says not-blocked)", async () => {
    mockSignupsDisabled.mockReturnValue(true);
    mockWasCreatedWhileSignupsDisabled.mockResolvedValue(false);
    mockExchangeCodeForSession.mockResolvedValue({ error: null, data: { user: EXISTING_USER } });

    const res = await GET(req("http://localhost:3000/auth/callback?code=abc123&next=%2Fconversations"));

    expect(mockSignOut).not.toHaveBeenCalled();
    expect(res.headers.get("location")).toBe("http://localhost:3000/conversations");
  });

  it("M3: a newly-created user is let through when signups are NOT disabled, without even consulting the marker", async () => {
    mockSignupsDisabled.mockReturnValue(false);
    mockExchangeCodeForSession.mockResolvedValue({ error: null, data: { user: justCreatedUser() } });

    const res = await GET(req("http://localhost:3000/auth/callback?code=abc123"));

    expect(mockWasCreatedWhileSignupsDisabled).not.toHaveBeenCalled();
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(res.headers.get("location")).toBe("http://localhost:3000/");
  });

  // ---- #134 adversarial review round 2, BLOCKER R2-B1 ----

  it(
    "R2-B1: the SAME user is refused on a SECOND click, not just the first — round 1's created_at/" +
      "last_sign_in_at-proximity heuristic let a retry through because the refusal leaves the row in place; " +
      "the durable marker gives the identical (blocked) answer regardless of how many times it's asked",
    async () => {
      mockSignupsDisabled.mockReturnValue(true);
      mockWasCreatedWhileSignupsDisabled.mockResolvedValue(true);
      const sameUser = justCreatedUser("u-retried");

      mockExchangeCodeForSession.mockResolvedValue({ error: null, data: { user: sameUser } });
      const first = await GET(req("http://localhost:3000/auth/callback?code=abc123"));

      // second click, same identity, now with a FRESH last_sign_in_at
      // (exactly what defeated round 1's timing heuristic) — the mock
      // still reports "blocked" because it's keyed on created_at, not on
      // proximity to last_sign_in_at.
      mockExchangeCodeForSession.mockResolvedValue({
        error: null,
        data: { user: { ...sameUser, last_sign_in_at: new Date(Date.now() + 30_000).toISOString() } },
      });
      const second = await GET(req("http://localhost:3000/auth/callback?code=abc456"));

      for (const res of [first, second]) {
        expect(res.headers.get("location")).toBe(`http://localhost:3000/login?error=signups_closed`);
      }
      expect(mockSignOut).toHaveBeenCalledTimes(2);
    },
  );

  // ---- #134 adversarial review round 3 ----

  it(
    "(1) R3: an existing user with a non-Google identity (email/password) linking Google during a closed window " +
      "is NEVER blocked, even if the marker check alone would say so — belt-and-braces defense-in-depth",
    async () => {
      mockSignupsDisabled.mockReturnValue(true);
      // Deliberately adversarial: the marker mock says "blocked" (as if
      // this row's created_at somehow looked post-flip) to prove the
      // identities guard is what's actually saving this user, not a
      // marker check that happened to be lenient.
      mockWasCreatedWhileSignupsDisabled.mockResolvedValue(true);
      const existingPasswordUserLinkingGoogle = {
        id: "u-password-linking-google",
        created_at: "2026-06-01T00:00:00.000Z",
        last_sign_in_at: "2026-09-08T12:00:00.000Z",
        identities: [{ provider: "email" }, { provider: "google" }],
      };
      mockExchangeCodeForSession.mockResolvedValue({ error: null, data: { user: existingPasswordUserLinkingGoogle } });

      const res = await GET(req("http://localhost:3000/auth/callback?code=abc123&next=%2Fsettings"));

      expect(mockSignOut).not.toHaveBeenCalled();
      expect(res.headers.get("location")).toBe("http://localhost:3000/settings");
    },
  );

  it("R4-M2: never consults the marker (and never blocks) when the switch is observed OFF on a successful exchange", async () => {
    mockSignupsDisabled.mockReturnValue(false);
    mockExchangeCodeForSession.mockResolvedValue({ error: null, data: { user: EXISTING_USER } });

    const res = await GET(req("http://localhost:3000/auth/callback?code=abc123"));

    expect(mockWasCreatedWhileSignupsDisabled).not.toHaveBeenCalled();
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(res.headers.get("location")).toBe("http://localhost:3000/");
  });

  // ---- open-redirect regression coverage (unchanged behaviour, new default) ----

  it("ATTACK: an absolute-URL `next` (https://evil.example) falls back to the default landing route, not an open redirect", async () => {
    mockExchangeCodeForSession.mockResolvedValue({ error: null, data: { user: EXISTING_USER } });

    const res = await GET(req("http://localhost:3000/auth/callback?code=abc123&next=https%3A%2F%2Fevil.example"));

    expect(res.headers.get("location")).toBe("http://localhost:3000/");
  });

  it("ATTACK: a protocol-relative `next` (//evil.example) falls back to the default landing route, not an open redirect", async () => {
    mockExchangeCodeForSession.mockResolvedValue({ error: null, data: { user: EXISTING_USER } });

    const res = await GET(req("http://localhost:3000/auth/callback?code=abc123&next=%2F%2Fevil.example"));

    expect(res.headers.get("location")).toBe("http://localhost:3000/");
  });

  // ---- #134 adversarial review round 1, MINOR m3 ----

  it("m3: redirects relative to the request's own origin, not a hardcoded app URL (e.g. a Vercel preview deploy)", async () => {
    mockExchangeCodeForSession.mockResolvedValue({ error: null, data: { user: EXISTING_USER } });

    const res = await GET(req("https://my-branch-git-preview.vercel.app/auth/callback?code=abc123&next=%2Fpulse"));

    expect(res.headers.get("location")).toBe("https://my-branch-git-preview.vercel.app/pulse");
  });

  // ---- #134 adversarial review round 2, MAJOR R2-M1: the OAuth provider error channel ----

  describe("provider error channel (error / error_code / error_description)", () => {
    it("access_denied (user clicked Cancel on Google's consent screen) -> a quiet, specific sentence, no exchange attempt", async () => {
      const res = await GET(
        req(
          "http://localhost:3000/auth/callback?error=access_denied&error_code=access_denied&error_description=User+denied+access",
        ),
      );

      expect(mockExchangeCodeForSession).not.toHaveBeenCalled();
      expect(res.headers.get("location")).toBe(`http://localhost:3000/login?error=cancelled`);
    });

    it(
      "signups_disabled arriving via error_description (migration 079's DB trigger, tripped during GoTrue's OWN " +
        "auth.users insert) -> friendlyCallbackError's isSignupsDisabledDbError branch, actually reachable now",
      async () => {
        const res = await GET(
          req(
            "http://localhost:3000/auth/callback?error=server_error&error_code=unexpected_failure&error_description=signups_disabled",
          ),
        );

        expect(mockExchangeCodeForSession).not.toHaveBeenCalled();
        expect(res.headers.get("location")).toBe(`http://localhost:3000/login?error=signups_closed`);
      },
    );

    it.each([
      [
        "signup_disabled",
        "error=server_error&error_code=signup_disabled&error_description=Signups+not+allowed",
        "signups_closed",
      ],
      [
        "bad_oauth_state",
        "error=invalid_request&error_code=bad_oauth_state&error_description=OAuth+state+is+invalid",
        "oauth_expired",
      ],
      ["flow_state_expired", "error=invalid_request&error_code=flow_state_expired", "oauth_expired"],
      [
        "otp_expired (wins over access_denied)",
        "error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired",
        "otp_expired",
      ],
    ])("error_code=%s -> /login with specific copy", async (_n, query, expected) => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      const res = await GET(req(`http://localhost:3000/auth/callback?${query}`));
      expect(res.headers.get("location")).toBe(`http://localhost:3000/login?error=${expected}`);
      consoleError.mockRestore();
    });

    it("an unrecognized provider error -> the generic sentence, raw params logged server-side only", async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      const res = await GET(
        req(
          "http://localhost:3000/auth/callback?error=server_error&error_code=unexpected_failure&error_description=Something+broke+in+GoTrue",
        ),
      );

      expect(res.headers.get("location")).toBe(`http://localhost:3000/login?error=generic`);
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining("[auth/callback]"),
        expect.objectContaining({ error: "server_error" }),
      );
      consoleError.mockRestore();
    });

    it("no error params and no code -> still 'Missing sign-in code.' (unchanged)", async () => {
      const res = await GET(req("http://localhost:3000/auth/callback"));

      expect(mockExchangeCodeForSession).not.toHaveBeenCalled();
      expect(res.headers.get("location")).toBe("http://localhost:3000/login?error=missing_code");
    });
  });
});
