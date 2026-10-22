import type { Metadata } from "next";
import { ComparePair, LandingFooter, LandingNav, Outage } from "../_landing/sections";

// The full proof, moved off the landing page (which keeps one compact proof block linking here): the outage
// question as quoted from one test run per side with its limits, and the recorded pair (clips, frames, captions,
// the rule, where it did not help, links to the results files). Copy and sources live in _landing/content.ts;
// the layout is the landing's own (_landing/sections.tsx). Public: listed in middleware.ts publicExactPaths.
export const metadata: Metadata = {
  title: "Recorded runs — Membral",
  description:
    "Recorded Claude Code runs with and without Membral: an outage nobody wrote down, and a written rule one agent overrode. Each with its limits and results files.",
};

export default function ProofPage() {
  return (
    <div className="min-h-screen bg-canvas text-ink">
      <LandingNav />
      <main>
        <section aria-labelledby="proof-h1" className="pt-10 pb-8 sm:pt-14">
          <div className="mx-auto max-w-5xl px-4 sm:px-6">
            <p className="section-label">Proof</p>
            <h1 id="proof-h1" className="mt-2 text-h1 tracking-tight text-ink">
              Recorded runs, with and without Membral
            </h1>
          </div>
        </section>
        <Outage />
        <ComparePair />
      </main>
      <LandingFooter />
    </div>
  );
}
