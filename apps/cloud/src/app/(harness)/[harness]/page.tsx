import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { LandingFooter, LandingNav } from "../../_landing/sections";
import { getHarness, HARNESSES } from "./harnesses";

// Public per-harness pages (/claude-code, /opencode, /codex). Listed in middleware.ts publicExactPaths.
export const dynamicParams = false;

export function generateStaticParams() {
  return HARNESSES.map((h) => ({ harness: h.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ harness: string }> }): Promise<Metadata> {
  const h = getHarness((await params).harness);
  if (!h) return {};
  return {
    title: `Memory for ${h.name} sessions — Membral`,
    description: h.description,
    alternates: { canonical: `/${h.slug}` },
  };
}

export default async function HarnessPage({ params }: { params: Promise<{ harness: string }> }) {
  const h = getHarness((await params).harness);
  if (!h) notFound();
  return (
    <div className="min-h-screen bg-canvas text-ink">
      <LandingNav />
      <main>
        <section aria-labelledby="harness-h1" className="pt-10 pb-8 sm:pt-14">
          <div className="mx-auto max-w-5xl px-4 sm:px-6">
            <p className="section-label">{h.name}</p>
            <h1 id="harness-h1" className="mt-2 text-h1 tracking-tight text-ink">
              Memory for {h.name} sessions
            </h1>
            <p className="mt-4 max-w-2xl text-muted">{h.intro}</p>
            <h2 className="mt-8 text-lg text-ink">Connect over MCP</h2>
            <p className="mt-2 max-w-2xl text-muted">{h.connectHint}</p>
            <pre className="mt-3 overflow-x-auto rounded-md border border-line bg-sunken p-4 text-sm text-ink">
              <code>{h.snippet}</code>
            </pre>
            <p className="mt-6">
              <Link href="/setup" className="text-accent underline underline-offset-2">
                Set up Membral
              </Link>
            </p>
          </div>
        </section>
      </main>
      <LandingFooter />
    </div>
  );
}
