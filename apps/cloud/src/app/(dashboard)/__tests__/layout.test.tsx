// L6 (adversarial review): the unauthenticated redirect in (dashboard)/layout.tsx
// used to always drop to a bare "/login", losing the destination for a
// client-side navigation into a (dashboard) route whose session has since
// expired (middleware's OWN redirect already carries ?next=... for a normal
// full-page load — see src/middleware.ts — this layout is the fallback path
// that never went through middleware's logic again).
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/font/google", () => {
  const font = () => ({ style: { fontFamily: "font-family" } });
  return { IBM_Plex_Sans: font, Source_Serif_4: font };
});

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));

const mockGetUser = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(() => Promise.resolve({ auth: { getUser: mockGetUser } })),
}));

const mockHeadersGet = vi.fn();
vi.mock("next/headers", () => ({
  headers: vi.fn(() => Promise.resolve({ get: mockHeadersGet })),
}));

vi.mock("@/lib/code-sessions/queries", () => ({
  getCodeSessionCount: vi.fn(async () => 0),
}));
vi.mock("@/lib/code-sessions/view", () => ({
  hasCodeSessions: vi.fn(() => false),
}));
vi.mock("../sidebar", () => ({
  Sidebar: () => null,
}));

// round-3 review HIGH 24: this test file never mocked @/lib/feature-flags,
// so the REAL checkFeature ran (with no SUPABASE_SERVICE_ROLE_KEY/
// NEXT_PUBLIC_SUPABASE_URL configured in this test env), always failing
// closed — every test pinned `llmCheck.allowed` to false and nobody
// asserted on FeatureDisabledNotice at all, so the #128 UI in this layout
// had zero real coverage. Default to allowed:true so the pre-existing
// tests above (predating the gate) keep exercising the "signed in, no
// notice" path unchanged; the dedicated describe block below asserts both
// branches explicitly.
const mockCheckFeature = vi.fn<(...args: unknown[]) => Promise<import("@/lib/feature-flags").CheckFeatureResult>>(
  () =>
    Promise.resolve({
      allowed: true,
      reason: "ok" as const,
      spentUsd: 0,
      budgetUsd: null,
      dailyUsd: null,
      contact: "support@membral.me",
    }),
);
vi.mock("@/lib/feature-flags", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/feature-flags")>();
  return { ...actual, checkFeature: (...args: unknown[]) => mockCheckFeature(...args) };
});

import { FeatureDisabledNotice } from "@/components/feature-disabled-notice";
import DashboardLayout from "../layout";

/** Walks a React element tree looking for a node of the given component type — used instead of a DOM render since this layout is an async Server Component. */
// #173: the notice now streams from an async child inside <Suspense>, so the
// walk renders function components (async ones included) to reach it.
async function treeContainsType(node: unknown, type: unknown): Promise<boolean> {
  if (node == null || typeof node !== "object") return false;
  if (Array.isArray(node)) {
    for (const n of node) if (await treeContainsType(n, type)) return true;
    return false;
  }
  const el = node as { type?: unknown; props?: { children?: unknown } };
  if (el.type === type) return true;
  // Only async server components: client ones (TimezoneSync) use hooks and can't be called bare.
  if (typeof el.type === "function" && el.type.constructor.name === "AsyncFunction") return treeContainsType(await (el.type as (p: unknown) => unknown)(el.props), type);
  if (el.props && "children" in el.props) return treeContainsType(el.props.children, type);
  return false;
}

describe("DashboardLayout — unauthenticated redirect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckFeature.mockResolvedValue({
      allowed: true,
      reason: "ok" as const,
      spentUsd: 0,
      budgetUsd: null,
      dailyUsd: null,
      contact: "support@membral.me",
    });
  });

  it("L6: carries the destination from the next-url header as ?next= on /login", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });
    mockHeadersGet.mockReturnValue("/portrait");

    await expect(DashboardLayout({ children: null })).rejects.toThrow("REDIRECT:/login?next=%2Fportrait");
  });

  it("falls back to a bare /login when there's no next-url header (e.g. a hard reload)", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });
    mockHeadersGet.mockReturnValue(null);

    await expect(DashboardLayout({ children: null })).rejects.toThrow("REDIRECT:/login");
  });

  it("M11-style guard: a protocol-relative next-url header is never honored", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });
    mockHeadersGet.mockReturnValue("//evil.example.com");

    const err = await DashboardLayout({ children: null }).catch((e: Error) => e);
    expect((err as Error).message).toBe("REDIRECT:/login");
  });

  it("never redirects when a user is present", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "user-1", email: "a@b.com" } } });

    await expect(DashboardLayout({ children: null })).resolves.toBeTruthy();
  });

  describe("round-3 review HIGH 24 — the #128 FeatureDisabledNotice gate has real coverage", () => {
    it("renders no notice when checkFeature reports allowed:true", async () => {
      mockGetUser.mockResolvedValue({ data: { user: { id: "user-1", email: "a@b.com" } } });
      mockCheckFeature.mockResolvedValue({
        allowed: true,
        reason: "ok" as const,
        spentUsd: 0,
        budgetUsd: null,
        dailyUsd: null,
        contact: "support@membral.me",
      });

      const result = await DashboardLayout({ children: null });
      expect(await treeContainsType(result, FeatureDisabledNotice)).toBe(false);
    });

    it("renders FeatureDisabledNotice when checkFeature reports allowed:false", async () => {
      mockGetUser.mockResolvedValue({ data: { user: { id: "user-1", email: "a@b.com" } } });
      mockCheckFeature.mockResolvedValue({
        allowed: false,
        reason: "disabled" as const,
        spentUsd: 0,
        budgetUsd: null,
        dailyUsd: null,
        contact: "support@membral.me",
      });

      const result = await DashboardLayout({ children: null });
      expect(await treeContainsType(result, FeatureDisabledNotice)).toBe(true);
      expect(mockCheckFeature).toHaveBeenCalledWith("user-1", "llm");
    });

    it("issue #335: a used-up lifetime llm budget says the allowance is used up, never 'not enabled'", () => {
      const notice = FeatureDisabledNotice({
        check: {
          allowed: false,
          reason: "budget_exhausted" as const,
          spentUsd: 2,
          budgetUsd: 2,
          dailyUsd: null,
          contact: "support@membral.me",
        },
      });
      const text = JSON.stringify(notice);
      expect(text).toContain("allowance is used up");
      expect(text).toContain("extend it");
      expect(text).not.toContain("not enabled");
    });
  });
});
