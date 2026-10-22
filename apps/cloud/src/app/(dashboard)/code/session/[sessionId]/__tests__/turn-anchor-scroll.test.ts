// Deep links to `#turn-N` must open the enclosing <details>, scroll, and flash.
import { describe, expect, it, vi } from "vitest";
import {
  ANCHOR_MS,
  anchorFor,
  HIGHLIGHT_CLASSES,
  HIGHLIGHT_MS,
  MARK_CLASSES,
  revealHashTarget,
  revealWhenReady,
  WAIT_MS,
} from "../turn-anchor-scroll";

interface FakeEl {
  tagName: string;
  parentElement: FakeEl | null;
  open: boolean;
  classes: Set<string>;
  classList: { add(...c: string[]): void; remove(...c: string[]): void };
  scrollIntoView: ReturnType<typeof vi.fn>;
  descendants: FakeEl[];
  querySelectorAll: (selector: string) => FakeEl[];
}

function el(tagName: string, parentElement: FakeEl | null = null): FakeEl {
  const classes = new Set<string>();
  const descendants: FakeEl[] = [];
  const self: FakeEl = {
    tagName,
    parentElement,
    open: false,
    classes,
    classList: {
      add: (...c: string[]) => c.forEach((x) => classes.add(x)),
      remove: (...c: string[]) => c.forEach((x) => classes.delete(x)),
    },
    scrollIntoView: vi.fn(),
    descendants,
    querySelectorAll: (selector: string) =>
      descendants.filter((d) => d.tagName.toLowerCase() === selector.toLowerCase()),
  };
  for (let p = parentElement; p; p = p.parentElement) p.descendants.push(self);
  return self;
}

function doc(ids: Record<string, FakeEl>) {
  return { getElementById: (id: string) => ids[id] ?? null };
}

describe("revealHashTarget", () => {
  it("opens every ancestor <details>, scrolls, and highlights then clears", () => {
    const outer = el("details");
    const mid = el("div", outer);
    const inner = el("DETAILS", mid);
    const target = el("div", inner);
    const later: Array<() => void> = [];
    const out = revealHashTarget(doc({ "turn-27": target }), "#turn-27", (fn) => later.push(fn));
    expect(out).toBe(target);
    expect(outer.open).toBe(true);
    expect(inner.open).toBe(true);
    expect(mid.open).toBe(false);
    expect(target.scrollIntoView).toHaveBeenCalledWith({ block: "start" });
    for (const c of HIGHLIGHT_CLASSES) expect(target.classes.has(c)).toBe(true);
    later.forEach((fn) => {
      fn();
    });
    // The flash clears; the accent left rule stays so the turn can be found again.
    expect([...target.classes]).toEqual([...MARK_CLASSES]);
  });

  it("opens a closed <details> nested INSIDE the target (a collapsed tool call), so its action text shows", () => {
    const target = el("div");
    const toolCall = el("details", target); // e.g. a Bash call showing only "Bash" collapsed
    const later: Array<() => void> = [];
    const out = revealHashTarget(doc({ "turn-40": target }), "#turn-40", (fn) => later.push(fn));
    expect(out).toBe(target);
    expect(toolCall.open).toBe(true);
    for (const c of MARK_CLASSES) expect(target.classes.has(c)).toBe(true);
  });

  it("is a no-op for an empty or unknown hash", () => {
    const d = doc({});
    expect(revealHashTarget(d, "", () => {})).toBeNull();
    expect(revealHashTarget(d, "#", () => {})).toBeNull();
    expect(revealHashTarget(d, "#turn-9", () => {})).toBeNull();
  });

  it("decodes percent-encoded ids and tolerates malformed encoding", () => {
    const t = el("div");
    expect(revealHashTarget(doc({ "turn 1": t }), "#turn%201", () => {})).toBe(t);
    const bad = el("div");
    expect(revealHashTarget(doc({ "%E0": bad }), "#%E0", () => {})).toBe(bad);
  });
});

describe("revealWhenReady (long sessions, slow cold loads)", () => {
  function harness() {
    const queue: Array<{ at: number; fn: () => void }> = [];
    let now = 0;
    const dom = new Set<() => void>();
    const resize = new Set<() => void>();
    const user = new Set<() => void>();
    const visible = new Set<() => void>();
    const state = { hidden: false };
    const ids: Record<string, FakeEl & { getBoundingClientRect?: () => { top: number } }> = {};
    const sub = (set: Set<() => void>) => (cb: () => void) => {
      set.add(cb);
      return () => set.delete(cb);
    };
    const env = {
      doc: doc(ids),
      schedule: (fn: () => void, ms: number) => void queue.push({ at: now + ms, fn }),
      onDomChange: sub(dom),
      onResize: sub(resize),
      onUserScroll: sub(user),
      isHidden: () => state.hidden,
      onVisible: sub(visible),
    };
    return {
      env,
      ids,
      dom,
      resize,
      user,
      visible,
      state,
      fire: (set: Set<() => void>) => [...set].forEach((cb) => cb()),
      advance(ms: number) {
        const until = now + ms;
        for (;;) {
          queue.sort((x, y) => x.at - y.at);
          const next = queue[0];
          if (!next || next.at > until) break;
          queue.shift();
          now = next.at;
          next.fn();
        }
        now = until;
      },
    };
  }
  const far = () => Object.assign(el("div"), { getBoundingClientRect: vi.fn(() => ({ top: 3174 })) });

  it("waits on DOM changes (not a short retry budget): a target rendered 16 s into a cold load is revealed, flashed and marked", () => {
    const h = harness();
    revealWhenReady(h.env, "#turn-111");
    h.advance(16_000);
    h.fire(h.dom); // unrelated streaming — still no target
    expect(h.dom.size).toBe(1);
    const target = far();
    h.ids["turn-111"] = target;
    h.fire(h.dom);
    expect(target.scrollIntoView).toHaveBeenCalledTimes(1);
    for (const c of [...HIGHLIGHT_CLASSES, ...MARK_CLASSES]) expect(target.classes.has(c)).toBe(true);
    expect(h.dom.size).toBe(0); // stopped observing
    h.advance(HIGHLIGHT_MS);
    for (const c of HIGHLIGHT_CLASSES) expect(target.classes.has(c)).toBe(false);
    for (const c of MARK_CLASSES) expect(target.classes.has(c)).toBe(true); // the left rule stays
  });

  it("re-anchors on layout shifts for ANCHOR_MS, then lets go", () => {
    const h = harness();
    const target = far();
    h.ids["turn-111"] = target;
    revealWhenReady(h.env, "#turn-111");
    h.advance(1500); // 300 ms + 1 s re-checks both re-scroll (still far)
    expect(target.scrollIntoView).toHaveBeenCalledTimes(3);
    h.fire(h.resize); // lazy content above pushed it down
    expect(target.scrollIntoView).toHaveBeenCalledTimes(4);
    h.advance(ANCHOR_MS);
    expect(h.resize.size).toBe(0);
    h.fire(h.resize);
    expect(target.scrollIntoView).toHaveBeenCalledTimes(4);
  });

  it("a user scroll (wheel / touch / key) cancels re-anchoring at once", () => {
    const h = harness();
    const target = far();
    h.ids["turn-111"] = target;
    revealWhenReady(h.env, "#turn-111");
    h.fire(h.user);
    expect(h.resize.size).toBe(0);
    h.advance(2000);
    expect(target.scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it("a background tab: nothing runs (no budget spent, no flash) until the tab is shown", () => {
    const h = harness();
    h.state.hidden = true;
    revealWhenReady(h.env, "#turn-385");
    expect(h.dom.size).toBe(0); // not waiting on the DOM yet
    h.advance(WAIT_MS * 3); // the user leaves it in the background for a minute
    const target = far();
    h.ids["turn-385"] = target;
    expect(target.scrollIntoView).not.toHaveBeenCalled();
    h.state.hidden = false;
    h.fire(h.visible);
    expect(target.scrollIntoView).toHaveBeenCalledTimes(1);
    for (const c of [...HIGHLIGHT_CLASSES, ...MARK_CLASSES]) expect(target.classes.has(c)).toBe(true);
    expect(h.visible.size).toBe(0);
  });

  it("shown before the turn rendered: the wait budget starts when the tab is shown", () => {
    const h = harness();
    h.state.hidden = true;
    revealWhenReady(h.env, "#turn-5");
    h.advance(WAIT_MS * 2);
    h.state.hidden = false;
    h.fire(h.visible);
    h.advance(WAIT_MS - 1000);
    const target = far();
    h.ids["turn-5"] = target;
    h.fire(h.dom);
    expect(target.scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it("review r2 S4: the user scrolls before the target renders — it is opened and marked, never scrolled to", () => {
    const h = harness();
    revealWhenReady(h.env, "#turn-111");
    h.fire(h.user); // reading while the page streams in
    const target = far();
    h.ids["turn-111"] = target;
    h.fire(h.dom);
    expect(target.scrollIntoView).not.toHaveBeenCalled();
    for (const c of MARK_CLASSES) expect(target.classes.has(c)).toBe(true);
    h.fire(h.resize);
    h.advance(2000);
    expect(target.scrollIntoView).not.toHaveBeenCalled();
    expect(h.user.size).toBe(0);
  });

  it("gives up after WAIT_MS when the target never renders; an empty anchor does nothing", () => {
    const h = harness();
    revealWhenReady(h.env, "#turn-9");
    h.advance(WAIT_MS);
    expect(h.dom.size).toBe(0);
    const h2 = harness();
    revealWhenReady(h2.env, "");
    expect(h2.dom.size).toBe(0);
  });

  it("anchorFor: the hash wins; ?turn=N stands in when the hash was dropped; nothing otherwise", () => {
    expect(anchorFor("#turn-3", 9)).toBe("#turn-3");
    expect(anchorFor("", 9)).toBe("#turn-9");
    expect(anchorFor("", null)).toBe("");
  });
});

describe("preHydrationRevealScript", () => {
  it("scrolls the live target before hydration: waits out React's hidden stream buffer, opens <details>", async () => {
    const { preHydrationRevealScript } = await import("../turn-anchor-scroll");
    const hiddenBuf = { tagName: "DIV", parentElement: null, hasAttribute: (a: string) => a === "hidden" };
    const details = { tagName: "DETAILS", parentElement: null, open: false, hasAttribute: () => false };
    // A collapsed tool call (e.g. Bash) nested INSIDE the target turn — must open too.
    const innerToolCall = { tagName: "DETAILS", open: false };
    const target = {
      tagName: "DIV",
      parentElement: hiddenBuf as unknown,
      isConnected: true,
      hasAttribute: () => false,
      scrollIntoView: vi.fn(),
      querySelectorAll: (selector: string) => (selector === "details" ? [innerToolCall] : []),
    };
    const timers: Array<() => void> = [];
    const run = new Function("location", "document", "setTimeout", "addEventListener", preHydrationRevealScript(111));
    const listeners: Array<() => void> = [];
    const doc = {
      visibilityState: "hidden",
      getElementById: (id: string) => (id === "turn-111" ? target : null),
      addEventListener: (_: string, fn: () => void) => listeners.push(fn),
      removeEventListener: () => {},
    };
    const userListeners: Array<() => void> = [];
    run(
      { hash: "" },
      doc,
      (fn: () => void) => timers.push(fn),
      (_: string, fn: () => void) => userListeners.push(fn),
    );
    // Background tab: nothing is scheduled until it is shown.
    expect(timers).toHaveLength(0);
    doc.visibilityState = "visible";
    listeners.forEach((fn) => {
      fn();
    });
    expect(target.scrollIntoView).not.toHaveBeenCalled(); // still in the hidden buffer
    target.parentElement = details;
    timers.shift()?.();
    expect(details.open).toBe(true);
    expect(innerToolCall.open).toBe(true);
    expect(target.scrollIntoView).toHaveBeenCalledWith({ block: "start" });
  });
});

describe("preHydrationRevealScript (review r2 S4)", () => {
  it("does not scroll once the user has moved; still opens <details>", async () => {
    const { preHydrationRevealScript } = await import("../turn-anchor-scroll");
    const details = { tagName: "DETAILS", parentElement: null, open: false, hasAttribute: () => false };
    const target = {
      tagName: "DIV",
      parentElement: null as unknown,
      isConnected: true,
      hasAttribute: () => false,
      scrollIntoView: vi.fn(),
    };
    const timers: Array<() => void> = [];
    const userListeners: Array<() => void> = [];
    const run = new Function("location", "document", "setTimeout", "addEventListener", preHydrationRevealScript(111));
    const doc = {
      visibilityState: "visible",
      getElementById: (id: string) => (id === "turn-111" && target.parentElement ? target : null),
    };
    run(
      { hash: "" },
      doc,
      (fn: () => void) => timers.push(fn),
      (_: string, fn: () => void) => userListeners.push(fn),
    );
    userListeners.forEach((fn) => {
      fn();
    });
    target.parentElement = details;
    timers.shift()?.();
    expect(details.open).toBe(true);
    expect(target.scrollIntoView).not.toHaveBeenCalled();
  });
});
