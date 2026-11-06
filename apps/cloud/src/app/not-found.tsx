import { NAV, NOT_FOUND } from "./_landing/content";
import { landingFontClass } from "./_landing/fonts";
import { Footer } from "./_landing/landing-parts";
import { PageNav } from "./proof/proof-parts";

// The 404, in the landing's system: a figure with no number, because nothing was recorded here. The label is the one
// place the unnumbered "Fig. 0" appears (copy in _landing/content.ts NOT_FOUND).
export default function NotFound() {
  return (
    <div className={`landing ${landingFontClass}`}>
      <a className="skip" href="#main">
        {NAV.skip}
      </a>
      <PageNav />
      <main id="main" className="nf">
        <div className="wrap">
          <div className="fig">
            <span className="lbl">[ {NOT_FOUND.label} ]</span>
            <h1 className="sr">{NOT_FOUND.line}</h1>
            <p aria-hidden="true">{NOT_FOUND.line}</p>
            <a className="btn" href="/">
              {NOT_FOUND.link}
            </a>
          </div>
        </div>
      </main>
      <Footer />
    </div>
  );
}
