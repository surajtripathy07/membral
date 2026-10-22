"use client";

// One dashboard-wide mount (issue #166): writes the membral_tz cookie from
// the browser's own IANA zone (Intl.DateTimeFormat().resolvedOptions()) so
// every server-rendered day boundary — the /code pages' 30-day cost strip,
// /api/agent-stats via cost-line.tsx — buckets by the viewer's clock, not
// the server process's. Same "client writes, server reads" shape as
// theme-switch.tsx's membral_theme cookie, but headless: it only calls
// router.refresh() once, when the cookie was missing or stale (a returning
// visitor's cookie already matches almost every load, so this is a no-op
// past the very first mount or a travel/DST change).
import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { TZ_COOKIE, detectBrowserTimeZone, tzCookieString } from "@/lib/util/timezone";

function readCookie(name: string, doc: Pick<Document, "cookie"> = document): string | null {
  const m = doc.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return m ? decodeURIComponent(m[1]) : null;
}

export function TimezoneSync() {
  const router = useRouter();
  const firedRef = useRef(false);

  useEffect(() => {
    if (firedRef.current) return;
    firedRef.current = true;
    const zone = detectBrowserTimeZone();
    if (readCookie(TZ_COOKIE) === zone) return;
    document.cookie = tzCookieString(zone);
    router.refresh();
  }, [router]);

  return null;
}
