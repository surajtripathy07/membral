"use client";

import { useEffect } from "react";

// Deep links (`#turn-N`, or `?turn=N` when the hash was dropped) must land ON
// turn N, however long the session. The turn is server-rendered, but:
//   - the page streams in behind loading.tsx, so on a cold load the target
//     can appear many seconds after mount — we wait for it with a
//     MutationObserver (and window `load`), up to WAIT_MS, never a short
//     fixed retry budget;
//   - activity turns sit inside closed <details> — every ancestor is opened;
//   - content above the target keeps laying out (lazy sections, fonts), and
//     the router's own scroll can land after ours — for ANCHOR_MS after the
//     reveal, any resize of the page re-anchors the target to the top,
//     unless the user scrolls themselves (wheel / touch / key), which ends it.
// The target flashes an accent ring + tint for HIGHLIGHT_MS (started when it
// is actually revealed, so a slow load doesn't spend the flash off-screen)
// and keeps a subtle accent left rule so the eye can find it again.

export const HIGHLIGHT_CLASSES = ["ring-2", "ring-accent", "bg-accent-soft", "rounded-card"] as const;
/** Stays after the flash: an inset accent rule on the target's left edge. */
export const MARK_CLASSES = ["shadow-[inset_2px_0_0_var(--color-accent)]"] as const;
export const HIGHLIGHT_MS = 2000;
/** How long a cold load may take to render the target before we give up. */
export const WAIT_MS = 20_000;
/** How long after the reveal a layout shift re-anchors the target. */
export const ANCHOR_MS = 6000;
/** "Still at the target": its top within this many px of the viewport top. */
export const REVEAL_TOLERANCE_PX = 120;

interface ElementLike {
  tagName: string;
  parentElement: ElementLike | null;
  open?: boolean;
  classList: { add(...c: string[]): void; remove(...c: string[]): void };
  scrollIntoView(opts?: ScrollIntoViewOptions): void;
  getBoundingClientRect?: () => { top: number };
  /** Descendants matching `selector` (e.g. "details") — used to open collapsed tool-call blocks INSIDE the target. */
  querySelectorAll?: (selector: string) => Iterable<ElementLike>;
}

interface DocumentLike {
  getElementById(id: string): ElementLike | null;
}

type Unsubscribe = () => void;

/** The browser hooks the reveal needs — injected so it is testable without a DOM. */
export interface RevealEnv {
  doc: DocumentLike;
  schedule: (fn: () => void, ms: number) => unknown;
  /** Calls `cb` whenever the DOM changes (MutationObserver on the body) or the window finishes loading. */
  onDomChange: (cb: () => void) => Unsubscribe;
  /** Calls `cb` whenever the page's layout size changes (ResizeObserver on the body). */
  onResize: (cb: () => void) => Unsubscribe;
  /** Calls `cb` once the user scrolls themselves (wheel, touchstart, keydown). */
  onUserScroll: (cb: () => void) => Unsubscribe;
  /** True while the tab is in the background (timers throttled, rAF paused, nobody looking). */
  isHidden: () => boolean;
  /** Calls `cb` when the tab becomes visible. */
  onVisible: (cb: () => void) => Unsubscribe;
}

function idOf(hash: string): string | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** Reveals the element named by `hash`: opens ancestor <details>, scrolls, flashes, marks. Returns it, or null. */
export function revealHashTarget(
  doc: DocumentLike,
  hash: string,
  schedule: (fn: () => void, ms: number) => unknown = setTimeout,
  /** False once the user has scrolled themselves: open and mark, but never move the page. */
  scroll = true,
): ElementLike | null {
  const id = idOf(hash);
  if (!id) return null;
  const target = doc.getElementById(id);
  if (!target) return null;
  for (let el = target.parentElement; el; el = el.parentElement) {
    if (el.tagName.toUpperCase() === "DETAILS") el.open = true;
  }
  // The target itself may be a collapsed tool-call block (e.g. a Bash <details> showing only
  // "Bash") — open every <details> nested inside it too, so the action text is visible.
  for (const inner of target.querySelectorAll?.("details") ?? []) inner.open = true;
  if (scroll) target.scrollIntoView({ block: "start" });
  target.classList.add(...HIGHLIGHT_CLASSES, ...MARK_CLASSES);
  schedule(() => target.classList.remove(...HIGHLIGHT_CLASSES), HIGHLIGHT_MS);
  return target;
}

/** The anchor to reveal: the URL's `#…`, else `turn-N` from `?turn=N` (a link whose hash was dropped). */
export function anchorFor(hash: string, turn: number | null | undefined): string {
  if (hash && hash !== "#") return hash;
  return turn === null || turn === undefined ? "" : `#turn-${turn}`;
}

/**
 * Waits for `hash`'s target (DOM changes / window load, up to WAIT_MS), reveals
 * it, then re-anchors it on every layout change for ANCHOR_MS unless the user
 * scrolls. Returns a cancel function.
 */
export function revealWhenReady(env: RevealEnv, hash: string): () => void {
  let done = false;
  const subs: Unsubscribe[] = [];
  let unsubUser: Unsubscribe | undefined;
  const stop = () => {
    done = true;
    while (subs.length) subs.pop()?.();
    unsubUser?.();
  };
  if (!idOf(hash)) return stop;

  // Review r2 S4: the user's own scroll (wheel, touch, key, scrollbar drag) is watched from the
  // start — once they move, a late target is opened and marked but the page is never yanked.
  let userMoved = false;
  unsubUser = env.onUserScroll(() => {
    userMoved = true;
  });

  const anchor = (target: ElementLike) => {
    if (userMoved) return stop();
    const reanchor = () => {
      if (done || userMoved) return;
      const top = target.getBoundingClientRect?.().top;
      if (top !== undefined && Math.abs(top) > REVEAL_TOLERANCE_PX) target.scrollIntoView({ block: "start" });
    };
    subs.push(env.onResize(reanchor));
    subs.push(env.onUserScroll(stop));
    env.schedule(reanchor, 300);
    env.schedule(reanchor, 1000);
    env.schedule(stop, ANCHOR_MS);
  };

  const attempt = () => {
    if (done) return false;
    const target = revealHashTarget(env.doc, hash, env.schedule, !userMoved);
    if (!target) return false;
    while (subs.length) subs.pop()?.(); // stop waiting
    anchor(target);
    return true;
  };

  const start = () => {
    if (done || attempt()) return;
    subs.push(env.onDomChange(() => void attempt()));
    env.schedule(() => {
      // Still not rendered WAIT_MS after the tab was visible: give up quietly.
      if (!done && !env.doc.getElementById(idOf(hash) as string)) stop();
    }, WAIT_MS);
  };
  // A link cmd-clicked into a background tab: nobody is looking and timers
  // are throttled, so neither the wait budget nor the flash starts until the
  // tab is shown.
  if (env.isHidden()) {
    const unsub = env.onVisible(() => {
      unsub();
      start();
    });
    subs.push(unsub);
  } else start();
  return stop;
}

function browserEnv(): RevealEnv {
  return {
    doc: document as unknown as DocumentLike,
    schedule: (fn, ms) => window.setTimeout(fn, ms),
    onDomChange: (cb) => {
      const mo = new MutationObserver(() => cb());
      mo.observe(document.body, { childList: true, subtree: true });
      window.addEventListener("load", cb);
      return () => {
        mo.disconnect();
        window.removeEventListener("load", cb);
      };
    },
    onResize: (cb) => {
      if (typeof ResizeObserver === "undefined") return () => {};
      const ro = new ResizeObserver(() => cb());
      ro.observe(document.body);
      return () => ro.disconnect();
    },
    isHidden: () => document.visibilityState === "hidden",
    onVisible: (cb) => {
      const h = () => {
        if (document.visibilityState === "visible") cb();
      };
      document.addEventListener("visibilitychange", h);
      return () => document.removeEventListener("visibilitychange", h);
    },
    onUserScroll: (cb) => {
      const opts = { passive: true, once: true } as const;
      window.addEventListener("wheel", cb, opts);
      window.addEventListener("touchstart", cb, opts);
      window.addEventListener("keydown", cb, { once: true });
      // A scrollbar drag fires no wheel/touch/key event.
      window.addEventListener("pointerdown", cb, opts);
      return () => {
        window.removeEventListener("wheel", cb);
        window.removeEventListener("touchstart", cb);
        window.removeEventListener("keydown", cb);
        window.removeEventListener("pointerdown", cb);
      };
    },
  };
}

/** `turn`: the page's `?turn=N`, so a same-page navigation to another turn re-runs the reveal. */
export function TurnAnchorScroll({ turn = null }: { turn?: number | null } = {}) {
  useEffect(() => {
    let cancel: () => void = () => {};
    const reveal = () => {
      cancel();
      cancel = revealWhenReady(browserEnv(), anchorFor(window.location.hash, turn));
    };
    // A macrotask, not rAF: rAF never fires in a background tab.
    const first = window.setTimeout(reveal, 0);
    window.addEventListener("hashchange", reveal);
    return () => {
      window.clearTimeout(first);
      window.removeEventListener("hashchange", reveal);
      cancel();
    };
  }, [turn]);
  return null;
}

/**
 * Runs before hydration (plain inline script): on a cold dev load the client
 * bundle can hydrate many seconds after the windowed turns are in the DOM, and
 * the browser's own fragment scroll has already fired (the turns streamed in
 * after it, often inside a closed <details>). This waits until the target is
 * in the live tree (not in React's hidden streaming buffer), opens its
 * <details> ancestors (and any <details> nested inside it, e.g. a collapsed
 * tool call) and scrolls to it. TurnAnchorScroll then marks it and
 * keeps it anchored once hydrated. In a background tab it waits for the tab
 * to be shown before starting (and before its 20 s budget). Pure string, testable.
 */
export function preHydrationRevealScript(turn: number | null): string {
  const fallback = turn === null ? "''" : JSON.stringify(`turn-${turn}`);
  return `(function(){try{var h=location.hash.slice(1),id=h?decodeURIComponent(h):${fallback};if(!id)return;var t0,moved=false,mv=function(){moved=true};["wheel","touchstart","keydown","pointerdown"].forEach(function(n){addEventListener(n,mv,{passive:true,once:true})});function go(){t0=Date.now();tick()}if(document.visibilityState==="hidden"){var v=function(){if(document.visibilityState!=="hidden"){document.removeEventListener("visibilitychange",v);go()}};document.addEventListener("visibilitychange",v)}else go();function tick(){var e=document.getElementById(id),live=!!e;for(var p=e;live&&p;p=p.parentElement){if(p.hasAttribute&&p.hasAttribute("hidden"))live=false}if(live&&e.isConnected){for(var q=e.parentElement;q;q=q.parentElement){if(q.tagName==="DETAILS")q.open=true}var ds=e.querySelectorAll?e.querySelectorAll("details"):[];for(var i=0;i<ds.length;i++)ds[i].open=true;if(!moved)e.scrollIntoView({block:"start"});return}if(Date.now()-t0<20000)setTimeout(tick,50)}}catch(_){}})();`;
}

/** Server-rendered companion of TurnAnchorScroll: the pre-hydration reveal as an inline script. */
export function TurnAnchorBootstrap({ turn }: { turn: number | null }) {
  // biome-ignore lint/security/noDangerouslySetInnerHtml: a fixed script; the only input is a parsed integer turn
  return <script dangerouslySetInnerHTML={{ __html: preHydrationRevealScript(turn) }} />;
}
