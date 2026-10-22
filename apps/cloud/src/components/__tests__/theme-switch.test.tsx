import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ThemeSwitch, applyThemePref } from "../theme-switch";

function fakeDoc() {
  const attrs = new Map<string, string>();
  const doc = {
    cookie: "",
    documentElement: {
      setAttribute: (k: string, v: string) => attrs.set(k, v),
      removeAttribute: (k: string) => attrs.delete(k),
    },
  };
  return { doc: doc as unknown as Document, attrs };
}

describe("ThemeSwitch", () => {
  it("renders an accessible radiogroup with one checked, focusable option", () => {
    const html = renderToStaticMarkup(<ThemeSwitch initial="light" />);
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('aria-label="Theme"');
    expect(html.match(/role="radio"/g)).toHaveLength(3);
    expect(html).toMatch(/aria-checked="true" tabindex="0"[^>]*>Light</);
    expect(html).toMatch(/aria-checked="false" tabindex="-1"[^>]*>System</);
    expect(html).toMatch(/aria-checked="false" tabindex="-1"[^>]*>Dark</);
  });

  it("defaults to System", () => {
    expect(renderToStaticMarkup(<ThemeSwitch />)).toMatch(/aria-checked="true" tabindex="0"[^>]*>System</);
  });

  it("pins a theme: cookie + data-theme attribute", () => {
    const { doc, attrs } = fakeDoc();
    applyThemePref("dark", doc);
    expect(doc.cookie).toMatch(/^membral_theme=dark;/);
    expect(attrs.get("data-theme")).toBe("dark");
  });

  it("System clears the cookie and removes the attribute", () => {
    const { doc, attrs } = fakeDoc();
    applyThemePref("light", doc);
    applyThemePref("system", doc);
    expect(doc.cookie).toMatch(/^membral_theme=; path=\/; max-age=0/);
    expect(attrs.has("data-theme")).toBe(false);
  });
});
