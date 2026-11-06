// The landing's only /signup and /login links are local-only: hosted sign-up is closed (D-081).
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Chats, Footer, Handoff, Nav, Start } from "./landing-parts";
import { LandingFooter, LandingNav } from "./sections";

afterEach(() => vi.unstubAllEnvs());

const landing = () => [Nav(), Start(), Footer()].map((e) => renderToStaticMarkup(e)).join("");
const shared = () => [LandingNav(), LandingFooter()].map((e) => renderToStaticMarkup(e)).join("");

describe("landing sign-up link", () => {
  it("is absent on the hosted deployment", () => {
    vi.stubEnv("MEMBRAL_LOCAL", "");
    vi.stubEnv("VERCEL", "1");
    expect(landing()).not.toContain("/signup");
  });

  it("is absent on Vercel even with MEMBRAL_LOCAL=1", () => {
    vi.stubEnv("MEMBRAL_LOCAL", "1");
    vi.stubEnv("VERCEL", "1");
    expect(landing()).not.toContain("/signup");
  });

  it("is present on a local run", () => {
    vi.stubEnv("MEMBRAL_LOCAL", "1");
    vi.stubEnv("VERCEL", "");
    expect(landing()).toContain('href="/signup"');
  });
});

describe("landing sign-in link", () => {
  it("is absent on hosted", () => {
    for (const local of ["", "1"]) {
      vi.stubEnv("MEMBRAL_LOCAL", local);
      vi.stubEnv("VERCEL", "1");
      expect(landing()).not.toContain('href="/login"');
      expect(shared()).not.toContain('href="/login"');
    }
  });

  it("is absent with neither flag set", () => {
    vi.stubEnv("MEMBRAL_LOCAL", "");
    vi.stubEnv("VERCEL", "");
    expect(landing()).not.toContain('href="/login"');
  });

  it("is present on a local run", () => {
    vi.stubEnv("MEMBRAL_LOCAL", "1");
    vi.stubEnv("VERCEL", "");
    expect(landing()).toContain('href="/login"');
    expect(shared()).toContain('href="/login"');
  });
});

describe("landing chats section", () => {
  it("renders its heading", () => {
    expect(renderToStaticMarkup(Chats())).toContain("Your chats too");
  });
});

describe("figure labels", () => {
  it("labels the handoff and chats sections as figures and lays the handoff note out as a table", () => {
    const handoff = renderToStaticMarkup(Handoff());
    expect(handoff).toContain('class="figno"');
    expect(handoff).toContain('<dl class="dl side">');
    expect(renderToStaticMarkup(Chats())).toContain('class="figno"');
  });
});
