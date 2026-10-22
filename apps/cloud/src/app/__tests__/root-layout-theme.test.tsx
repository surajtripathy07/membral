// Root layout theme (review r2 S5): no server cookies() read (public pages stay
// static; force-static /setup honours a pinned theme) — a pre-paint <head>
// script copies the cookie onto <html data-theme>, allowlisted.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { themeBootScript } from "@/lib/theme";

vi.mock("next/headers", () => ({
  cookies: () => {
    throw new Error("the root layout must not read cookies()");
  },
}));
vi.mock("next/font/google", () => {
  const font = () => ({ variable: "font-var", className: "font-class" });
  return { IBM_Plex_Sans: font, IBM_Plex_Mono: font, Source_Serif_4: font };
});

function runBoot(cookie: string): string | null {
  let attr: string | null = null;
  const document = {
    cookie,
    documentElement: { setAttribute: (_: string, v: string) => (attr = v) },
  };
  new Function("document", themeBootScript())(document);
  return attr;
}

describe("root layout: theme cookie → <html data-theme> before paint", () => {
  it("renders without cookies(), with the boot script in <head> and no server data-theme", async () => {
    const { default: RootLayout } = await import("../layout");
    const html = renderToStaticMarkup(RootLayout({ children: <p>x</p> }));
    expect(html).toMatch(/<head><script>\(function\(\)\{try\{var m=document\.cookie/);
    expect(html).not.toMatch(/<html[^>]*data-theme/);
  });

  it("the boot script sets dark / light from the cookie; missing or unknown values leave system", () => {
    expect(runBoot("a=1; membral_theme=dark")).toBe("dark");
    expect(runBoot("membral_theme=light")).toBe("light");
    expect(runBoot("")).toBeNull();
    expect(runBoot("membral_theme=sepia")).toBeNull();
    expect(runBoot('membral_theme=dark"><img')).toBeNull();
    expect(runBoot("xmembral_theme=dark")).toBeNull();
  });
});
