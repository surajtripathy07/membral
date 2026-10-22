// UX audit B0 (docs section 3.1): one page-width primitive replacing the
// five ad-hoc content widths (880px, max-w-3xl, max-w-5xl, max-w-6xl, centred
// narrow) so the left edge stops jumping between routes. `read` is for
// single-column reading pages (Today, Memory, Settings, Search, session and
// chat detail); `data` is for table/grid pages (Sessions, Usage, Issues,
// project).
//
// UX W5: PageFrame owns the page padding (audit 3.1: px-4 lg:px-6 pt-8
// pb-16); the dashboard layout's <main> adds none, so every page has one
// rhythm and none is padded twice. Every (dashboard) page renders inside it.
import type { ReactNode } from "react";

export interface PageFrameProps {
  width: "read" | "data";
  children: ReactNode;
  className?: string;
}

export function PageFrame({ width, children, className = "" }: PageFrameProps) {
  const maxWidth = width === "data" ? "max-w-6xl" : "max-w-3xl";
  return <div className={`mx-auto w-full ${maxWidth} px-4 pt-8 pb-16 lg:px-6 ${className}`}>{children}</div>;
}
