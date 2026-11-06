import type { ReactNode } from "react";
import { NAV } from "../_landing/content";
import { landingFontClass } from "../_landing/fonts";
import { Footer } from "../_landing/landing-parts";
import { ScrollFx } from "../_landing/scroll-fx";
import { PageNav } from "../proof/proof-parts";

// Wrapper shared by /compare and the three harness pages: the same shell /proof uses (the `.landing` scope, the
// `js` flag set before first paint, skip link, bar, footer, nav scroll effect).
const JS_FLAG = "document.documentElement.classList.add('js')";

export function PageShell({ children }: { children: ReactNode }) {
  return (
    <div className={`landing ${landingFontClass}`}>
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: a fixed one-line script, no input */}
      <script dangerouslySetInnerHTML={{ __html: JS_FLAG }} />
      <a className="skip" href="#main">
        {NAV.skip}
      </a>
      <PageNav />
      <main id="main">{children}</main>
      <Footer />
      <ScrollFx />
    </div>
  );
}
