// Issue #127: "/" used to redirect unconditionally (unauthenticated ->
// /login, authenticated -> /pulse) — a logged-out visitor never saw
// app/page.tsx's landing page at all. This locks the fixed behavior down:
// logged-out "/" falls through (renders the landing page), logged-in "/"
// still redirects to /pulse. Also covers the new public paths (/setup,
// /downloads/*) added alongside it.
import { NextRequest, type NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

let mockUser: { id: string } | null = null;
const mockGetUser = vi.fn(async () => ({ data: { user: mockUser } }));

vi.mock("@supabase/ssr", () => ({
  createServerClient: vi.fn(() => ({
    auth: { getUser: mockGetUser },
  })),
}));

process.env.NEXT_PUBLIC_SUPABASE_URL = "http://localhost:54321";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";

import { middleware } from "../middleware";

function makeRequest(path: string): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`);
}

function locationOf(res: NextResponse): string | null {
  return res.headers.get("location");
}

describe("middleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUser = null;
  });

  describe('"/" (issue #127)', () => {
    it("logged-out: falls through — no redirect, so the landing page (app/page.tsx) renders", async () => {
      mockUser = null;
      const res = await middleware(makeRequest("/"));
      expect(res.status).not.toBe(307);
      expect(locationOf(res)).toBeNull();
    });

    it("logged-in: redirects to /pulse", async () => {
      mockUser = { id: "user-1" };
      const res = await middleware(makeRequest("/"));
      expect(locationOf(res)).toBe("http://localhost:3000/pulse");
    });
  });

  describe("public paths added for onboarding self-sufficiency (issue #127)", () => {
    it("/setup never redirects an unauthenticated visitor to /login", async () => {
      mockUser = null;
      const res = await middleware(makeRequest("/setup"));
      expect(locationOf(res)).toBeNull();
    });

    it("/setup never bounces an authenticated visitor away either", async () => {
      mockUser = { id: "user-1" };
      const res = await middleware(makeRequest("/setup"));
      expect(locationOf(res)).toBeNull();
    });

    it("/downloads/membral-extension.zip never redirects an unauthenticated visitor to /login", async () => {
      mockUser = null;
      const res = await middleware(makeRequest("/downloads/membral-extension.zip"));
      expect(locationOf(res)).toBeNull();
    });
  });

  describe("auth landing (#336)", () => {
    it("an authenticated visitor to /signup goes to /pulse", async () => {
      mockUser = { id: "user-1" };
      const res = await middleware(makeRequest("/signup"));
      expect(locationOf(res)).toBe("http://localhost:3000/pulse");
    });

    it("a provider error landing on the site root goes to /login with a KEY, never /pulse", async () => {
      mockUser = null;
      const res = await middleware(makeRequest("/?error=access_denied&error_code=signup_disabled&error_description=x"));
      expect(locationOf(res)).toBe("http://localhost:3000/login?error=signups_closed");
    });

    it("signed-in visitor: two hops keep the message (root -> /login?error -> renders, no bounce)", async () => {
      mockUser = { id: "user-1" };
      const hop1 = await middleware(makeRequest("/?error=invalid_request&error_code=bad_oauth_state"));
      const target = locationOf(hop1) as string;
      expect(target).toBe("http://localhost:3000/login?error=oauth_expired");
      const hop2 = await middleware(makeRequest(target.replace("http://localhost:3000", "")));
      expect(locationOf(hop2)).toBeNull();
    });

    it("/signup?error=x is not redirected for a signed-in visitor", async () => {
      mockUser = { id: "user-1" };
      const res = await middleware(makeRequest("/signup?error=x"));
      expect(locationOf(res)).toBeNull();
    });

    it("otp_expired + access_denied maps to the expired link key", async () => {
      mockUser = null;
      const res = await middleware(makeRequest("/?error=access_denied&error_code=otp_expired"));
      expect(locationOf(res)).toBe("http://localhost:3000/login?error=otp_expired");
    });

    it("access_denied on the root maps to cancelled", async () => {
      mockUser = null;
      const res = await middleware(makeRequest("/?error=access_denied&error_description=User+denied"));
      expect(locationOf(res)).toBe("http://localhost:3000/login?error=cancelled");
    });
  });

  describe("unchanged protected-route behavior", () => {
    it("an unauthenticated visitor to a protected route is still sent to /login with ?next=", async () => {
      mockUser = null;
      const res = await middleware(makeRequest("/conversations"));
      expect(locationOf(res)).toBe("http://localhost:3000/login?next=%2Fconversations");
    });

    it("an authenticated visitor to /login is bounced to /pulse, the same landing as a fresh sign-in", async () => {
      mockUser = { id: "user-1" };
      const res = await middleware(makeRequest("/login"));
      expect(locationOf(res)).toBe("http://localhost:3000/pulse");
    });

    it("/privacy stays public for a logged-out visitor", async () => {
      mockUser = null;
      const res = await middleware(makeRequest("/privacy"));
      expect(locationOf(res)).toBeNull();
    });
  });
});
