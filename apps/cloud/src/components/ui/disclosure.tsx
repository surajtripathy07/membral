// UX audit B0 (docs section 3.6): the one way to hide depth (model tables,
// sub-agents, commits, the context card) — a styled native `<details>`, so it
// works with no JS and needs no client component.
import type { ReactNode } from "react";

export interface DisclosureProps {
  summary: string;
  count?: number;
  children: ReactNode;
  className?: string;
  defaultOpen?: boolean;
}

export function Disclosure({ summary, count, children, className = "", defaultOpen = false }: DisclosureProps) {
  return (
    <details open={defaultOpen} className={`group ${className}`}>
      <summary className="cursor-pointer list-none text-body-sm text-muted hover:text-accent">
        {summary}
        {typeof count === "number" && ` (${count})`}
      </summary>
      <div className="mt-2">{children}</div>
    </details>
  );
}
