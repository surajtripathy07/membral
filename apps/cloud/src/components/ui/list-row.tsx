// UX audit B0 (docs section 3.4): replaces card-per-item chrome for any list
// longer than about 5 items — a divider, not a bordered box. Keep
// `bg-surface border-line rounded-card` cards for 1–4 summary panels only.
import Link from "next/link";
import type { ReactNode } from "react";

export interface ListRowProps {
  children: ReactNode;
  /** Renders the row as a Link when set, a plain div otherwise. */
  href?: string;
  className?: string;
}

export function ListRow({ children, href, className = "" }: ListRowProps) {
  const classes = `flex items-center justify-between gap-3 border-b border-line-soft py-2.5 last:border-b-0 ${className}`;
  if (href) {
    return (
      <Link href={href} className={`${classes} group`}>
        {children}
      </Link>
    );
  }
  return <div className={classes}>{children}</div>;
}
