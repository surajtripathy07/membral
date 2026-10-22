import type { Metadata } from "next";
import { LandingFooter, LandingNav } from "../_landing/sections";
import { getContactEmail } from "@/lib/contact";
import { Section, textLink } from "../_legal/parts";

export const metadata: Metadata = {
  title: "Terms of Service — Membral",
  description: "The terms for using Membral",
};

export default function TermsPage() {
  const contact = getContactEmail();
  return (
    <main className="min-h-screen bg-canvas text-ink">
      <LandingNav />
      <article className="mx-auto max-w-3xl px-4 sm:px-6 py-10 sm:py-16">
        <p className="section-label">Terms</p>
        <h1 className="mt-2 text-h1 tracking-tight text-ink">Terms of Service</h1>
        <p className="mt-2 text-body-sm text-muted">Last updated: 2026-10-20</p>

        <p className="mt-6 text-lead text-ink-2">
          These are the terms for using Membral — the Chrome extension and the hosted app at membral.me. By
          installing or using Membral, or signing in to an existing hosted account, you agree to them. See also the{" "}
          <a href="/privacy" className={textLink}>
            Privacy Policy
          </a>{" "}
          for how your data is handled.
        </p>

        <Section id="early-stage" title="Early-stage product">
          <p>
            Membral is a small, early-stage, actively-changing product built and run by one person. Features can
            change or break, and there is no uptime guarantee — the service can go down, and data can
            occasionally be lost, though we take reasonable care to avoid that. Don&apos;t rely on Membral as
            the sole copy of anything you can&apos;t afford to lose; the extension&apos;s local export and the
            account&apos;s data export (see Settings) exist so you always have a copy outside of Membral.
          </p>
        </Section>

        <Section id="content" title="Your content is yours">
          <p>
            You own the conversations and other content you sync into Membral. We don&apos;t claim any ownership
            over it. You&apos;re responsible for the content you sync and for having the right to sync it (for
            example, not syncing conversations that contain someone else&apos;s confidential information
            without their permission).
          </p>
        </Section>

        <Section id="acceptable-use" title="Acceptable use">
          <p>You agree not to:</p>
          <ul className="list-disc space-y-2 pl-5">
            <li>Use Membral to break the law, or to store or process unlawful content.</li>
            <li>
              Attempt to circumvent rate limits, per-account limits, or feature gates, or to access another
              user&apos;s account or data.
            </li>
            <li>
              Use the service in a way that imposes an unreasonable load on it (for example, automated bulk
              scraping of the app rather than syncing your own conversations through the extension or the CLI; see{" "}
              <a href="/setup" className={textLink}>
                Setup
              </a>
              ).
            </li>
            <li>Resell or provide the service to third parties as your own product.</li>
          </ul>
        </Section>

        <Section id="suspension" title="Suspension">
          <p>
            We may suspend or terminate an account that violates the acceptable-use terms above, abuses shared
            infrastructure (for example, running up API costs through automated abuse), or poses a security risk
            to the service or other users. Where practical we&apos;ll try to warn first; for active abuse we may
            act immediately. You can export or delete your data (see &quot;What you can delete&quot; in the{" "}
            <a href="/privacy" className={textLink}>
              Privacy Policy
            </a>
            ) even after suspension.
          </p>
        </Section>

        <Section id="third-party" title="Third-party processing">
          <p>
            Today, on membral.me, the server sends model calls through OpenRouter: session text goes to a Google
            Gemma model to extract decisions and findings, and record text, search text and recall prompts go
            through the same OpenRouter key to build embeddings for search and to answer chat. Extraction is on
            by default for every account and covers sessions from the last 30 days. The operator may change
            providers, and the{" "}
            <a href="/privacy" className={textLink}>
              Privacy Policy
            </a>{" "}
            is updated when that happens. By using the service you agree that your content is processed by these
            providers under their own terms.
          </p>
        </Section>

        <Section id="warranty" title="No warranty">
          <p>
            Membral is provided &quot;as is,&quot; without warranty of any kind, express or implied. To the
            extent permitted by law, we&apos;re not liable for indirect, incidental, or consequential damages
            arising from your use of the service.
          </p>
        </Section>

        <Section id="changes" title="Changes to these terms">
          <p>
            If these terms change materially, we&apos;ll update the &quot;Last updated&quot; date above and note
            the change on this page. Continued use of Membral after a change means you accept the updated terms.
          </p>
        </Section>

        <Section id="contact" title="Contact">
          <p>
            Questions about these terms? Reach us at{" "}
            <a href={`mailto:${contact}`} className={textLink}>
              {contact}
            </a>
            .
          </p>
        </Section>
      </article>
      <LandingFooter />
    </main>
  );
}
