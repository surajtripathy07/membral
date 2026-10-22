import type { Metadata } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans, Source_Serif_4 } from "next/font/google";
import { getAppUrl } from "@/lib/env";
import { log } from "@/lib/log";
import { themeBootScript } from "@/lib/theme";
import "./globals.css";

// Paper & ink type (docs/design/tokens.md): serif heads, humanist sans body,
// mono only for refs / commit shas / code. globals.css maps these variables
// onto --font-serif / --font-sans / --font-mono.
const plexSans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  style: ["normal"],
  variable: "--font-plex-sans",
});
const sourceSerif = Source_Serif_4({
  subsets: ["latin"],
  weight: ["600"],
  style: ["normal"],
  variable: "--font-source-serif",
});
const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-plex-mono",
});

// Issue #126 verification finding 7: `new URL(getAppUrl())` runs at MODULE
// scope, which Next.js evaluates during `next build` — a NEXT_PUBLIC_APP_URL
// missing its scheme (e.g. "membral.me" instead of "https://membral.me")
// throws `TypeError: Invalid URL` here and fails the whole production build
// with no indication of which env var is wrong (exactly the failure mode
// #12's validateEnvAtBoot exists to eliminate, except this one runs at build
// time, before validateEnvAtBoot's boot-time check ever gets a chance).
// `metadataBase` is optional in Next's Metadata type — falling back to
// `undefined` on a malformed URL means Next resolves relative OG/social
// image paths against the request origin instead of failing the build; the
// warning below still surfaces the misconfiguration in the build/server log.
function safeMetadataBase(): URL | undefined {
  const appUrl = getAppUrl();
  try {
    return new URL(appUrl);
  } catch {
    log.warn("layout: NEXT_PUBLIC_APP_URL is not a valid absolute URL — metadataBase left unset", {
      app_url: appUrl,
    });
    return undefined;
  }
}

const TITLE = "Membral — your coding agent remembers what past sessions found";
const DESCRIPTION =
  "Your coding agent can answer from what your past sessions found, including what nobody wrote down. Works with Claude Code, opencode, Codex and Copilot; runs fully local.";

export const metadata: Metadata = {
  metadataBase: safeMetadataBase(),
  title: TITLE,
  description: DESCRIPTION,
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    siteName: "Membral",
    type: "website",
  },
  twitter: {
    card: "summary",
    title: TITLE,
    description: DESCRIPTION,
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // The theme switch's cookie is applied by an inline <head> script before first
  // paint (no flash) instead of a server cookies() read, which made every page —
  // /privacy, /terms, /login — dynamic, and was empty on force-static /setup.
  // No cookie → no attribute → system theme. suppressHydrationWarning: the
  // script sets data-theme before React hydrates <html>.
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${plexSans.variable} ${sourceSerif.variable} ${plexMono.variable}`}
    >
      <head>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: a fixed script; no input but the allowlisted cookie values */}
        <script dangerouslySetInnerHTML={{ __html: themeBootScript() }} />
      </head>
      <body className="bg-canvas font-sans text-ink antialiased">
        {children}
      </body>
    </html>
  );
}
