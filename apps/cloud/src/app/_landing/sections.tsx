import { BrandLockup } from "@/components/brand-mark";
import { isLocalRuntime } from "@/lib/env";
import { DeferredVideo } from "./deferred-video";
import {
  OUTAGE,
  PAIR,
  PAIR_LEDE,
  PAIR_NOTE,
  PAIR_PROMPT,
  PAIR_QUOTE,
  PAIR_TITLE,
  REPO_URL,
  PROOF_LABEL,
  PROOF_URL,
  RULE,
  type Run,
  TEST_LIMITS,
} from "./content";

// Shared chrome and the proof blocks used by /proof, /privacy and /terms (the landing page itself is landing-parts.tsx).
// Paper & ink only (docs/design/tokens.md): tokens, hairlines, no gradients,
// no blur, no translucent fills. Serif is for headings (base layer), mono only
// for commands and paths. Every sentence comes from content.ts, which names its source.

export const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-canvas";

const wrap = "mx-auto max-w-5xl px-4 sm:px-6";

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

// Footer for /proof, /privacy and /terms. The landing page has its own (landing-parts.tsx).
export function LandingFooter() {
  const link = `inline-flex items-center justify-center min-h-11 min-w-11 text-body text-ink-2 hover:text-ink rounded-xs transition-colors ${focusRing}`;
  return (
    <footer className="border-t border-line-soft py-8">
      <div className={`${wrap} flex flex-col sm:flex-row sm:items-center justify-between gap-3`}>
        <span className="text-body text-ink-2">Membral · MIT</span>
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
