import { BrandLockup } from "@/components/brand-mark";
import { isLocalRuntime } from "@/lib/env";
import { CopyCommand } from "./copy-command";
import { DeferredVideo } from "./deferred-video";
import {
  CHATS,
  FAQ,
  HERO_ALTERNATIVE,
  HERO_EXCHANGE,
  HERO_FOR,
  HOW_IT_WORKS,
  LOCAL_IMAGE_NOTE,
  NOT_THIS,
  OUTAGE,
  PAIR,
  PAIR_LEDE,
  PAIR_NOTE,
  PAIR_PROMPT,
  PAIR_QUOTE,
  PAIR_TITLE,
  PRIVACY,
  PROOF_TEASER,
  README_INSTALL_URL,
  REPO_URL,
  PROOF_LABEL,
  PROOF_URL,
  RULE,
  type Run,
  SELF_HOSTING_URL,
  START,
  TEST_LIMITS,
} from "./content";

// Signed-out landing, in small sections so each can be restyled on its own.
// Paper & ink only (docs/design/tokens.md): tokens, hairlines, no gradients,
// no blur, no translucent fills. Serif is for headings (base layer), mono only
// for commands and paths. Every sentence comes from content.ts, which names its source.

export const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-canvas";

const wrap = "mx-auto max-w-5xl px-4 sm:px-6";

// Text links: at least 44 px tall so they are easy to hit on a phone.
const textLink = `inline-flex items-center min-h-11 text-accent underline underline-offset-2 hover:decoration-2 rounded-xs ${focusRing}`;
// A link inside running text: stays inline at the paragraph's size, 26 px hit area (24 px minimum, WCAG 2.5.8)
// through py-0.5; never inline-flex, which would make it a 44 px box in the middle of a sentence.
const inlineLink = `inline-block py-0.5 text-accent underline underline-offset-2 hover:decoration-2 rounded-xs ${focusRing}`;
// A link on its own line under a list or table: 44 px tall, and it may wrap (long file paths).
const blockLink = `inline-flex items-center min-h-11 text-accent underline underline-offset-2 hover:decoration-2 rounded-xs ${focusRing}`;
// At least 44 x 44: a short label ("Proof") would otherwise be under 44 px wide.
const navLink = `inline-flex items-center justify-center min-h-11 min-w-11 px-1 text-body-sm font-normal text-muted hover:text-ink-2 rounded-xs ${focusRing}`;
// Paths and file names shown as text, so a reader can find them without the link.
const pathText = "font-mono font-normal text-body-sm [overflow-wrap:anywhere]";

function SectionHeading({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <h2 id={id} className="text-h2 text-ink">
      {children}
    </h2>
  );
}

export function LandingNav() {
  return (
    <nav aria-label="Main" className="border-b border-line-soft bg-canvas">
      <div className={`${wrap} flex items-center justify-between py-2`}>
        {/* Inline lockup (theme tokens), not /logo.svg: that file is dark-only and vanished on paper. */}
        <a href="/" aria-label="Membral home" className={`inline-flex items-center min-h-11 rounded-xs ${focusRing}`}>
          <BrandLockup />
        </a>
        {/* Quieter than the hero's Copy button (ink, medium weight): muted, regular weight. */}
        <div className="flex items-center gap-3 sm:gap-5">
          <a href="/proof" className={navLink}>
            Proof
          </a>
          <a href={REPO_URL} className={navLink}>
            GitHub
          </a>
          {/* Hosted shows no sign-in; existing accounts reach /login by URL. Read at render (D-081). */}
          {isLocalRuntime() ? (
            <a href="/login" className={navLink}>
              Sign in
            </a>
          ) : null}
        </div>
      </div>
    </nav>
  );
}

// One choice: the install button, with one line under it that points to the recorded runs on /proof. Beside the
// headline (below the button on a phone) how each agent answered the recorded request, as text; from 1024 px that
// figure stretches to the height of the headline column so the first screen has no empty third. From 1024 px the
// section fills the first screen under the nav (61 px: py-2 + a 44 px link + the hairline) less 2rem, content
// centred: the proof block's hairline shows at the bottom of the first screen and its heading (after the block's
// 2.5rem top padding) starts just below it, so the hero stays the only text there.
export function Hero({ headline, install }: { headline: string; install: string }) {
  return (
    <section
      aria-labelledby="hero-h"
      className="pt-10 pb-10 sm:pt-14 lg:pt-16 lg:pb-12 lg:min-h-[calc(100svh-5.8125rem)] lg:flex lg:flex-col lg:justify-center"
    >
      <div className={`${wrap} w-full grid gap-6 sm:gap-8 lg:grid-cols-12 lg:gap-x-12 lg:gap-y-8 lg:items-stretch`}>
        <div className="lg:col-span-7 lg:row-start-1 min-w-0">
          <h1 id="hero-h" className="text-h1 sm:text-display tracking-tight text-ink">
            {headline}
          </h1>
          <p className="mt-4 text-lead text-ink-2">{HERO_FOR}</p>
        </div>
        {/* Phone: right under the headline, so the one action is in the first screen. Desktop: a full-width row
            under both, wide enough that the command shows whole on one line. */}
        <div className="max-w-2xl lg:col-span-12 lg:row-start-2">
          <CopyCommand command={install} />
          <a href="/proof" className={`${textLink} text-body-sm`}>
            {PROOF_TEASER.link}
          </a>
        </div>
        <HeroExchange />
      </div>
    </section>
  );
}

function HeroExchange() {
  return (
    <figure
      aria-label="How each agent answered the recorded request"
      className="lg:col-span-5 lg:col-start-8 lg:row-start-1 flex flex-col rounded-card border border-line bg-surface divide-y divide-line-soft"
    >
      {HERO_EXCHANGE.map((row) => (
        <div key={row.kind} className="px-5 py-4 lg:px-6 lg:py-5 lg:flex-1 lg:flex lg:flex-col lg:justify-center">
          <p className={`section-label ${row.kind === "with" ? "text-accent" : ""}`}>
            {row.label}
            {/* A hairline, not a "·", separates label and role: a dot would count as a hero word. */}
            <span className="ml-2 border-l border-line-strong pl-2 text-ink">{row.role}</span>
          </p>
          {row.text ? (
            <p className={`mt-2 ${row.kind === "with" ? "text-h3 text-ink" : "text-body text-ink-2"}`}>
              {row.text}
            </p>
          ) : null}
        </div>
      ))}
    </figure>
  );
}

// The landing's one proof block, below the first screen: the strongest sourced result with its limit, three lines
// of the with-Membral answer (verbatim, OUTAGE.with), the scored runs, the hand recount and the 504 rule in the
// code, a link to the full recorded runs on /proof; then the page's one comparison with a rules file.
const OUTAGE_QUOTE = [OUTAGE.with.lines[0], OUTAGE.with.lines[2], OUTAGE.with.lines[3]];

export function ProofTeaser() {
  return (
    <section id="proof" aria-labelledby="proof-h" className="py-10 border-t border-line-soft scroll-mt-6">
      <div className={wrap}>
        <SectionHeading id="proof-h">{OUTAGE.title}</SectionHeading>
        <p className="mt-3 max-w-3xl text-lead text-ink-2">{PROOF_TEASER.lines.join(" ")}</p>
        <figure className="mt-5 max-w-3xl">
          <figcaption className="section-label text-accent">{OUTAGE.with.label}</figcaption>
          <blockquote className="mt-1.5 space-y-1 border-l-2 border-line-strong pl-3 text-body text-ink">
            {OUTAGE_QUOTE.map((line) => (
              <p key={line}>{line}</p>
            ))}
          </blockquote>
        </figure>
        <ul className="mt-5 max-w-3xl space-y-1 text-body text-ink-2">
          <li>
            The recounted results, in the README (the full eval harness lives in a private lab):{" "}
          <a href={PROOF_URL} className={`${blockLink} ${pathText}`}>
            {PROOF_LABEL}
          </a>
          </li>
          <li>
            {RULE.title}:{" "}
            <a href={RULE.code.rule.href} className={`${blockLink} ${pathText}`}>
              {RULE.code.rule.text}
            </a>
          </li>
          <li>{PAIR_NOTE}</li>
          <li>
            <a href="/proof" className={`${blockLink} font-medium`}>
              {PROOF_TEASER.link}
            </a>
          </li>
        </ul>
        <p className="mt-4 max-w-3xl text-body text-ink-2">{HERO_ALTERNATIVE}</p>
      </div>
    </section>
  );
}

// The full proof (on /proof): a question only past sessions could answer, as a text receipt card.
// Every line is a verbatim quote from one test run per side (content.ts SOURCES "The outage").
export function Outage() {
  return (
    <section id="outage" aria-labelledby="outage-h" className="py-10 border-t border-line-soft scroll-mt-6">
      <div className={wrap}>
        <SectionHeading id="outage-h">{OUTAGE.title}</SectionHeading>
        <p className="mt-3 max-w-3xl text-lead text-ink-2">{OUTAGE.lede}</p>
        <div className="mt-6 max-w-3xl rounded-card border border-line bg-surface divide-y divide-line-soft">
          <div className="px-4 sm:px-5 py-4">
            <p className="section-label">{OUTAGE.askedLabel}</p>
            <p className="mt-1.5 font-mono font-normal text-body-sm text-ink-2 [overflow-wrap:anywhere]">
              {OUTAGE.asked}
            </p>
          </div>
          <OutageAnswer side={OUTAGE.without} tone="without" />
          <OutageAnswer side={OUTAGE.with} tone="with" />
        </div>
        <h3 className="mt-6 section-label">{OUTAGE.limitsLabel}</h3>
        <ul className="mt-2 max-w-3xl list-disc pl-5 space-y-2 text-body text-ink-2">
          {OUTAGE.limits.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <p className="mt-2 text-body text-ink-2">
          The recounted results, in the README (the full eval harness lives in a private lab):{" "}
          <a href={PROOF_URL} className={`${inlineLink} ${pathText}`}>
            {PROOF_LABEL}
          </a>
        </p>
        </div>
    </section>
  );
}

function OutageAnswer({ side, tone }: { side: { label: string; lines: string[] }; tone: "without" | "with" }) {
  return (
    <figure className="px-4 sm:px-5 py-4">
      <figcaption className={`section-label ${tone === "with" ? "text-accent" : ""}`}>{side.label}</figcaption>
      <blockquote className={`mt-1.5 space-y-2 text-body ${tone === "with" ? "text-ink" : "text-ink-2"}`}>
        {side.lines.map((line) => (
          <p key={line}>{line}</p>
        ))}
      </blockquote>
    </figure>
  );
}

export function ComparePair() {
  return (
    <section id="pair" aria-labelledby="pair-h" className="py-10 border-t border-line-soft scroll-mt-6">
      <div className={wrap}>
        <SectionHeading id="pair-h">{PAIR_TITLE}</SectionHeading>
        <p className="mt-3 max-w-3xl text-lead text-ink-2">{PAIR_LEDE}</p>
        <p className="mt-4 font-mono font-normal text-body-sm text-ink-2 break-words">
          <span className="text-muted select-none">&gt; </span>
          {PAIR_PROMPT}
        </p>
        <p className="mt-1 text-body text-ink-2">{PAIR_NOTE}</p>
        <div className="mt-6 space-y-10">
          <RunPanel run={PAIR.without} />
          <RunPanel run={PAIR.with} />
        </div>
        <figure className="mt-8 max-w-3xl">
          <figcaption className="section-label">{PAIR_QUOTE.label}</figcaption>
          <blockquote className="mt-1.5 border-l-2 border-line-strong pl-3 text-body text-ink-2">
            {PAIR_QUOTE.text}
          </blockquote>
        </figure>
        <Rule />
        <PairLimits />
      </div>
    </section>
  );
}

// The real Claude Code session, one stacked row per side because the two final-answer
// frames have very different shapes (with: 1028x268, without: 1028x616). The agent's own
// words sit above the frame as text. Under 640 px the frame would be too small to read, so the
// same lines show as text there instead of the image (DeferredVideo).
function RunPanel({ run }: { run: Run }) {
  const { width, height } = run.size;
  return (
    <figure className="min-w-0">
      <figcaption className="min-w-0 max-w-3xl">
        <span className="section-label">{run.label}</span>
        <span className="mt-1 block text-body font-medium text-ink">{run.verdict}</span>
        <q
          className={`mt-2 border-l-2 border-line-strong pl-3 text-body-sm text-ink-2 ${run.saidInExcerpt ? "hidden sm:block" : "block"}`}
        >
          {run.said}
        </q>
      </figcaption>
      <DeferredVideo
        poster={run.clip.poster}
        width={width}
        height={height}
        visibleHeight={run.visibleHeight}
        label={run.alt}
        webm={run.clip.webm}
        mp4={run.clip.mp4}
        excerpt={run.excerpt}
      />
    </figure>
  );
}

// The rule both agents could read: the decision, why, and the exact lines in the code and its test.
function Rule() {
  return (
    <div className="mt-10 max-w-3xl rounded-card border border-line bg-surface">
      <h3 className="px-4 sm:px-5 py-3 border-b border-line-soft text-h3 text-ink">{RULE.title}</h3>
      <dl className="px-4 sm:px-5 py-2 divide-y divide-line-soft">
        {RULE.found.map((row) => (
          <div key={row.label} className="py-3 sm:grid sm:grid-cols-4 sm:gap-4">
            <dt className="section-label">{row.label}</dt>
            <dd className="mt-1 sm:mt-0 sm:col-span-3 text-body text-ink-2">{row.text}</dd>
          </div>
        ))}
        <div className="py-3 sm:grid sm:grid-cols-4 sm:gap-4">
          <dt className="section-label">{RULE.code.label}</dt>
          <dd className="mt-1 sm:mt-0 sm:col-span-3 flex flex-col items-start text-body text-ink-2">
            <span>
              The rule:{" "}
              <a href={RULE.code.rule.href} className={`${inlineLink} ${pathText}`}>
                {RULE.code.rule.text}
              </a>
            </span>
            <span>
              Its test:{" "}
              <a href={RULE.code.test.href} className={`${inlineLink} ${pathText}`}>
                {RULE.code.test.text}
              </a>
            </span>
          </dd>
        </div>
      </dl>
    </div>
  );
}

// What the pair does not show, and where every run is scored. The counts across the four sets are in TEST_LIMITS
// and the hand recount (content.ts SOURCES "TEST_LIMITS").
function PairLimits() {
  return (
    <div className="mt-10 max-w-3xl">
      <p className="text-body text-ink-2">{TEST_LIMITS}</p>
      <ul className="mt-3 space-y-2 text-body text-ink-2">
        <li>
          The recounted results, in the README (the full eval harness lives in a private lab):{" "}
          <a href={PROOF_URL} className={`${inlineLink} ${pathText}`}>
            {PROOF_LABEL}
          </a>
        </li>
      </ul>
    </div>
  );
}


export function HowItWorks() {
  return (
    <section id="how" aria-labelledby="how-h" className="py-10 border-t border-line-soft scroll-mt-6">
      <div className={wrap}>
        <SectionHeading id="how-h">How it works</SectionHeading>
        <ol className="mt-5 grid gap-6 sm:grid-cols-3">
          {HOW_IT_WORKS.map((item, i) => (
            <li key={item.step}>
              <p className="text-body font-medium text-ink">
                <span className="font-mono text-micro text-accent mr-2">{String(i + 1).padStart(2, "0")}</span>
                {item.step}
              </p>
              <p className="mt-1 text-body-sm text-ink-2">{item.body}</p>
              {item.link ? (
                <a href={item.link.href} className={`${blockLink} text-body-sm`}>
                  {item.link.text}
                </a>
              ) : null}
            </li>
          ))}
        </ol>
        {/* What it is not, folded in: one line under the steps. */}
        {NOT_THIS.map((item) => (
          <p key={item.term} className="mt-6 max-w-3xl text-body text-ink-2">
            <span className="font-medium text-ink">{item.term}</span> {item.body}
          </p>
        ))}
      </div>
    </section>
  );
}

// Chats, in the same plain three-column shape as HowItWorks; one link to the extension step in /setup.
export function Chats() {
  return (
    <section id="chats" aria-labelledby="chats-h" className="py-10 border-t border-line-soft scroll-mt-6">
      <div className={wrap}>
        <SectionHeading id="chats-h">{CHATS.title}</SectionHeading>
        <ul className="mt-5 grid gap-6 sm:grid-cols-3">
          {CHATS.points.map((item) => (
            <li key={item.term}>
              <p className="text-body font-medium text-ink">{item.term}</p>
              <p className="mt-1 text-body-sm text-ink-2">{item.body}</p>
            </li>
          ))}
        </ul>
        <a href={CHATS.link.href} className={`${blockLink} mt-4 text-body-sm`}>
          {CHATS.link.text}
        </a>
      </div>
    </section>
  );
}

// Privacy and the local option in one block: what is uploaded and where it lives, each group as one paragraph of
// the same sentences; the privacy policy has the rest.
export function Privacy() {
  const group = (title: string, lines: string[]) => (
    <p className="text-body text-ink-2">
      <span className="font-medium text-ink">{title}.</span> {lines.join(" ")}
    </p>
  );
  return (
    <section id="privacy" aria-labelledby="privacy-h" className="py-10 border-t border-line-soft scroll-mt-6">
      <div className={`${wrap} space-y-4`}>
        <SectionHeading id="privacy-h">What is uploaded, and where it lives</SectionHeading>
        <div className="max-w-3xl space-y-3">
          {group("What is uploaded", PRIVACY.uploaded)}
          {group("On membral.me", PRIVACY.hosted)}
          <div id="local" className="scroll-mt-6 space-y-3">
            {group("On your machine", PRIVACY.local)}
            <p className="text-body text-ink-2">
              {LOCAL_IMAGE_NOTE}{" "}
              <a href={SELF_HOSTING_URL} className={`${blockLink} ${pathText}`}>
                docs/SELF-HOSTING.md#the-image
              </a>
            </p>
          </div>
          <p className="text-body text-ink-2">
            <a href="/privacy" className={blockLink}>
              The privacy policy has the details
            </a>
            .
          </p>
        </div>
      </div>
    </section>
  );
}

export function Faq() {
  return (
    <section id="faq" aria-labelledby="faq-h" className="py-10 border-t border-line-soft scroll-mt-6">
      <div className={wrap}>
        <SectionHeading id="faq-h">Questions</SectionHeading>
        <dl className="mt-5 grid gap-x-8 gap-y-6 md:grid-cols-2 items-start max-w-4xl">
          {FAQ.map((item) => (
            <div key={item.q}>
              <dt className="text-body font-medium text-ink">{item.q}</dt>
              <dd className="mt-1 text-body-sm text-ink-2">
                {item.a}
                {item.q.startsWith("Is it open source") ? (
                  <>
                    <br />
                    <a href={REPO_URL} className={blockLink}>
                      github.com/surajtripathy07/membral
                    </a>
                  </>
                ) : null}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}

// Closes the page with what the hero does not say: the start steps and what happens after each. The install
// command is not repeated; step 1 links back to it. "membral status" has its own Copy button. Then what you see
// after, and the plugin alternative.
export function Closing() {
  return (
    <section id="start" aria-labelledby="start-h" className="py-12 border-t border-line-soft scroll-mt-6">
      <div className={wrap}>
        <SectionHeading id="start-h">{START.title}</SectionHeading>
        <ol className="mt-3 max-w-2xl space-y-5 text-body text-ink-2">
          {START.steps.map((step, i) => (
            // The step number sits inline at the start of the text, so every line of the step shares the left edge
            // of the heading and the sample below (no hanging indent).
            <li key={step.text}>
              <div className="min-w-0">
                <p>
                  <span className="font-mono text-micro text-accent mr-2">{String(i + 1).padStart(2, "0")}</span>
                  {step.text}
                </p>
                {step.command === "install" ? (
                  <p className="mt-1">
                    <a href="#hero-h" className={textLink}>
                      Back to the install command
                    </a>
                  </p>
                ) : step.command ? (
                  <div className="mt-2">
                    <CopyCommand command={step.command} />
                  </div>
                ) : null}
                {step.note ? <p className="mt-2 text-body text-ink-2">{step.note}</p> : null}
              </div>
            </li>
          ))}
        </ol>
        <figure className="mt-6 max-w-2xl">
          <figcaption className="text-body-sm text-ink-2">{START.sampleLabel}</figcaption>
          <pre className="mt-1 rounded-sm border border-line bg-sunken px-4 py-3 font-mono font-normal text-body-sm text-ink-2 whitespace-pre-wrap [overflow-wrap:anywhere]">
            {START.sample}
          </pre>
        </figure>
        <p className="mt-4 max-w-2xl flex flex-wrap items-center gap-x-6 text-body-sm text-ink-2">
          <a href={README_INSTALL_URL} className={textLink}>
            {START.plugin}
          </a>
          {/* Sign-up is open on a local run only; hosted keeps existing accounts (D-081). Read at render. */}
          {isLocalRuntime() ? (
            <a href="/signup" className={textLink}>
              Or create an account first
            </a>
          ) : null}
        </p>
      </div>
    </section>
  );
}

// The full tagline (docs/PRODUCT.md, verbatim) as the landing footer's small print, not as a heading; other pages
// (privacy) pass none.
export function LandingFooter({ tagline }: { tagline?: string }) {
  const link = `inline-flex items-center justify-center min-h-11 min-w-11 text-body text-ink-2 hover:text-ink rounded-xs transition-colors ${focusRing}`;
  return (
    <footer className="border-t border-line-soft py-8">
      {tagline ? <p className={`${wrap} mb-3 text-body-sm text-muted`}>{tagline}</p> : null}
      <div className={`${wrap} flex flex-col sm:flex-row sm:items-center justify-between gap-3`}>
        <span className="text-body text-ink-2">Membral · membral.me · MIT</span>
        <div className="flex items-center gap-6">
          <a href="/proof" className={link}>
            Proof
          </a>
          <a href="/privacy" className={link}>
            Privacy
          </a>
          <a href="/terms" className={link}>
            Terms
          </a>
          <a href={REPO_URL} className={link}>
            GitHub
          </a>
        </div>
      </div>
    </footer>
  );
}
