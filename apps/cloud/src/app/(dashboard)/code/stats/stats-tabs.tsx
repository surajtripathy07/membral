"use client";

// Small tab bar shared by /code/stats (Overview) and /code/stats/issues
// (goal 2026-07-26 step 9 slice two; ADR 0032 §4's "Issue attribution ...
// tab within /code/stats"). Client-only because active-tab detection needs
// usePathname/useSearchParams — the pages themselves stay server components.
//
// W9 (2026-09-12 refocus goal, D9): preserves the ?days= window (7/30/90,
// see days-control.tsx) across a tab switch instead of dropping back to the
// default.
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

const TABS = [
  { href: "/code/stats", label: "Overview" },
  { href: "/code/stats/issues", label: "Issues" },
] as const;

export function StatsTabs() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const days = searchParams.get("days");
  const suffix = days ? `?days=${days}` : "";

  return (
    <div className="flex items-center gap-1 border-line border-b pb-0">
      {TABS.map((tab) => {
        const active = tab.href === "/code/stats" ? pathname === tab.href : pathname.startsWith(tab.href);
        return (
          <Link
            key={tab.href}
            href={`${tab.href}${suffix}`}
            aria-current={active ? "page" : undefined}
            className={`-mb-px border-b-2 px-3 py-2 text-body-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-canvas ${
              active ? "border-accent text-ink" : "border-transparent text-muted hover:border-line-strong hover:text-ink-2"
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
}
