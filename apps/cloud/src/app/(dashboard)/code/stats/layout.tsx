// /code/stats — shared shell for the Overview / Issues tabs (goal 2026-07-26
// step 9; ADR 0032 §4). Auth is already enforced by the (dashboard) layout
// this route group sits under, so this layout only owns the page header +
// tab bar, matching the header structure already used on /code and
// /code/[projectId].
//
// W9 (2026-09-12 refocus goal, D9): "Agent stats" -> "Usage" (matches the
// sidebar's new nav label; "agent stats" was never a phrase in
// PRODUCT.md), the "$" glyph dropped from the title (the brand mark carries
// that identity now — see docs/design/... brief), harness-neutral subtitle.
// Next.js layouts don't receive `searchParams`, so the exact selected
// window (7/30/90, ?days=) is stated on the Overview tab itself rather than
// here.
import { PageFrame } from "@/components/ui/page-frame";
import type { ReactNode } from "react";
import { StatsTabs } from "./stats-tabs";

export default function CodeStatsLayout({ children }: { children: ReactNode }) {
  return (
    <PageFrame width="data" className="space-y-6">
      <div>
        <h1 className="text-h1 font-semibold text-ink">Usage</h1>
        <p className="mt-1 text-body text-muted">Token usage and cost across your coding sessions.</p>
      </div>
      <StatsTabs />
      {children}
    </PageFrame>
  );
}
