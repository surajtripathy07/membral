import { redirect } from "next/navigation";
import { localInstallCommand } from "@/lib/install-command";
import { createClient } from "@/lib/supabase/server";
import { HEADLINE } from "./_landing/content";
import { Chats, Closing, Faq, Hero, HowItWorks, LandingFooter, LandingNav, Privacy, ProofTeaser } from "./_landing/sections";

// Signed-out landing. A developer who has never heard of Membral should get the
// point in one screen: what it is and who it is for (hero: the headline, one install button, how each recorded
// agent answered, and one line linking to the recorded runs), then one compact proof block (the outage result
// with its limit and count file, a link to /proof, and the one rules-file comparison); the full outage receipt and
// the recorded pair live on /proof (app/proof/page.tsx). Then how it works and what it is not, what is uploaded
// and where it lives, questions, and the start steps (which link back to the hero's install button instead of
// repeating it). Each thing is said once.
// No money, speed-up or percentage figures. Copy lives
// in _landing/content.ts with its sources; the layout lives in
// _landing/sections.tsx. The tagline below must stay verbatim (scripts/check-thesis.sh);
// it is the footer's small print, so no section repeats the headline.
const TAGLINE = "Your coding agent can answer from what your past sessions found, including what nobody wrote down.";

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
    <div className="min-h-screen bg-canvas text-ink">
      <LandingNav />
      <main>
        <Hero headline={HEADLINE} install={install} />
        <ProofTeaser />
        <HowItWorks />
        <Chats />
        <Privacy />
        <Faq />
        <Closing />
      </main>
      <LandingFooter tagline={TAGLINE} />
    </div>
  );
}
