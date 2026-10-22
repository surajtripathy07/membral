// UX audit B0 (docs section 3.2): one section rhythm for every dashboard
// page — a `text-label` heading, an optional count, an optional right-side
// action link, `mt-7` (48px) above the section and `mt-3` between the label
// and its content.
import Link from "next/link";
import type { ReactNode } from "react";

export interface SectionAction {
  label: string;
  href: string;
}

export interface SectionProps {
  label: string;
  count?: number;
  action?: SectionAction;
  children: ReactNode;
  id?: string;
  className?: string;
}

export function Section({ label, count, action, children, id, className = "" }: SectionProps) {
  return (
    <section id={id} className={`mt-7 ${className}`}>
      <div className="flex items-baseline justify-between gap-3 border-b border-line pb-1.5">
        <h2 className="section-label">
          {label}
          {typeof count === "number" && <span className="ml-1.5 font-sans text-body-sm font-normal tabular-nums text-muted [font-variant-caps:normal]">{count}</span>}
        </h2>
        {action && (
          <Link href={action.href} className="text-body-sm text-accent hover:underline">
            {action.label}
          </Link>
        )}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  );
}
