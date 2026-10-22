// #336: the error banner resolves a KEY from the URL through a fixed table;
// arbitrary ?error= text must never be rendered.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../actions", () => ({ login: vi.fn(), signup: vi.fn(), signInWithGoogle: vi.fn(), resendConfirmation: vi.fn() }));

let mockUser: { id: string } | null = null;
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: mockUser } }) } }),
}));

import CheckEmailPage from "../../signup/check-email/page";
import SignupPage from "../../signup/page";
import LoginPage from "../page";

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
    const el = node as { props?: { children?: unknown } };
    if (el.props && "children" in el.props) collectText(el.props.children, out);
  }
  return out;
}

const text = (r: unknown) => collectText(r).join(" | ");

function hasLinkTo(node: unknown, href: string): boolean {
  if (node == null || typeof node !== "object") return false;
  if (Array.isArray(node)) return node.some((n) => hasLinkTo(n, href));
  const el = node as { props?: { href?: unknown; children?: unknown } };
  if (typeof el.props?.href === "string" && el.props.href.startsWith(href)) return true;
  return el.props ? hasLinkTo(el.props.children, href) : false;
}

function hasElementType(node: unknown, name: string): boolean {
  if (node == null || typeof node !== "object") return false;
  if (Array.isArray(node)) return node.some((n) => hasElementType(n, name));
  const el = node as { type?: unknown; props?: { children?: unknown } };
  const t = typeof el.type === "function" ? (el.type as { name: string }).name : el.type;
  return t === name || (el.props ? hasElementType(el.props.children, name) : false);
}

describe("auth pages: hosted (D-081)", () => {
  beforeEach(() => {
    vi.stubEnv("MEMBRAL_LOCAL", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("hosted /login still renders the sign-in form and Google, but has no /signup link", async () => {
    const page = await LoginPage({ searchParams: Promise.resolve({}) });
    expect(text(page)).toContain("Sign in to Membral");
    expect(hasLinkTo(page, "/signup")).toBe(false);
    expect(text(page)).not.toContain("Sign up");
  });

  it("hosted /signup shows the closed notice with a /login link, no form, no Google button", async () => {
    const page = await SignupPage({ searchParams: Promise.resolve({}) });
    expect(text(page)).toContain("Sign-ups are closed. Existing accounts:");
    expect(hasLinkTo(page, "/login")).toBe(true);
    expect(hasElementType(page, "GoogleButton")).toBe(false);
    expect(hasElementType(page, "form")).toBe(false);
  });

  it("local /login keeps the /signup link and local /signup keeps the form", async () => {
    vi.stubEnv("MEMBRAL_LOCAL", "1");
    expect(hasLinkTo(await LoginPage({ searchParams: Promise.resolve({}) }), "/signup")).toBe(true);
    const signupPage = await SignupPage({ searchParams: Promise.resolve({}) });
    expect(text(signupPage)).toContain("Create your account");
    expect(hasElementType(signupPage, "form")).toBe(true);
    expect(hasElementType(signupPage, "GoogleButton")).toBe(true);
  });
});

describe("auth pages: error keys", () => {
  beforeEach(() => {
    vi.stubEnv("MEMBRAL_LOCAL", "1");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("/login?error=<arbitrary text> shows the generic line, never the text", async () => {
    const evil = "Your account is locked, call 555-0100";
    const out = text(await LoginPage({ searchParams: Promise.resolve({ error: evil }) }));
    expect(out).not.toContain("locked");
    expect(out).toContain("Sign-in failed. Try again.");
  });

  it("/login?error=invalid_credentials shows the table copy", async () => {
    const out = text(await LoginPage({ searchParams: Promise.resolve({ error: "invalid_credentials" }) }));
    expect(out).toContain("Wrong email or password.");
  });

  it("/login?error=email_not_confirmed adds the resend link", async () => {
    const out = text(await LoginPage({ searchParams: Promise.resolve({ error: "email_not_confirmed" }) }));
    expect(out).toContain("Resend the confirmation link");
  });

  it("/signup?error=weak_password&min=8 states the rule; a junk min is ignored", async () => {
    const ok = text(await SignupPage({ searchParams: Promise.resolve({ error: "weak_password", min: "8" }) }));
    expect(ok).toContain("at least 8 characters");
    const bad = text(await SignupPage({ searchParams: Promise.resolve({ error: "weak_password", min: "<b>" }) }));
    expect(bad).toContain("Choose a stronger password.");
    expect(bad).not.toContain("<b>");
  });

  it("/signup?error=<unknown> falls back to the sign-up line", async () => {
    const out = text(await SignupPage({ searchParams: Promise.resolve({ error: "free money at evil.example" }) }));
    expect(out).not.toContain("evil.example");
    expect(out).toContain("We couldn't create your account. Try again.");
  });

  it("/signup/check-email?error=<unknown> falls back to the resend line", async () => {
    const out = text(await CheckEmailPage({ searchParams: Promise.resolve({ error: "nope" }) }));
    expect(out).toContain("We couldn't resend the confirmation link. Try again in a moment.");
  });

  it("signed-in visitor on /login?error shows a dashboard link; signed-out does not", async () => {
    mockUser = { id: "u1" };
    const withSession = text(await LoginPage({ searchParams: Promise.resolve({ error: "oauth_expired" }) }));
    expect(withSession).toContain("Continue to your dashboard");
    mockUser = null;
    const without = text(await LoginPage({ searchParams: Promise.resolve({ error: "oauth_expired" }) }));
    expect(without).not.toContain("Continue to your dashboard");
  });
});
