"use client";

import { useRef, useState } from "react";
import { HERO, README_INSTALL_URL } from "./content";

// The page's one copy button. Clipboard first, then a hidden textarea for non-secure contexts. The status line
// is aria-live so the copy is announced.
export function InstallBlock({ command }: { command: string }) {
  const [state, setState] = useState<"idle" | "done" | "fail">("idle");
  const timer = useRef<number | undefined>(undefined);

  const flash = (s: "done" | "fail") => {
    setState(s);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState("idle"), 2000);
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      flash("done");
      return;
    } catch {
      // fall through to the textarea route
    }
    try {
      const ta = document.createElement("textarea");
      ta.value = command;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      flash(ok ? "done" : "fail");
    } catch {
      flash("fail");
    }
  };

  return (
    <div className="setup" id="install">
      <div className="head">
        <span className="lbl">Install</span>
        <button type="button" className="btn" data-state={state === "done" ? "done" : undefined} onClick={copy} aria-label="Copy the install command">
          {state === "done" ? "Copied" : state === "fail" ? "Select and copy" : "Copy"}
        </button>
      </div>
      <pre>
        <span className="p">$ </span>
        <code>{command}</code>
      </pre>
      <p className="note">
        {HERO.needs} <a href={README_INSTALL_URL}>{HERO.readLink}</a>
      </p>
      <span className="sr" role="status" aria-live="polite">
        {state === "done" ? "Install command copied." : state === "fail" ? "Copy failed. Select the command and copy it." : ""}
      </span>
    </div>
  );
}
