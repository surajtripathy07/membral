"use client";

import { useState } from "react";

/** A command in a code block with a Copy button. */
export function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked: the command stays selectable in the block.
    }
  }

  return (
    <div className="flex items-start gap-2 rounded-card border border-line bg-sunken p-3">
      <pre className="min-w-0 flex-1 overflow-x-auto text-xs text-ink">
        <code>{command}</code>
      </pre>
      <button
        type="button"
        onClick={copy}
        className="shrink-0 rounded-xs border border-line px-2 py-1 text-xs text-muted hover:text-ink"
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
