import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { NAV } from "../../_landing/content";
import { PageShell } from "../../compare/page-shell";
import s from "./harness.module.css";
import { capabilityRows, getHarness, HARNESSES, SELF_HOSTING_PLUGIN_URL } from "./harnesses";

// Public per-harness pages (/claude-code, /opencode, /codex) in the landing's system. Copy and snippets are in
// ./harnesses.ts (every sentence traces to README.md); the shell is the one /compare and /proof use. Listed in
// middleware.ts publicExactPaths. Unknown slugs 404 through notFound(); the three known routes are prerendered.
// dynamicParams stays on: with it false, `next dev` answers every slug with NoFallbackError.

export function generateStaticParams() {
  return HARNESSES.map((h) => ({ harness: h.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ harness: string }> }): Promise<Metadata> {
  const h = getHarness((await params).harness);
  if (!h) return {};
  return { title: `Membral for ${h.name}`, description: h.description };
}

export default async function HarnessPage({ params }: { params: Promise<{ harness: string }> }) {
  const h = getHarness((await params).harness);
  if (!h) notFound();
  const rows = capabilityRows(h);
  return (
    <PageShell>
      <header className="phero wrap">
        <p className="lbl">[ {h.name} ]</p>
        <h1 id="harness-h1">Membral for {h.name}</h1>
        <p className="sub">{h.intro}</p>
      </header>
      <section className="sec" aria-labelledby="what-h">
        <div className="wrap">
          <figure className="fig">
            <span className="lbl">
              [ <span className="figno" /> · what {h.name} gets ]
            </span>
            <h2 id="what-h">What Membral does for {h.name}</h2>
            <dl className="dl">
              {rows.map((r) => (
                <div key={r.k}>
                  <dt>{r.k}</dt>
                  <dd>{r.v}</dd>
                </div>
              ))}
            </dl>
            <figcaption>The rows are the README's Supported agents table and its description of the CLI.</figcaption>
          </figure>
        </div>
      </section>
      <section className="sec" aria-labelledby="connect-h">
        <div className="wrap">
          <h2 id="connect-h">Connect {h.name}</h2>
          <p>{h.connectHint}</p>
          <pre className={s.code}>
            <code>{h.snippet}</code>
          </pre>
          {h.slug === "claude-code" ? (
            <p>
              A Claude Code plugin is an alternative to the CLI hooks.{" "}
              <a href={SELF_HOSTING_PLUGIN_URL}>Plugin install</a>
            </p>
          ) : null}
        </div>
      </section>
      <section className="sec closing-p" aria-label={NAV.cta}>
        <div className="wrap">
          <a className="btn" href="/#start">
            {NAV.cta}
          </a>
        </div>
      </section>
    </PageShell>
  );
}
