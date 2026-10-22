"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { ThemeSwitch } from "@/components/theme-switch";
import { logout } from "../(auth)/actions";
import { BrandMark } from "@/components/brand-mark";

const MOBILE_SIDEBAR_ID = "mobile-sidebar";

// UX audit B7 (supersedes the W9 order): Today is the landing route
// (middleware sends "/" to /pulse), so it leads the primary nav. Chats sits
// below Memory — it is the second-ranked lane. Setup, Settings and Sign out
// form the footer. "/code" stays active on every /code/* route except
// /code/stats (Usage has its own entry).
const navItems = [
  { href: "/pulse", label: "Today", icon: PulseIcon },
  { href: "/code", label: "Sessions", icon: CodeIcon },
  { href: "/code/stats", label: "Usage", icon: UsageIcon },
  { href: "/memories", label: "Memory", icon: BrainIcon },
  { href: "/conversations", label: "Chats", icon: ChatIcon },
  { href: "/search", label: "Search", icon: SearchIcon },
];

const footerItems = [
  { href: "/setup", label: "Setup", icon: SetupIcon },
  { href: "/settings", label: "Settings", icon: GearIcon },
];

/** Whether `href` is the current section: "/code" covers /code/* except /code/stats (Usage). */
export function isNavActive(href: string, pathname: string): boolean {
  if (href === "/code") return (pathname === "/code" || pathname.startsWith("/code/")) && !pathname.startsWith("/code/stats");
  return pathname === href || pathname.startsWith(`${href}/`);
}

const ITEM_BASE =
  "relative flex items-center gap-3 rounded-sm border-l-2 px-3 py-2 text-body transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface";
const ITEM_ACTIVE = "border-accent bg-accent-soft font-medium text-accent";
const ITEM_IDLE = "border-transparent font-normal text-muted hover:bg-raised hover:text-ink";

export function Sidebar({ email }: { email: string }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  // Below `lg` the sidebar is a drawer (CSS `-translate-x-full` when closed);
  // at `lg`+ it's always visible regardless of `open` (`lg:translate-x-0`).
  // `inert`/`aria-hidden` must track that CSS reality, not just `open` —
  // defaulting to "desktop" avoids inerting the always-visible sidebar
  // during SSR/hydration on a wide viewport, and a mounted-effect corrects
  // it immediately for a narrow one.
  const [isDesktop, setIsDesktop] = useState(true);

  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const update = () => setIsDesktop(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  // Escape closes the drawer from anywhere while it's open.
  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  const drawerHidden = !isDesktop && !open;

  return (
    <>
      {/* Mobile topbar */}
      <div className="fixed top-0 left-0 right-0 z-30 flex h-14 items-center border-b border-line bg-surface px-4 lg:hidden">
        <button
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          aria-controls={MOBILE_SIDEBAR_ID}
          className="rounded-sm p-2 text-muted hover:bg-raised hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
          aria-label="Toggle menu"
        >
          <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            {open ? (
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            ) : (
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            )}
          </svg>
        </button>
        <span className="ml-3 flex items-center gap-2 text-body font-semibold text-ink">
          <BrandMark className="h-5 w-5 text-accent" />
          <span className="font-serif text-lead">Membral</span>
        </span>
      </div>

      {/* Mobile overlay — a real button (keyboard-reachable, sr-only label), not a bare div onClick. */}
      {open && (
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="fixed inset-0 z-30 bg-ink/30 lg:hidden"
        >
          <span className="sr-only">Close menu</span>
        </button>
      )}

      {/* Sidebar */}
      <aside
        id={MOBILE_SIDEBAR_ID}
        inert={drawerHidden || undefined}
        aria-hidden={drawerHidden || undefined}
        className={`fixed top-0 left-0 z-40 flex h-full w-64 shrink-0 flex-col border-r border-line bg-surface transition-transform lg:sticky lg:h-screen lg:translate-x-0 ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        {/* Logo */}
        <div className="flex h-14 items-center gap-2.5 border-b border-line px-4">
          {/* Inline lockup, not /logo.svg: the file hard-codes a dark-only palette; this follows the theme tokens. */}
          <BrandMark className="h-5 w-5 text-accent" />
          <span className="font-serif text-lead font-semibold text-ink">Membral</span>
        </div>

        {/* Nav */}
        <nav className="flex-1 space-y-1 p-3">
          {navItems.map(({ href, label, icon: Icon }) => {
            const isActive = isNavActive(href, pathname);
            return (
              <Link
                key={href}
                href={href}
                onClick={() => setOpen(false)}
                aria-current={isActive ? "page" : undefined}
                className={`${ITEM_BASE} ${isActive ? ITEM_ACTIVE : ITEM_IDLE}`}
              >
                <Icon className="h-5 w-5 shrink-0" />
                {label}
              </Link>
            );
          })}
        </nav>

        {/* Footer */}
        <div className="border-t border-line p-3">
          {footerItems.map(({ href, label, icon: Icon }) => {
            const isActive = isNavActive(href, pathname);
            return (
              <Link
                key={href}
                href={href}
                onClick={() => setOpen(false)}
                aria-current={isActive ? "page" : undefined}
                className={`${ITEM_BASE} ${isActive ? ITEM_ACTIVE : ITEM_IDLE}`}
              >
                <Icon className="h-5 w-5 shrink-0" />
                {label}
              </Link>
            );
          })}
          <form action={logout}>
            <button
              type="submit"
              className={`${ITEM_BASE} w-full ${ITEM_IDLE}`}
            >
              <LogoutIcon className="h-5 w-5 shrink-0" />
              Sign out
            </button>
          </form>
          <ThemeSwitch />
          <span className="sr-only">{email}</span>
        </div>
      </aside>

      {/* Spacer for mobile topbar */}
      <div className="h-14 lg:hidden" />
    </>
  );
}

// --- Inline SVG icons ---

function PulseIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 12h4l3 8 4-16 3 8h4" />
    </svg>
  );
}

function CodeIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 8l-5 4 5 4m6-8l5 4-5 4M13 5l-2 14" />
    </svg>
  );
}

function UsageIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 20V10m6 10V4m6 16v-7" />
    </svg>
  );
}

function ChatIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
        d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
      />
    </svg>
  );
}

function SearchIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
    </svg>
  );
}

function GearIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
        d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.573-1.066z"
      />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  );
}

function BrainIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
        d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"
      />
    </svg>
  );
}

function SetupIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 6v12m6-6H6" />
      <circle cx="12" cy="12" r="9" strokeWidth={1.5} />
    </svg>
  );
}

function LogoutIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
        d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"
      />
    </svg>
  );
}
