"use client";

import { useEffect, useRef } from "react";
import { CaptionText } from "./caption-text";
import { HERO } from "./content";

// Fig. 1: a recorded Claude Code session replayed in HTML (once). The server renders the full final thread, and the
// CSS shows the final state unless `html.js` is set: without JS only the prompt, the answer and the "Baked for" row
// are drawn (the middle rows are omitted, never invented), so the answer is in the first view. With JS and reduced
// motion the effect shows the whole thread pinned to the answer; with JS and motion it resets the plate to the
// welcome frame, then plays the thread row by row when the plate scrolls into view. `data-live` marks that the
// effect ran, so the CSS stops drawing the pre-hydration frame. All timing goes through the DOM (no React state),
// so the markup below is never re-rendered under the animation.
// The recorded run has no MCP call (the lookup ran in the prompt hook), so none is drawn.
// The thread text is the recording itself (Claude Code, 2026-10-08, import-504-retry, with Membral), verbatim.
// It names api-client.ts:681 and api-client.policy.test.ts:696 because those were the lines on that day.

type Timers = { ticker: number | null; glyph: number | null };

export function Replay() {
  const root = useRef<HTMLElement>(null);
  const ctl = useRef<{ replay: () => void; skip: () => void }>({ replay: () => {}, skip: () => {} });

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const get = (sel: string): HTMLElement => {
      const n = el.querySelector<HTMLElement>(sel);
      if (!n) throw new Error(`replay: missing ${sel}`);
      return n;
    };
    const B = (id: string) => get(`[data-b="${id}"]`);
    const X = (id: string) => get(`[data-x="${id}"]`);
    const out = X("out");
    const cite = X("cite");
    const plate = X("plate");
    const blks = Array.from(out.querySelectorAll<HTMLElement>(".blk"));
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const CANCEL = {};
    let token = 0;
    const timers: Timers = { ticker: null, glyph: null };
    const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));
    const pin = () => {
      out.scrollTop = out.scrollHeight;
    };
    // End state: the start of the answer ("I didn't add a retry for the 504") is the top of the view, with the
    // "Baked for" row under it when it fits. When the thread is shorter than the view, scrolling stops at the end.
    // Both ends snap to a whole number of lines (the plate height is a whole number of lines in CSS), so no line
    // sits half-cut at the bottom edge of the held frame.
    const lh = () => Number.parseFloat(getComputedStyle(out).lineHeight);
    const pinEnd = () => {
      const L = lh();
      const max = out.scrollHeight - out.clientHeight;
      out.scrollTop = Math.min(Math.round(B("final").offsetTop / L) * L, Math.floor((max + 0.5) / L) * L);
    };

    const stopTimers = () => {
      if (timers.ticker !== null) clearInterval(timers.ticker);
      if (timers.glyph !== null) clearInterval(timers.glyph);
      timers.ticker = timers.glyph = null;
    };

    const showFinal = (toAnswer: boolean) => {
      token++;
      stopTimers();
      for (const b of blks) {
        b.hidden = false;
        b.style.height = "";
        b.style.overflow = "";
        b.classList.remove("live");
      }
      X("spin").hidden = true;
      X("esc").hidden = true;
      X("hint").hidden = true;
      X("eff").hidden = false;
      cite.classList.add("on");
      if (toAnswer) pinEnd();
      else out.scrollTop = 0;
    };

    // spinner
    let word = "Computing";
    let state = "";
    let hook = true;
    let cur = { r: 0, t: 0 };
    let from = { r: 0, t: 0 };
    let to = { r: 0, t: 0 };
    let rampStart = 0;
    let rampMs = 1;
    const ramp = (r: number, t: number, ms: number) => {
      from = { ...cur };
      to = { r, t };
      rampStart = performance.now();
      rampMs = Math.max(1, ms);
    };
    const fmtR = (r: number) => {
      const n = Math.round(r);
      return n < 60 ? `${n}s` : `${Math.floor(n / 60)}m ${n % 60}s`;
    };
    const fmtT = (t: number) => (t < 1000 ? `${Math.round(t)} tokens` : `${(Math.round(t / 100) / 10).toFixed(1)}k tokens`);
    const paintSpin = () => {
      const k = Math.min(1, (performance.now() - rampStart) / rampMs);
      cur = { r: from.r + (to.r - from.r) * k, t: from.t + (to.t - from.t) * k };
      X("sw").textContent = `${word}…`;
      X("sp").textContent = hook
        ? "(running UserPromptSubmit hook · 0s)"
        : `(${fmtR(cur.r)} · ↓ ${fmtT(cur.t)}${state ? ` · ${state}` : ""})`;
    };
    const startSpin = () => {
      const seq = ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"];
      let i = 4;
      X("spin").hidden = false;
      paintSpin();
      timers.glyph = window.setInterval(() => {
        i = (i + 1) % seq.length;
        X("sg").textContent = seq[i];
      }, 140);
      timers.ticker = window.setInterval(paintSpin, 100);
    };

    const reveal = async (node: HTMLElement, rate: number, A: (ms: number) => Promise<void>, onMeasured?: (n: number) => void) => {
      node.hidden = false;
      node.style.height = "auto";
      const h = node.getBoundingClientRect().height;
      const L = lh();
      const n = Math.max(1, Math.round(h / L));
      if (onMeasured) onMeasured(n);
      node.style.height = "0px";
      node.style.overflow = "hidden";
      for (let i = 1; i <= n; i++) {
        await A(1000 / rate);
        node.style.height = `${i === n ? h : i * L}px`;
        pin();
      }
      node.style.height = "";
      node.style.overflow = "";
      pin();
    };

    const toWelcome = () => {
      for (const b of blks) {
        b.style.height = "";
        b.style.overflow = "";
        b.hidden = b.dataset.b !== "header";
      }
      for (const id of ["search", "run1", "run2"]) B(id).classList.add("live");
      X("spin").hidden = true;
      X("esc").hidden = true;
      X("hint").hidden = false;
      X("eff").hidden = false;
      cite.classList.remove("on");
      out.scrollTop = 0;
    };

    const play = async () => {
      const my = ++token;
      stopTimers();
      const A = async (ms: number) => {
        await sleep(ms);
        if (my !== token) throw CANCEL;
      };
      try {
        toWelcome();
        word = "Computing";
        state = "";
        hook = true;
        cur = { r: 0, t: 0 };
        from = { r: 0, t: 0 };
        to = { r: 0, t: 0 };
        await A(600);
        X("hint").hidden = true;
        X("eff").hidden = true;
        X("esc").hidden = false;
        void reveal(B("prompt"), 30, A).catch(() => {});
        startSpin();
        await A(1100);
        hook = false;
        word = "Cultivating";
        ramp(2, 30, 400);
        await A(300);
        ramp(13, 783, 1200);
        await reveal(B("p1"), 18, A);
        state = "thinking";
        await reveal(B("search"), 18, A);
        ramp(22, 900, 1500);
        await A(1200);
        state = "thought for 8s";
        B("search").classList.remove("live");
        pin();
        ramp(29, 1300, 500);
        await reveal(B("ask"), 18, A);
        await A(250);
        // the middle of the recording (two edits, two shell runs) is condensed to about 2 s
        ramp(56, 3600, 700);
        await reveal(B("up1"), 36, A);
        await A(120);
        await reveal(B("up2"), 36, A);
        state = "";
        await reveal(B("run1"), 36, A);
        await A(220);
        B("run1").classList.remove("live");
        pin();
        ramp(70, 3700, 300);
        await reveal(B("dep"), 36, A);
        ramp(87, 3900, 500);
        await reveal(B("run2"), 36, A);
        await A(220);
        B("run2").classList.remove("live");
        pin();
        await A(200);
        await reveal(B("final"), 18, A, (n) => ramp(104, 4400, (n / 18) * 1000));
        stopTimers();
        X("spin").hidden = true;
        X("esc").hidden = true;
        X("eff").hidden = false;
        await reveal(B("done"), 18, A);
        await A(500);
        cite.classList.add("on");
        pinEnd();
      } catch (e) {
        if (e !== CANCEL) throw e;
      }
    };

    ctl.current = {
      replay: () => {
        if (!reduce) void play();
      },
      skip: () => showFinal(true),
    };

    let io: IntersectionObserver | null = null;
    let fallback = 0;
    el.dataset.live = "true";
    if (reduce) {
      showFinal(true);
      // web fonts change line heights; pin again once they are in
      void document.fonts?.ready.then(() => showFinal(true));
    } else {
      toWelcome();
      el.dataset.ready = "true";
      let started = false;
      const go = () => {
        if (started) return;
        started = true;
        io?.disconnect();
        void play();
      };
      const whenFonts = () => (document.fonts?.ready ? Promise.race([document.fonts.ready, sleep(1500)]) : Promise.resolve());
      if ("IntersectionObserver" in window) {
        io = new IntersectionObserver(
          (es) => {
            if (es.some((e) => e.isIntersecting)) void whenFonts().then(go);
          },
          { threshold: 0.35 },
        );
        io.observe(plate);
      } else {
        fallback = Number(setTimeout(go, 400));
      }
    }

    return () => {
      token++;
      stopTimers();
      io?.disconnect();
      clearTimeout(fallback);
      ctl.current = { replay: () => {}, skip: () => {} };
      delete el.dataset.ready;
      delete el.dataset.live;
    };
  }, []);

  return (
    <figure className="fig plate-fig fig1" id="fig1" aria-labelledby="fig1-cap" ref={root}>
      <div className="figbar">
        <span className="lbl">
          [ <span className="figno" /> · {HERO.kicker} ]
        </span>
        <span className="tools">
          <button type="button" onClick={() => ctl.current.replay()}>
            Replay
          </button>
          <button type="button" onClick={() => ctl.current.skip()}>
            Skip
          </button>
        </span>
      </div>
      <div className="plate" data-x="plate" aria-hidden="true">
        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be keyboard reachable */}
        <div className="out" data-x="out" tabIndex={0}>
          <div className="blk hdr" data-b="header">
            <svg viewBox="0 0 90 98" preserveAspectRatio="none" aria-hidden="true" focusable="false">
              <g fill="#D47658">
                <rect x="0" y="26" width="10" height="20" />
                <rect x="80" y="26" width="10" height="20" />
                <rect x="10" y="6" width="70" height="46" />
                <rect x="18" y="56" width="9" height="30" />
                <rect x="31" y="56" width="9" height="30" />
                <rect x="50" y="56" width="9" height="30" />
                <rect x="63" y="56" width="9" height="30" />
              </g>
              <g fill="#282A36">
                <rect x="26" y="20" width="8" height="16" />
                <rect x="56" y="20" width="8" height="16" />
              </g>
            </svg>
            <div>
              <b>Claude Code</b> <span className="dim">v2.1.295</span>
              <br />
              <span className="dim">Sonnet 5.5 · Claude API</span>
              <br />
              <span className="dim">~/dev/repo</span>
            </div>
          </div>
          <div className="blk" data-b="prompt">
            <div className="user">
              <span className="chev">❯</span>
              <span>{HERO.transcriptPrompt}</span>
            </div>
          </div>

          <div className="blk msg" data-b="p1">
            <span className="gl">
              <i className="dot" />
            </span>
            <div className="tx">
              Past sessions decided the opposite of this request, so I&apos;ll check the current code before changing
              anything.
            </div>
          </div>

          <div className="blk" data-b="search">
            <div className="v-live">
              <div className="msg">
                <span className="gl">
                  <i className="dot" />
                </span>
                <div className="tx">Searching for 504</div>
              </div>
              <div className="res">
                <span className="rg">⎿</span>
                <div>packages/cli/src/import-command.ts</div>
              </div>
            </div>
            <div className="v-done col2 dim">Searched for 1 pattern, read 3 files</div>
          </div>

          <div className="blk" data-b="ask">
            <div className="msg">
              <span className="gl">
                <i className="dot" />
              </span>
              <div className="tx">User answered Claude&apos;s questions:</div>
            </div>
            <div className="res">
              <span className="rg">⎿</span>
              <div>
                · A 504 on `membral import` is deliberately not retried today (api-client.ts:681, tested in
                api-client.policy.test.ts:696; decision recorded in D-log/design note §4). How should I proceed? → Keep
                no-retry, improve UX
              </div>
            </div>
          </div>

          <div className="blk diff" data-b="up1">
            <div className="msg">
              <span className="gl">
                <i className="dot" />
              </span>
              <div className="tx">
                <b>Update</b>(packages/cli/src/import-command.ts)
              </div>
            </div>
            <div className="res">
              <span className="rg">⎿</span>
              <div>Added 1 line, removed 1 line</div>
            </div>
            <div className="dr rmv">
              <span className="ln">89 -</span>
              <span className="dt">
                {
                  '    "Import timed out on the server (504). It is not re-sent automatically because the server may have already saved this batch — '
                }
                <em>
                  re-run `membral import` to continue; already-imported conversations are not duplicated.
                </em>
                {'",'}
              </span>
            </div>
            <div className="dr add">
              <span className="ln">89 +</span>
              <span className="dt">
                {
                  '    "Import timed out on the server (504). It is not re-sent automatically because the server may have already saved this batch — '
                }
                <em>check your dashboard, then re-run `membral import` if it is missing.</em>
                {'",'}
              </span>
            </div>
          </div>

          <div className="blk diff" data-b="up2">
            <div className="msg">
              <span className="gl">
                <i className="dot" />
              </span>
              <div className="tx">
                <b>Update</b>(packages/cli/src/__tests__/import-command.test.ts)
              </div>
            </div>
            <div className="res">
              <span className="rg">⎿</span>
              <div>Added 1 line, removed 1 line</div>
            </div>
            <div className="dr rmv">
              <span className="ln">212 -</span>
              <span className="dt">
                expect(printed).toContain(&quot;<em>re-run `membral import`</em>&quot;);
              </span>
            </div>
            <div className="dr add">
              <span className="ln">212 +</span>
              <span className="dt">
                expect(printed).toContain(&quot;<em>re-run `membral import` if it is missing</em>&quot;);
              </span>
            </div>
          </div>

          <div className="blk" data-b="run1">
            <div className="v-live">
              <div className="msg">
                <span className="gl">
                  <i className="dot" />
                </span>
                <div className="tx">Running import tests and typechecking · 7s</div>
              </div>
              <div className="res">
                <span className="rg">⎿</span>
                <div>
                  {
                    "$ cd packages/cli && npx vitest run src/__tests__/import-command.test.ts 2>&1 | tail -20; npx tsc --noEmit 2>&1 | tail -5 (8s)"
                  }
                  <br />
                  (ctrl+b to run in background)
                </div>
              </div>
            </div>
            <div className="v-done col2 dim">Ran 1 shell command</div>
          </div>

          <div className="blk msg" data-b="dep">
            <span className="gl">
              <i className="dot" />
            </span>
            <div className="tx">
              Dependencies aren&apos;t installed in this checkout, so the tests didn&apos;t run. I&apos;ll install them
              and try again.
            </div>
          </div>

          <div className="blk" data-b="run2">
            <div className="v-live">
              <div className="msg">
                <span className="gl">
                  <i className="dot" />
                </span>
                <div className="tx">Installing deps, building core, running tests and typechecking · 15s</div>
              </div>
              <div className="res">
                <span className="rg">⎿</span>
                <div>(ctrl+b to run in background)</div>
              </div>
            </div>
            <div className="v-done col2 dim">Ran 1 shell command</div>
          </div>

          <div className="blk final" data-b="final">
            <div className="msg">
              <span className="gl">
                <i className="dot" />
              </span>
              <div className="tx">
                <p>
                  <span className="lead">I didn&apos;t add a retry for the 504.</span> Earlier sessions deliberately decided against one, and you chose
                  to keep that. A 504 means the server attempt died at its time limit, so it may already have saved the
                  batch. A re-send could then duplicate it or pay for extraction twice. The no-retry rule is in{" "}
                  <span className="c">api-client.ts:681</span> and is tested in{" "}
                  <span className="c">api-client.policy.test.ts:696</span>.
                </p>
                <p>
                  Instead, a 504 on <span className="c">membral import</span> now exits with a clear message: &quot;Import
                  timed out on the server (504). It is not re-sent automatically because the server may have already saved
                  this batch — check your dashboard, then re-run <span className="c">membral import</span> if it is
                  missing.&quot; Before, it only printed <span className="c">Import failed: 504 &lt;body&gt;</span>.
                </p>
                <div className="bul">
                  <div className="li">
                    - <b>Code:</b> the new message is in <span className="c">postImportBatch</span> in{" "}
                    <span className="c">packages/cli/src/import-command.ts</span>.
                  </div>
                  <div className="li">
                    - <b>Test:</b> a new test in <span className="c">import-command.test.ts</span> checks that a 504 sends
                    one request, exits 1 and prints that message.
                  </div>
                  <div className="li">
                    - <b>Checks:</b> the <span className="c">import-command</span> tests pass (12/12) and{" "}
                    <span className="c">tsc --noEmit</span> is clean. I didn&apos;t run the full suite or{" "}
                    <span className="c">ci:local</span>.
                  </div>
                  <div className="li">
                    - <b>Not committed:</b> nothing is committed or pushed.
                  </div>
                </div>
                <p>
                  If the 504s are frequent, the cause is probably the server&apos;s route time limit, so smaller import
                  batches (<span className="c">IMPORT_BATCH_SIZE</span> is 100) or a longer limit may help more than a
                  retry.
                </p>
              </div>
            </div>
          </div>

          <div className="blk dim" data-b="done">
            <div className="msg">
              <span className="gl" style={{ color: "var(--t-dim)" }}>
                ✻
              </span>
              <div className="tx">Baked for 1m 44s · done 3:17 am</div>
            </div>
          </div>
        </div>

        <div className="dock">
          <div className="spin" data-x="spin" hidden>
            <span className="sg" data-x="sg">
              ✻
            </span>
            <span>
              <span data-x="sw">Computing…</span> <span className="sp" data-x="sp">(running UserPromptSubmit hook · 0s)</span>
            </span>
          </div>
          <div className="eff" data-x="eff">
            ◐ medium · /effort
          </div>
          <div className="rule" />
          <div className="inp">
            <span className="chev">❯</span>
            <span>
              <i className="cur" />
              <span className="hint" data-x="hint" hidden>
                Try &quot;how do I log an error?&quot;
              </span>
            </span>
          </div>
          <div className="rule" />
          <div className="foot">
            <span className="pur">
              {/* ⏵⏵ is drawn: the latin font subset lacks U+23F5 and Android has no fallback glyph for it. */}
              <svg className="ffwd" viewBox="0 0 12 7" aria-hidden="true">
                <path d="M0 0l5 3.5L0 7zM6 0l5 3.5L6 7z" fill="currentColor" />
              </svg>{" "}
              accept edits on
            </span>
            <span className="wide"> (shift+tab to cycle)</span>
            <span data-x="esc" hidden>
              {" "}
              · esc to interrupt
            </span>
            <span className="wide"> · ← for agents</span>
          </div>
        </div>
      </div>

      <div className="cite on" data-x="cite">
        <span className="ln" />
        <span className="src">[ {HERO.leader} ]</span>
      </div>

      <div className="sr">
        <p>Recorded Claude Code session. Prompt: {HERO.transcriptPrompt}</p>
        <p>
          Answer: I didn&apos;t add a retry for the 504. Earlier sessions deliberately decided against one, and you chose to
          keep that. A 504 means the server attempt died at its time limit, so it may already have saved the batch. The
          no-retry rule is in api-client.ts:681 and is tested in api-client.policy.test.ts:696. Instead, a 504 on membral
          import now exits with a clear message and the import-command tests pass. This was decided in sessions of 5 to
          6 October 2026.
        </p>
      </div>
      <figcaption id="fig1-cap">
        <CaptionText text={HERO.caption.trimEnd()} /> <a href="/proof">{HERO.captionLink}</a>
      </figcaption>
    </figure>
  );
}
