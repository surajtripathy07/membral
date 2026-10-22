"use client";

import { useState } from "react";

// The one primary action on the landing page: the install command, copyable.
// The button is 44 px tall (primary tap target) and announces the copy to screen readers.
// On a phone the command wraps inside its box instead of clipping; from sm up it stays on one line.
export function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be blocked (insecure origin, permissions); the text stays selectable.
    }
  }

  return (
    <div className="flex items-stretch rounded-sm border border-line-strong bg-sunken max-w-full">
      <code className="flex-1 min-w-0 [overflow-wrap:anywhere] sm:[overflow-wrap:normal] sm:overflow-x-auto sm:whitespace-nowrap self-center px-4 py-3 font-mono font-normal tracking-[0.01em] text-body-sm text-ink-2">
        {command}
      </code>
      <button
        type="button"
        onClick={copy}
        aria-label="Copy the install command"
        className="shrink-0 min-h-11 min-w-20 border-l border-line-strong px-4 text-body-sm font-medium text-ink hover:bg-ink hover:text-canvas transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus"
      >
        <span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
      </button>
    </div>
  );
}
