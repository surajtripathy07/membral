import type { Metadata } from "next";
import { NAV } from "../_landing/content";
import { CompareFig, CompareHero, Limits, WhenFits } from "./compare-parts";
import { COMPARE_PAGE } from "./content";
import { PageShell } from "./page-shell";

// /compare: Membral against the common approaches, by category and with no product named. Copy is in ./content.ts
// (verbatim from docs/COMPARISON.md); markup in ./compare-parts.tsx. Public: listed in middleware.ts publicExactPaths.
export const metadata: Metadata = {
  title: COMPARE_PAGE.heading,
  description:
    "Membral compared with hand-kept notes, each agent's own transcript history and a hosted memory service, by category. When each fits, and the limits of Membral.",
};

export default function ComparePage() {
  return (
    <PageShell>
      <CompareHero />
      <CompareFig />
      <WhenFits />
      <Limits />
      <section className="sec closing-p" aria-label={COMPARE_PAGE.cta}>
        <div className="wrap">
          <a className="btn" href="/#start">
            {NAV.cta}
          </a>
        </div>
      </section>
    </PageShell>
  );
}
