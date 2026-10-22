// Theme preference (docs/design/tokens.md, "Both themes"). "system" follows
// prefers-color-scheme; "light"/"dark" pin the page via <html data-theme>,
// which globals.css reads. The preference lives in a cookie; a tiny inline
// <head> script (themeBootScript) copies it onto <html data-theme> before first
// paint — no flash, and no server cookies() read, so public pages stay static
// and a force-static page (/setup) still honours a pinned theme.

export const THEME_COOKIE = "membral_theme";
export const THEME_PREFS = ["system", "light", "dark"] as const;
export type ThemePref = (typeof THEME_PREFS)[number];

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

/** Any cookie value to a known preference; unknown or missing means "system". */
export function parseThemePref(value: string | undefined | null): ThemePref {
  return value === "light" || value === "dark" ? value : "system";
}

/** The <html data-theme> value for a preference; "system" sets no attribute. */
export function themeAttr(pref: ThemePref): "light" | "dark" | undefined {
  return pref === "system" ? undefined : pref;
}

/** The document.cookie assignment that stores a preference ("system" deletes the cookie). */
export function themeCookieString(pref: ThemePref): string {
  if (pref === "system") return `${THEME_COOKIE}=; path=/; max-age=0; samesite=lax`;
  return `${THEME_COOKIE}=${pref}; path=/; max-age=${ONE_YEAR_SECONDS}; samesite=lax`;
}

/** Radiogroup arrow-key movement: wraps at both ends. */
export function stepThemePref(current: ThemePref, delta: 1 | -1): ThemePref {
  const i = THEME_PREFS.indexOf(current);
  return THEME_PREFS[(i + delta + THEME_PREFS.length) % THEME_PREFS.length];
}

/**
 * The pre-paint <head> script: reads the theme cookie and sets <html
 * data-theme> — only the two allowlisted literals ever reach the attribute
 * (same rule as parseThemePref). Pure string; the cookie name is a constant.
 */
export function themeBootScript(): string {
  return `(function(){try{var m=document.cookie.match(/(?:^|; )${THEME_COOKIE}=([^;]*)/),v=m&&m[1];if(v==="light"||v==="dark")document.documentElement.setAttribute("data-theme",v)}catch(_){}})();`;
}
