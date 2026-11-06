import { redirect } from "next/navigation";
import { localInstallCommand } from "@/lib/install-command";
import { createClient } from "@/lib/supabase/server";
import { HEADLINE, NAV } from "./_landing/content";
import { landingFontClass } from "./_landing/fonts";
import { InstallBlock } from "./_landing/install-block";
import {
  Chats,
  Closing,
  Faq,
  Footer,
  Handoff,
  HeroCopy,
  Nav,
  OutageFig,
  RecordFig,
  Start,
  StoreFig,
  Teams,
} from "./_landing/landing-parts";
import { Replay } from "./_landing/replay";
import { ScrollFx } from "./_landing/scroll-fx";

// Signed-out landing, "the logbook that outlives the tool": a field-manual page of numbered figures.
// Fig. 1 replays a recorded Claude Code session (replay.tsx), Fig. 2 is the hand-recounted outage result, Fig. 3
// the one-store schematic with its measured row, Fig. 4 one real record, Fig. 5 the handoff note, Fig. 6 chats. Then the
// start steps (mirroring README "Run it locally"), questions, teams, and the closing tagline.
// No money, speed-up or percentage figures in the copy. Every string lives in _landing/content.ts (a draft
// awaiting the owner's approval); the markup is in _landing/landing-parts.tsx. The landing is light-only and
// scoped under .landing in globals.css; it adds no token to :root. The tagline below must stay verbatim
// (scripts/check-thesis.sh); it is the closing band, so no section repeats the headline.
const TAGLINE = "Your coding agent can answer from what your past sessions found, including what nobody wrote down.";

// Adds `js` to <html> before first paint so the CSS may hide the scroll-reveal states; without JS nothing hides.
const JS_FLAG = "document.documentElement.classList.add('js')";

export default async function Home() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  // Defense-in-depth only — middleware (src/middleware.ts) already redirects
  // a logged-in visitor of "/" to /pulse before this component ever renders
  // (issue #127). Kept in case this page is ever reached by a path outside
  // the middleware's matcher.
  if (user) {
    redirect("/pulse");
  }

  const install = localInstallCommand();

  return (
    <div className={`landing ${landingFontClass}`}>
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: a fixed one-line script, no input */}
      <script dangerouslySetInnerHTML={{ __html: JS_FLAG }} />
      <a className="skip" href="#main">
        {NAV.skip}
      </a>
      <Nav />
      <main id="main">
        <div className="wrap">
          <div className="hero">
            <HeroCopy headline={HEADLINE} />
            {/* before the plate in source order so the install command is in the first screen on a phone; the
                two-column grid at 1024px places each by area, so the desktop layout does not follow this order */}
            <InstallBlock command={install} />
            <Replay />
          </div>
        </div>
        <OutageFig />
        <StoreFig />
        <RecordFig />
        <Handoff />
        <Chats />
        <Start />
        <Faq />
        <Teams />
        <Closing tagline={TAGLINE} />
      </main>
      <Footer />
      <ScrollFx />
    </div>
  );
}
