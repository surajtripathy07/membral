import type { Metadata } from "next";
import { NAV, PROOF_PAGE } from "../_landing/content";
import { landingFontClass } from "../_landing/fonts";
import { Footer } from "../_landing/landing-parts";
import { ScrollFx } from "../_landing/scroll-fx";
import { LatencyProof, OutageProof, PageNav, PairProof, ProofHero } from "./proof-parts";

// The full proof, in the landing's own system: three numbered figures (P1 to P3), each with its method and its
// limits. P1 is the hand-recounted outage question, P2 the recorded pair (clips and stills), P3 the lookup-time
// measurement. Copy and sources live in _landing/content.ts; markup in ./proof-parts.tsx; styles in the `.landing`
// scope of globals.css (the `proofpg` modifier prints "Fig. P"). Public: listed in middleware.ts publicExactPaths.
export const metadata: Metadata = {
  title: "Recorded runs, with and without Membral",
  description:
    "Recorded Claude Code runs with and without Membral: an outage nobody wrote down, a written rule one agent overrode, and how long a lookup takes. Each with its method and its limits.",
};

// Adds `js` to <html> before first paint so the CSS may hide the scroll-reveal states; without JS nothing hides.
const JS_FLAG = "document.documentElement.classList.add('js')";

export default function ProofPage() {
  return (
    <div className={`landing proofpg ${landingFontClass}`}>
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: a fixed one-line script, no input */}
      <script dangerouslySetInnerHTML={{ __html: JS_FLAG }} />
      <a className="skip" href="#main">
        {NAV.skip}
      </a>
      <PageNav current="proof" />
      <main id="main">
        <ProofHero />
        <OutageProof />
        <PairProof />
        <LatencyProof />
        <section className="sec closing-p" aria-label={PROOF_PAGE.cta}>
          <div className="wrap">
            <a className="btn" href="/#start">
              {PROOF_PAGE.cta}
            </a>
          </div>
        </section>
      </main>
      <Footer />
      <ScrollFx />
    </div>
  );
}
