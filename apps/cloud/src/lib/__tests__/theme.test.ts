import { describe, expect, it } from "vitest";
import { parseThemePref, stepThemePref, THEME_COOKIE, themeAttr, themeCookieString } from "../theme";

describe("theme preference", () => {
  it("parses only light/dark; anything else is system", () => {
    expect(parseThemePref("light")).toBe("light");
    expect(parseThemePref("dark")).toBe("dark");
    expect(parseThemePref("system")).toBe("system");
    expect(parseThemePref(undefined)).toBe("system");
    expect(parseThemePref("")).toBe("system");
    expect(parseThemePref("DARK")).toBe("system");
    expect(parseThemePref("<script>")).toBe("system");
  });

  it("maps system to no attribute and pinned themes to themselves", () => {
    expect(themeAttr("system")).toBeUndefined();
    expect(themeAttr("light")).toBe("light");
    expect(themeAttr("dark")).toBe("dark");
  });

  it("writes a year-long cookie for a pinned theme and deletes it for system", () => {
    expect(themeCookieString("dark")).toBe(`${THEME_COOKIE}=dark; path=/; max-age=31536000; samesite=lax`);
    expect(themeCookieString("system")).toBe(`${THEME_COOKIE}=; path=/; max-age=0; samesite=lax`);
  });

  it("steps through System · Light · Dark and wraps", () => {
    expect(stepThemePref("system", 1)).toBe("light");
    expect(stepThemePref("dark", 1)).toBe("system");
    expect(stepThemePref("system", -1)).toBe("dark");
  });
});
