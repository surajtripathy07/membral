"use client";

// System · Light · Dark — a radiogroup (roving tabindex, arrow keys) that
// writes the membral_theme cookie and the <html data-theme> attribute. The
// root layout reads the same cookie server-side, so the next load paints in
// the chosen theme from the first byte.
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { THEME_PREFS, type ThemePref, parseThemePref, stepThemePref, themeAttr, themeCookieString } from "@/lib/theme";

const LABELS: Record<ThemePref, string> = { system: "System", light: "Light", dark: "Dark" };

export function applyThemePref(pref: ThemePref, doc: Document = document): void {
  doc.cookie = themeCookieString(pref);
  const attr = themeAttr(pref);
  if (attr) doc.documentElement.setAttribute("data-theme", attr);
  else doc.documentElement.removeAttribute("data-theme");
}

export function ThemeSwitch({ initial = "system" }: { initial?: ThemePref }) {
  const [pref, setPref] = useState<ThemePref>(initial);
  const refs = useRef<Record<ThemePref, HTMLButtonElement | null>>({ system: null, light: null, dark: null });

  // The server already set data-theme from the cookie; mirror it into the control.
  useEffect(() => {
    setPref(parseThemePref(document.documentElement.getAttribute("data-theme")));
  }, []);

  function choose(next: ThemePref, focus = false) {
    setPref(next);
    applyThemePref(next);
    if (focus) refs.current[next]?.focus();
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      choose(stepThemePref(pref, 1), true);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      choose(stepThemePref(pref, -1), true);
    }
  }

  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      onKeyDown={onKeyDown}
      className="flex items-center gap-1 px-3 py-2 text-label text-muted"
      data-testid="theme-switch"
    >
      {THEME_PREFS.map((p, i) => (
        <span key={p} className="flex items-center gap-1">
          {i > 0 && (
            <span aria-hidden="true" className="text-faint">
              ·
            </span>
          )}
          <button
            ref={(el) => {
              refs.current[p] = el;
            }}
            type="button"
            role="radio"
            aria-checked={pref === p}
            tabIndex={pref === p ? 0 : -1}
            onClick={() => choose(p)}
            className={`rounded-xs px-0.5 underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${
              pref === p ? "text-ink underline decoration-accent" : "hover:text-ink-2"
            }`}
          >
            {LABELS[p]}
          </button>
        </span>
      ))}
    </div>
  );
}
