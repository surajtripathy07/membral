// The landing's only /signup link is local-only: hosted sign-up is closed (D-081).
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Chats, Closing, LandingFooter, LandingNav } from "./sections";

afterEach(() => vi.unstubAllEnvs());

describe("landing sign-up link", () => {
  it("is absent on the hosted deployment", () => {
    vi.stubEnv("MEMBRAL_LOCAL", "");
    vi.stubEnv("VERCEL", "1");
    expect(renderToStaticMarkup(Closing())).not.toContain("/signup");
  });

  it("is absent on Vercel even with MEMBRAL_LOCAL=1", () => {
    vi.stubEnv("MEMBRAL_LOCAL", "1");
    vi.stubEnv("VERCEL", "1");
    expect(renderToStaticMarkup(Closing())).not.toContain("/signup");
  });

  it("is present on a local run", () => {
    vi.stubEnv("MEMBRAL_LOCAL", "1");
    vi.stubEnv("VERCEL", "");
    expect(renderToStaticMarkup(Closing())).toContain('href="/signup"');
  });
});

describe("landing sign-in link", () => {
  const all = () =>
    [LandingNav(), Closing(), LandingFooter({ tagline: "t" })].map((e) => renderToStaticMarkup(e)).join("");

  it("is absent on hosted", () => {
    for (const local of ["", "1"]) {
      vi.stubEnv("MEMBRAL_LOCAL", local);
      vi.stubEnv("VERCEL", "1");
      const html = all();
      expect(html).not.toContain('href="/login"');
      expect(html).not.toContain('href="/signup"');
    }
  });

  it("is absent with neither flag set", () => {
    vi.stubEnv("MEMBRAL_LOCAL", "");
    vi.stubEnv("VERCEL", "");
    expect(all()).not.toContain('href="/login"');
  });

  it("is present on a local run", () => {
    vi.stubEnv("MEMBRAL_LOCAL", "1");
    vi.stubEnv("VERCEL", "");
    const html = all();
    expect(html).toContain('href="/login"');
    expect(html).toContain('href="/signup"');
  });
});

describe("landing chats section", () => {
  it("renders its heading", () => {
    expect(renderToStaticMarkup(Chats())).toContain("Your chats too");
  });
});
