import type { ReactNode } from "react";
import s from "./compare.module.css";
import { APPROACHES, COMPARE_PAGE, COMPARE_ROWS, FITS, LIMITS, README_URL } from "./content";

// /compare in the landing's system. Fig. 1 is one real <table>; below 800px the same markup lays out as one card per
// row (the row's question as the card heading, each approach as a labelled line), so there is no sideways scroll.
// The ARIA roles restore the table semantics that `display: block` removes in some browsers.

// Renders `code` spans: text between backtick pairs becomes <code>.
export function Rich({ text }: { text: string }): ReactNode {
  return text.split("`").map((part, i) => (i % 2 === 1 ? <code key={part + i}>{part}</code> : part));
}

export function CompareHero() {
  return (
    <header className="phero wrap">
      <p className="lbl">[ {COMPARE_PAGE.kicker} ]</p>
      <h1 id="compare-h1">{COMPARE_PAGE.heading}</h1>
      <p className="sub">{COMPARE_PAGE.lede}</p>
    </header>
  );
}

export function CompareFig() {
  return (
    <section className="sec" aria-labelledby="compare-fig-h">
      <div className="wrap">
        <figure className="fig">
          <span className="lbl">
            [ <span className="figno" /> · {COMPARE_PAGE.figLabel} ]
          </span>
          <h2 id="compare-fig-h" className="sr">
            {COMPARE_PAGE.figLabel}
          </h2>
          <table className={s.tbl} role="table">
            <thead role="rowgroup" className={s.head}>
              <tr role="row">
                <th role="columnheader" scope="col">
                  <span className="sr">Question</span>
                </th>
                {APPROACHES.map((a, i) => (
                  <th key={a} role="columnheader" scope="col" className={i === APPROACHES.length - 1 ? s.us : undefined}>
                    <Rich text={a} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody role="rowgroup">
              {COMPARE_ROWS.map((r) => (
                <tr key={r.label} role="row">
                  <th role="rowheader" scope="row" className={s.q}>
                    {r.label}
                  </th>
                  {r.cells.map((c, i) => (
                    <td
                      key={APPROACHES[i]}
                      role="cell"
                      className={i === r.cells.length - 1 ? s.us : undefined}
                      data-label={APPROACHES[i].replaceAll("`", "")}
                    >
                      <Rich text={c} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <figcaption>
            {COMPARE_PAGE.caption} <a href={README_URL}>{COMPARE_PAGE.captionLink}</a> {COMPARE_PAGE.captionEnd}
          </figcaption>
        </figure>
      </div>
    </section>
  );
}

export function WhenFits() {
  return (
    <section className="sec" aria-labelledby="fits-h">
      <div className="wrap">
        <h2 id="fits-h">{FITS.heading}</h2>
        <ul className={s.list}>
          {FITS.items.map((f) => (
            <li key={f.lead}>
              <strong>{f.lead}</strong>
              {f.text}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

export function Limits() {
  return (
    <section className="sec" aria-labelledby="limits-h">
      <div className="wrap">
        <h2 id="limits-h">{LIMITS.heading}</h2>
        <ul className={s.list}>
          {LIMITS.items.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      </div>
    </section>
  );
}
