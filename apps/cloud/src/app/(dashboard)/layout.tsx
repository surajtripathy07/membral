import { IBM_Plex_Sans, Source_Serif_4 } from "next/font/google";
import { headers } from "next/headers";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { FeatureDisabledNotice } from "@/components/feature-disabled-notice";
import { TimezoneSync } from "@/components/timezone-sync";
import { checkFeature } from "@/lib/feature-flags";
import { createClient } from "@/lib/supabase/server";
import { Sidebar } from "./sidebar";

// Real italics for the signed-in app only. The root layout loads upright faces so the signed-out
// landing does not download italic files it never uses; here the italic faces are declared as their
// own families with preload: false, so a file is requested the first time italic text is painted.
// A family with only italic faces would also match upright text, so the families are applied to
// `.italic` only (the utility the dashboard uses), ahead of the normal stack.
const plexSansItalic = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  style: ["italic"],
  preload: false,
});
const sourceSerifItalic = Source_Serif_4({
  subsets: ["latin"],
  style: ["italic"],
  preload: false,
});
const ITALIC_CSS = `.italic,em,i{font-family:${plexSansItalic.style.fontFamily},var(--font-sans)}.font-serif.italic,h1.italic,h2.italic,h3.italic{font-family:${sourceSerifItalic.style.fontFamily},var(--font-serif)}`;

/**
 * The flagged-off notice (issue #127/#128). #173: checkFeature is up to four
 * serial reads (flag row, app mode/allowlist, lifetime and 24h spend), and
 * this layout wraps every dashboard page — awaiting it here held back every
 * page's first byte. It now streams inside its own Suspense boundary
 * (fallback: nothing, which is also what an allowed user sees), so the
 * shell and the page render without waiting for it.
 */
async function LlmDisabledNotice({ userId }: { userId: string }) {
  const llmCheck = await checkFeature(userId, "llm");
  if (llmCheck.allowed) return null;
  return (
    <div className="mx-auto w-full max-w-6xl px-4 pt-6 lg:px-6">
      <FeatureDisabledNotice check={llmCheck} />
    </div>
  );
}

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    // L6 (adversarial review): middleware's own unauthenticated-redirect
    // already carries ?next=... (see src/middleware.ts) so a normal
    // full-page load returns here after login. But a client-side
    // navigation INTO a (dashboard) route whose session has since expired
    // never re-runs middleware's redirect logic on the client — it lands
    // straight on this layout's own check, which used to always drop to a
    // bare "/login" and lose the destination. Next's app-router client sets
    // a `next-url` request header (app-router-headers.js's NEXT_URL) to the
    // path being navigated to on exactly that kind of request, so recover
    // it from there when present; a hard reload/first load has no such
    // header, so this falls back to the pre-existing plain "/login"
    // (matching middleware's own root-relative-only guard: reject a value
    // that isn't "/..." or is protocol-relative "//...").
    const requestHeaders = await headers();
    const nextPath = requestHeaders.get("next-url");
    const next = nextPath?.startsWith("/") && !nextPath.startsWith("//") ? nextPath : null;
    redirect(next ? `/login?next=${encodeURIComponent(next)}` : "/login");
  }

  // issue #127: this used to live only on the now-deleted (dashboard)/page.tsx
  // (dead code — "/" never rendered it, see src/middleware.ts's old
  // unconditional "/" redirect). Hoisted to the shared layout so a
  // flagged-off user still sees it no matter which dashboard page they land
  // on first, not just a page nobody could ever reach.

  return (
    <div className="flex min-h-screen">
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: a fixed string built from next/font family names */}
      <style dangerouslySetInnerHTML={{ __html: ITALIC_CSS }} />
      <TimezoneSync />
      <Sidebar email={user.email ?? ""} />
      {/* UX W5: no padding here — PageFrame (components/ui/page-frame.tsx) pads every page once. */}
      <main className="min-w-0 flex-1 overflow-auto">
        <Suspense fallback={null}>
          <LlmDisabledNotice userId={user.id} />
        </Suspense>
        {children}
      </main>
    </div>
  );
}
