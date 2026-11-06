"use client";

import { useEffect } from "react";

// The landing's only scroll behaviour: the nav gains a hairline and a paper background after 40px, and each
// [data-reveal] element gets `.on` once, the first time it is 25% in view. The CSS hides those elements only
// when `html.js` is set (the inline script in page.tsx) and motion is allowed, so without JS or with reduced
// motion everything is already in its final state.
export function ScrollFx() {
  useEffect(() => {
    document.documentElement.classList.add("js");
    const nav = document.querySelector<HTMLElement>(".landing .navbar");
    const onScroll = () => nav?.classList.toggle("scrolled", window.scrollY > 40);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });

    const items = Array.from(document.querySelectorAll<HTMLElement>("[data-reveal]"));
    let io: IntersectionObserver | null = null;
    if ("IntersectionObserver" in window) {
      io = new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            if (!e.isIntersecting) continue;
            e.target.classList.add("on");
            io?.unobserve(e.target);
          }
        },
        { threshold: 0.25 },
      );
      for (const i of items) io.observe(i);
    } else {
      for (const i of items) i.classList.add("on");
    }
    return () => {
      window.removeEventListener("scroll", onScroll);
      io?.disconnect();
    };
  }, []);
  return null;
}
