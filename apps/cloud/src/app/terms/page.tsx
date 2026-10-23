import type { Metadata } from "next";
import { REPO_URL } from "../_landing/content";
import { LandingFooter, LandingNav } from "../_landing/sections";
import { Section, textLink } from "../_legal/parts";

export const metadata: Metadata = {
  title: "Terms - Membral",
  description: "Membral is open-source software you run on your own machine",
};

export default function TermsPage() {
  return (
    <main className="min-h-screen bg-canvas text-ink">
      <LandingNav />
      <article className="mx-auto max-w-3xl px-4 sm:px-6 py-10 sm:py-16">
        <p className="section-label">Terms</p>
        <h1 className="mt-2 text-h1 tracking-tight text-ink">Terms</h1>
        <p className="mt-2 text-body-sm text-muted">Last updated: 2026-10-23</p>

        <p className="mt-6 text-lead text-ink-2">
          Membral is open-source software that runs on your own machine. These terms are short because there is no
          hosted service to agree to. See the{" "}
          <a href="/privacy" className={textLink}>
            Privacy page
          </a>{" "}
          for what it stores.
        </p>

        <Section id="license" title="License">
          <p>
            Membral is released under the MIT license. The full text is in the{" "}
            <a href={`${REPO_URL}/blob/main/LICENSE`} className={textLink}>
              LICENSE file
            </a>{" "}
            on GitHub.
          </p>
          <p>
            It is provided as is, without warranty of any kind, and the authors are not liable for what comes of
            using it.
          </p>
        </Section>

        <Section id="your-machine" title="Your machine, your data">
          <p>
            You run Membral yourself, so you are responsible for your data and for keeping the machine it runs
            on safe.
          </p>
          <p>
            You also choose the model provider: a Claude login, an API key, or Ollama. That provider&apos;s own
            terms apply to what you send it.
          </p>
          <p>Membral is not affiliated with Anthropic, OpenAI or any other model provider.</p>
        </Section>

        <Section id="help" title="Issues and security">
          <p>
            Report bugs and ask questions in the{" "}
            <a href={`${REPO_URL}/issues`} className={textLink}>
              GitHub issues
            </a>
            . Report a security problem privately through the repository&apos;s{" "}
            <a href={`${REPO_URL}/security`} className={textLink}>
              Security tab
            </a>
            .
          </p>
        </Section>

        <Section id="no-promises" title="No promises of service">
          <p>
            There is no service, uptime, account, billing or support response time to promise. Features can
            change or break between releases.
          </p>
        </Section>
      </article>
      <LandingFooter />
    </main>
  );
}
