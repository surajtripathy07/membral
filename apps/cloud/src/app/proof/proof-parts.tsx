import { isLocalRuntime } from "@/lib/env";
import {
  NAV,
  OUTAGE,
  PAIR,
  PAIR_LEDE,
  PAIR_NOTE,
  PAIR_PROMPT,
  PAIR_QUOTE,
  PAIR_TITLE,
  PROOF_LABEL,
  PROOF_P1,
  PROOF_P2,
  PROOF_P3,
  PROOF_PAGE,
  PROOF_URL,
  REPO_URL,
  RULE,
  type Run,
  TEST_LIMITS,
} from "../_landing/content";
import { ProofVideo } from "./proof-video";

// /proof and the 404 page in the landing's system (the `.landing` scope in globals.css, fonts from _landing/fonts.ts).
// Figures are numbered P1 to P3 by the same CSS counter the landing uses; the `proofpg` modifier on the wrapper
// prints the P. Every string comes from _landing/content.ts. The recorded clips, stills and answers are the ones the
// dashboard-styled blocks showed before (OUTAGE, PAIR, RULE, TEST_LIMITS are unchanged).

// Same bar as the landing's Nav, with the call to action pointed at the landing's #start (there is no #start here).
export function PageNav({ current }: { current?: "proof" }) {
  return (
    <header className="navbar">
      <div className="wrap top">
        <a className="brand" href="/" aria-label="Membral, home">
          <i aria-hidden="true" />
          membral
        </a>
        <nav aria-label="Primary">
          <a href="/proof" className="hide-s" aria-current={current === "proof" ? "page" : undefined}>
            {NAV.proof}
          </a>
          <a href={REPO_URL} className="hide-s">
            {NAV.github}
          </a>
          {isLocalRuntime() ? <a href="/login">Sign in</a> : null}
          <a href="/#start" className="navcta">
            {NAV.cta}
          </a>
        </nav>
      </div>
    </header>
  );
}

export function ProofHero() {
  return (
    <header className="phero wrap">
      <p className="lbl">[ {PROOF_PAGE.kicker} ]</p>
      <h1 id="proof-h1">{PROOF_PAGE.heading}</h1>
      <p className="sub">{PROOF_PAGE.lede}</p>
      <ul className="toc">
        {PROOF_PAGE.toc.map((t) => (
          <li key={t.href}>
            <a href={t.href}>{t.label}</a>
          </li>
        ))}
      </ul>
    </header>
  );
}

function Method({ rows, label }: { rows: { k: string; v: string }[]; label: string }) {
  return (
    <dl className="meth" aria-label={label}>
      {rows.map((r) => (
        <div key={r.k}>
          <dt>{r.k}</dt>
          <dd>{r.v}</dd>
        </div>
      ))}
    </dl>
  );
}

function Squares({ filled, total }: { filled: number; total: number }) {
  return (
    <ul className="sq" aria-hidden="true">
      {Array.from({ length: total }, (_, i) => (
        <li key={i} className={i < filled ? "f" : undefined} style={{ ["--i" as string]: i }} />
      ))}
    </ul>
  );
}

// Fig. P1: the outage question, four sets of five runs, the two quoted answers, the method and the limits.
export function OutageProof() {
  const p = PROOF_P1;
  return (
    <section className="sec" id="outage" aria-labelledby="outage-h">
      <div className="wrap pgrid">
        <div className="fig ph">
          <span className="lbl">
            [ <span className="figno" /> · {p.label} ]
          </span>
          <h2 id="outage-h">{OUTAGE.title}</h2>
          <p>{OUTAGE.lede}</p>
        </div>
        <div className="pfig">
          <div className="strip runs" data-reveal>
            {p.sets.map((s) => (
              <div className="set" key={s.name}>
                <p className="setl">{s.name}</p>
                <div className="pair">
                  <div>
                    <p className="who">
                      <span>{p.without}</span>
                      <span className="num">
                        {s.without}/{p.total}
                      </span>
                    </p>
                    <Squares filled={s.without} total={p.total} />
                  </div>
                  <div>
                    <p className="who">
                      <span>{p.with}</span>
                      <span className="num">
                        {s.with}/{p.total}
                      </span>
                    </p>
                    <Squares filled={s.with} total={p.total} />
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div className="qa">
            <div>
              <span className="lbl">{OUTAGE.askedLabel}</span>
              <p className="qq">{OUTAGE.asked}</p>
            </div>
            <Answer side={OUTAGE.without} />
            <Answer side={OUTAGE.with} on />
          </div>
          <p className="cap">{p.caption}</p>
        </div>
        <div className="pm">
          <Method rows={p.method} label="Method" />
          <h3 className="lbl sublbl">{OUTAGE.limitsLabel}</h3>
          <ul className="lim">
            {OUTAGE.limits.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

function Answer({ side, on }: { side: { label: string; lines: string[] }; on?: boolean }) {
  return (
    <figure className={on ? "ans on" : "ans"}>
      <figcaption className="lbl">{side.label}</figcaption>
      <blockquote>
        {side.lines.map((line) => (
          <p key={line}>{line}</p>
        ))}
      </blockquote>
    </figure>
  );
}

// One recorded side: the agent's own words as text, then the still and the clip.
function Panel({ run }: { run: Run }) {
  return (
    <figure className="pv">
      <figcaption>
        <span className="lbl">{run.label}</span>
        <span className="verdict">{run.verdict}</span>
        <q className={run.saidInExcerpt ? "dup" : undefined}>{run.said}</q>
      </figcaption>
      <ProofVideo
        poster={run.clip.poster}
        width={run.size.width}
        height={run.size.height}
        visibleHeight={run.visibleHeight}
        label={run.alt}
        webm={run.clip.webm}
        mp4={run.clip.mp4}
        excerpt={run.excerpt}
      />
    </figure>
  );
}

// Fig. P2: the same request recorded without and with Membral, the rule both agents could read, what it does not show.
export function PairProof() {
  const p = PROOF_P2;
  return (
    <section className="sec" id="pair" aria-labelledby="pair-h">
      <div className="wrap">
        <figure className="fig">
          <span className="lbl">
            [ <span className="figno" /> · {p.label} ]
          </span>
          <h2 id="pair-h">{PAIR_TITLE}</h2>
          <p>{PAIR_LEDE}</p>
          <p className="lbl sublbl">{p.promptLabel}</p>
          <pre className="cmd">
            <code>
              <span className="p">&gt; </span>
              {PAIR_PROMPT}
            </code>
          </pre>
          <Panel run={PAIR.without} />
          <Panel run={PAIR.with} />
          <figcaption className="cap">{PAIR_NOTE}</figcaption>
        </figure>
        <div className="twocol pair2">
          <div>
            <h3 className="rt">{RULE.title}</h3>
            <Method
              label={RULE.title}
              rows={[
                ...RULE.found.map((r) => ({ k: r.label, v: r.text })),
              ]}
            />
            <dl className="meth meth-links">
              <div>
                <dt>{RULE.code.label}</dt>
                <dd>
                  <span>
                    {p.ruleLabels.rule}: <a href={RULE.code.rule.href}>{RULE.code.rule.text}</a>
                  </span>
                  <span>
                    {p.ruleLabels.test}: <a href={RULE.code.test.href}>{RULE.code.test.text}</a>
                  </span>
                </dd>
              </div>
            </dl>
          </div>
          <div>
            <figure className="again">
              <figcaption className="lbl">{PAIR_QUOTE.label}</figcaption>
              <blockquote>{PAIR_QUOTE.text}</blockquote>
            </figure>
            <h3 className="lbl sublbl">{p.limitsLabel}</h3>
            <p className="note">{TEST_LIMITS}</p>
            <p className="note">
              {p.readmeLead}
              <a href={PROOF_URL}>{PROOF_LABEL}</a>
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

// Fig. P3: the lookup time, its bars on one scale, and the whole method.
export function LatencyProof() {
  const p = PROOF_P3;
  return (
    <section className="sec" id="latency" aria-labelledby="latency-h">
      <div className="wrap pgrid">
        <div className="fig ph">
          <span className="lbl">
            [ <span className="figno" /> · {p.label} ]
          </span>
          <h2 id="latency-h">{p.heading}</h2>
          <p>{p.body}</p>
        </div>
        <div className="pfig">
          <div className="lat" data-reveal>
            {p.rows.map((r) => (
              <div className="lrow" key={r.endpoint}>
                <p className="ep">
                  <code>{r.endpoint}</code>
                  <span className="dim">{r.note}</span>
                </p>
                <div className="bar">
                  <span>p50</span>
                  <span className="track" aria-hidden="true">
                    <i className="fill" style={{ ["--v" as string]: r.p50 / p.max }} />
                  </span>
                  <span className="val">{r.p50.toLocaleString("en-US")} ms</span>
                </div>
                <div className="bar p95">
                  <span>p95</span>
                  <span className="track" aria-hidden="true">
                    <i className="fill" style={{ ["--v" as string]: r.p95 / p.max }} />
                  </span>
                  <span className="val">{r.p95.toLocaleString("en-US")} ms</span>
                </div>
              </div>
            ))}
            <p className="scale">{p.scaleNote}</p>
          </div>
          <p className="cap">{p.caption}</p>
        </div>
        <div className="pm">
          <Method rows={p.method} label="Method" />
        </div>
      </div>
    </section>
  );
}
