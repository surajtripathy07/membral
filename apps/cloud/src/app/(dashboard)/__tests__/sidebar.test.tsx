// D9 (goal 2026-08-27, "a memory is one thing"): the Legacy nav group
// (/map, /people, /portrait — all kg_nodes/kg_edges-backed) was removed from
// the sidebar along with the pages themselves. This test locks the nav shape
// down so a future PR can't silently re-add a "Legacy" group or a link back
// into a route that no longer exists — renderToStaticMarkup pattern
// established in pulse-content.test.tsx / portrait-content.test.tsx.
//
// W9 (2026-09-12 refocus goal, D9): nav collapsed to 6 session-first items,
// no showCode count gate. "Today" (/pulse) and "Setup" moved to the footer
// group; "Import" left the nav entirely (reachable from the /code and
// /conversations empty states instead — see brief.md).
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const pathname = vi.hoisted(() => ({ current: "/code" }));
vi.mock("next/navigation", () => ({
  usePathname: vi.fn(() => pathname.current),
}));
vi.mock("../../(auth)/actions", () => ({
  logout: vi.fn(),
}));

import { isNavActive, Sidebar } from "../sidebar";

// Routes deleted alongside the Legacy nav group (D9) — all previously
// read kg_nodes/kg_edges, which the 2026-07-26 sign-off decided not to
// rebuild (ADR 0030 D1). "/bridge" joined this list when the bridge was
// deleted (2026-09-12 refocus goal's kill list).
const REMOVED_ROUTES = ["/map", "/people", "/portrait", "/graph", "/bridge"];

// UX audit B7: Today leads (it is the landing route), Chats sits below
// Memory (second lane). "/setup" and "/settings" are the footer group,
// rendered after the primary nav; "Sign out" is a <form>, not an <a href>, so
// it never shows up in hrefsIn().
const EXPECTED_NAV_ITEMS = ["/pulse", "/code", "/code/stats", "/memories", "/conversations", "/search"];
const FOOTER_ITEMS = ["/setup", "/settings"];
const EXPECTED_ITEMS = [...EXPECTED_NAV_ITEMS, ...FOOTER_ITEMS];

// React's SSR automatically emits a `<link rel="preload" as="image" href=...>`
// for every rendered `<img>` (image preload hints) — this only matches an
// actual `<a href=...>` so the sidebar's own logo <img> doesn't masquerade
// as a nav link.
function hrefsIn(html: string): string[] {
  return [...html.matchAll(/<a[^>]*\shref="([^"]+)"/g)].map((m) => m[1]);
}

describe("Sidebar nav", () => {
  it("renders exactly 6 primary nav items plus the footer group, in order", () => {
    const html = renderToStaticMarkup(<Sidebar email="owner@example.com" />);
    expect(hrefsIn(html)).toEqual(EXPECTED_ITEMS);
  });

  it("has at most 6 primary nav items (D9 budget)", () => {
    const html = renderToStaticMarkup(<Sidebar email="owner@example.com" />);
    const hrefs = hrefsIn(html);
    const primary = hrefs.filter((h) => !FOOTER_ITEMS.includes(h));
    expect(primary.length).toBeLessThanOrEqual(6);
    expect(primary).toEqual(EXPECTED_NAV_ITEMS);
  });

  it("has no Legacy nav group", () => {
    const html = renderToStaticMarkup(<Sidebar email="owner@example.com" />);
    expect(html).not.toContain("Legacy");
  });

  it("has no item href pointing at a removed (graph) route", () => {
    const html = renderToStaticMarkup(<Sidebar email="owner@example.com" />);
    const hrefs = hrefsIn(html);
    for (const removed of REMOVED_ROUTES) {
      expect(hrefs).not.toContain(removed);
    }
  });

  it("does not print the account email as visible page content", () => {
    const html = renderToStaticMarkup(<Sidebar email="owner@example.com" />);
    // The email is retained only for assistive tech (sr-only), never as a
    // visible decoration on every dashboard screenshot.
    expect(html).toContain('class="sr-only"');
  });

  it("marks Today active on /pulse, and only Today", () => {
    pathname.current = "/pulse";
    const html = renderToStaticMarkup(<Sidebar email="owner@example.com" />);
    pathname.current = "/code";
    const active = [...html.matchAll(/<a[^>]*aria-current="page"[^>]*href="([^"]+)"|<a[^>]*href="([^"]+)"[^>]*aria-current="page"/g)].map(
      (m) => m[1] ?? m[2],
    );
    expect(active).toEqual(["/pulse"]);
  });

  it("Sessions stays active under /code/* but not on Usage", () => {
    expect(isNavActive("/code", "/code/session/abc")).toBe(true);
    expect(isNavActive("/code", "/code/stats")).toBe(false);
    expect(isNavActive("/code/stats", "/code/stats/issues")).toBe(true);
  });

  it("the rail is sticky and full-height on desktop", () => {
    const html = renderToStaticMarkup(<Sidebar email="owner@example.com" />);
    expect(html).toContain("lg:sticky");
    expect(html).toContain("lg:h-screen");
  });
});
