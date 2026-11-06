import { isLocalRuntime } from "@/lib/env";
import { CaptionText } from "./caption-text";
import {
  CHATS,
  CLOSING,
  FAQ,
  FOOTER,
  HANDOFF,
  HARNESS_LINKS,
  HERO,
  NAV,
  OUTAGE_FIG,
  RECORD_FIG,
  REPO_URL,
  START,
  STORE_FIG,
  TEAMS,
} from "./content";

// Server-rendered parts of the signed-out landing (page.tsx assembles them). Copy lives in content.ts. The
// figure numbers come from CSS counters in document order: the replay is Fig. 1, then OutageFig, StoreFig and
// RecordFig. The /proof links are the two figure captions only (the nav and footer sit outside <main>).

export function Nav() {
  return (
    <header className="navbar">
      <div className="wrap top">
        <a className="brand" href="/" aria-label="Membral, home">
          <i aria-hidden="true" />
          membral
        </a>
        <nav aria-label="Primary">
          <a href="/proof" className="hide-s">
            {NAV.proof}
          </a>
          <a href={REPO_URL} className="hide-s">
            {NAV.github}
          </a>
          {/* Hosted shows no sign-in; existing accounts reach /login by URL. Read at render (D-081). */}
          {isLocalRuntime() ? <a href="/login">Sign in</a> : null}
          <a href="#start" className="navcta">
            {NAV.cta}
          </a>
        </nav>
      </div>
    </header>
  );
}

export function HeroCopy({ headline }: { headline: string }) {
  return (
    <div className="copy">
      <h1>{headline}</h1>
      <p className="sub">{HERO.sub}</p>
    </div>
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

export function OutageFig() {
  const { with: w, without: wo, total } = OUTAGE_FIG;
  return (
    <section className="sec proof" aria-labelledby="proof-h">
      <div className="wrap">
        <figure className="fig">
          <span className="lbl">
            [ <span className="figno" /> · recounted by hand ]
          </span>
          <h2 id="proof-h">{OUTAGE_FIG.heading}</h2>
          <div className="strip" data-reveal>
            <div className="srow">
              <span className="who">{w.label}</span>
              <Squares filled={w.hits} total={total} />
              <span className="num">
                {w.hits}/{total}
              </span>
            </div>
            <div className="srow">
              <span className="who">{wo.label}</span>
              <Squares filled={wo.hits} total={total} />
              <span className="num">
                {wo.hits}/{total}
              </span>
            </div>
          </div>
          <figcaption>
            <CaptionText text={OUTAGE_FIG.caption.trimEnd()} /> <a href="/proof">{OUTAGE_FIG.captionLink}</a>
          </figcaption>
        </figure>
      </div>
    </section>
  );
}

// A harness label in the figure: a link to its page when it has one, plain text otherwise. The inline style beats the
// scoped `.schem text` fill; the rect keeps the whole box clickable.
function HarnessLabel({ name, x, y }: { name: string; x: number; y: number }) {
  const slug = HARNESS_LINKS[name];
  if (!slug) return <text x={x} y={y}>{name}</text>;
  return (
    <a href={`/${slug}`}>
      <text x={x} y={y} style={{ fill: "var(--l-accent)", textDecoration: "underline" }}>
        {name}
      </text>
    </a>
  );
}

export function StoreFig() {
  const h = STORE_FIG.harnesses;
  return (
    <section className="sec" aria-labelledby="store-h">
      <div className="wrap">
        <figure className="fig">
          <span className="lbl">
            [ <span className="figno" /> · how the pieces connect ]
          </span>
          <h2 id="store-h">{STORE_FIG.heading}</h2>
          <p>{STORE_FIG.body}</p>
          <div className="schem" data-reveal>
            <svg className="sch-h" viewBox="0 0 862 220" role="group" aria-label="Harnesses to store to agent" focusable="false">
              {h.map((name, i) => (
                <g key={name}>
                  <rect className="stk" x="1" y={10 + i * 52} width="150" height="38" />
                  <HarnessLabel name={name} x={14} y={34 + i * 52} />
                  <path className="flow" d={`M151 ${29 + i * 52} H225 V110 H300`} />
                </g>
              ))}
              <rect className="stk" x="300" y="64" width="230" height="92" />
              <text x="314" y="100">
                {STORE_FIG.store}
              </text>
              <text className="sub" x="314" y="122">
                {STORE_FIG.storeSub}
              </text>
              <path className="flow" d="M530 110 H610" />
              <rect className="stk" x="610" y="64" width="251" height="92" />
              <text x="624" y="100">
                {STORE_FIG.agent}
              </text>
              <text className="sub" x="624" y="122">
                {STORE_FIG.agentSub}
              </text>
            </svg>
            <svg className="sch-v" viewBox="0 0 320 330" role="group" aria-label="Harnesses to store to agent" focusable="false">
              {h.map((name, i) => (
                <g key={name}>
                  <rect className="stk" x={(i % 2) * 172 + 1} y={Math.floor(i / 2) * 46 + 1} width="146" height="38" />
                  <HarnessLabel name={name} x={(i % 2) * 172 + 12} y={Math.floor(i / 2) * 46 + 25} />
                </g>
              ))}
              {/* the lines run through the gutter between the two columns, never behind a label */}
              <path className="flow" d="M147 20 H160 V130" />
              <path className="flow" d="M173 20 H160" />
              <path className="flow" d="M147 66 H160" />
              <path className="flow" d="M173 66 H160" />
              <rect className="stk" x="20" y="130" width="280" height="64" />
              <text x="34" y="158">
                {STORE_FIG.store}
              </text>
              <text className="sub" x="34" y="178">
                {STORE_FIG.storeSub}
              </text>
              <path className="flow" d="M160 194 V240" />
              <rect className="stk" x="20" y="240" width="280" height="64" />
              <text x="34" y="268">
                {STORE_FIG.agent}
              </text>
              <text className="sub" x="34" y="288">
                {STORE_FIG.agentSub}
              </text>
            </svg>
            <span className="sr">
              {h.join(", ")} write to {STORE_FIG.store} ({STORE_FIG.storeSub}); {STORE_FIG.agent} reads it by{" "}
              {STORE_FIG.agentSub}.
            </span>
            <p className="measured">{STORE_FIG.measured}</p>
          </div>
        </figure>
      </div>
    </section>
  );
}

export function Handoff() {
  return (
    <section className="sec" aria-labelledby="handoff-h">
      <div className="wrap twocol">
        <div className="fig">
          <span className="lbl">
            [ <span className="figno" /> · {HANDOFF.kicker} ]
          </span>
          <h2 id="handoff-h">{HANDOFF.heading}</h2>
          <p>{HANDOFF.body}</p>
        </div>
        <dl className="dl side">
          {HANDOFF.rows.map((r) => (
            <div key={r.k}>
              <dt>{r.k}</dt>
              <dd>{r.v}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}

export function RecordFig() {
  return (
    <section className="sec" aria-labelledby="record-h">
      <div className="wrap twocol">
        <div className="fig">
          <span className="lbl">
            [ <span className="figno" /> · {RECORD_FIG.kicker} ]
          </span>
          <h2 id="record-h">{RECORD_FIG.heading}</h2>
          <p>
            <code>{RECORD_FIG.command}</code>
            {RECORD_FIG.after}
          </p>
        </div>
        <figure style={{ margin: 0 }}>
          <dl className="dl rec" data-reveal>
            {RECORD_FIG.fields.map((f, i) => (
              <div key={f.k}>
                <dt>{f.k}</dt>
                <dd className={f.quote ? "q" : undefined} style={{ ["--i" as string]: i }}>
                  {f.v}
                </dd>
              </div>
            ))}
          </dl>
        </figure>
      </div>
    </section>
  );
}

export function Chats() {
  return (
    <section className="sec" aria-labelledby="chats-h">
      <div className="wrap twocol">
        <div className="fig">
          <span className="lbl">
            [ <span className="figno" /> · {CHATS.kicker} ]
          </span>
          <h2 id="chats-h">{CHATS.heading}</h2>
          <p>{CHATS.body}</p>
        </div>
        <dl className="dl side">
          {CHATS.rows.map((r) => (
            <div key={r.k}>
              <dt>{r.k}</dt>
              <dd>{r.v}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}

export function Start() {
  return (
    <section className="sec" id="start" aria-labelledby="start-h">
      <div className="wrap">
        <h2 id="start-h">{START.heading}</h2>
        <p>{START.prereq}</p>
        <ol className="steps">
          {START.steps.map((s) => (
            <li key={s.title}>
              <h3>{s.title}</h3>
              {"code" in s && s.code ? (
                <pre>
                  <code>{s.code}</code>
                </pre>
              ) : null}
              <p>
                {s.body}
                {"link" in s && s.link ? (
                  <>
                    {" "}
                    <a href={s.link.href}>{s.link.text}</a>
                  </>
                ) : null}
              </p>
              {"options" in s && s.options ? (
                <ul className="opts">
                  {s.options.map((o) => (
                    <li key={o.label} className="opt">
                      <span className="lbl">[ {o.label} ]</span>
                      <pre>
                        <code>{o.code}</code>
                      </pre>
                      <p>{o.note}</p>
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ol>
        <p>
          <code>{START.noteCommand}</code>
          {START.note}
        </p>
        <p>{START.remove}</p>
        {isLocalRuntime() ? (
          <p>
            <a href={START.signup.href}>{START.signup.text}</a>
          </p>
        ) : null}
      </div>
    </section>
  );
}

export function Faq() {
  return (
    <section className="sec faq" aria-labelledby="faq-h">
      <div className="wrap">
        <h2 id="faq-h">Questions</h2>
        {FAQ.map((f) => (
          <details key={f.q}>
            <summary>{f.q}</summary>
            <p>{f.a}</p>
          </details>
        ))}
      </div>
    </section>
  );
}

export function Teams() {
  return (
    <section className="sec" aria-labelledby="teams-h">
      <div className="wrap">
        <h2 id="teams-h">{TEAMS.heading}</h2>
        <p>{TEAMS.body}</p>
        <p>
          <a href={TEAMS.href}>{TEAMS.linkText}</a>
        </p>
      </div>
    </section>
  );
}

export function Closing({ tagline }: { tagline: string }) {
  return (
    <section className="closing" aria-label="Get started">
      <div className="wrap">
        <p className="tag">{tagline}</p>
        <div className="acts">
          <a className="btn" href="#start">
            {CLOSING.cta}
          </a>
          <a href={REPO_URL}>{CLOSING.github}</a>
        </div>
      </div>
    </section>
  );
}

export function Footer() {
  return (
    <footer className="wrap">
      <div className="foot2">
        <span>membral</span>
        <span>MIT</span>
        <a href={REPO_URL}>GitHub</a>
        <a href="/proof">Proof</a>
        <a href="/compare">Compare</a>
        <a href="/claude-code">Claude Code</a>
        <a href="/opencode">opencode</a>
        <a href="/codex">Codex</a>
        <a href={FOOTER.emailHref}>{FOOTER.email}</a>
        <a href="/privacy">Privacy</a>
        <a href="/terms">Terms</a>
      </div>
    </footer>
  );
}

