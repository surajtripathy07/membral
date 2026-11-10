import localFont from "next/font/local";

// Landing-only type (loaded for this route's wrapper, not the dashboard): Newsreader for display (optical size
// axis), Hanken Grotesk for text, JetBrains Mono for labels, figure numbers and commands. The variables are read
// by the `.landing` block in globals.css.
// Vendored latin-subset woff2 files in src/fonts (SIL OFL; licences beside them). Newsreader is one variable
// file with wght 200..800 and opsz 6..72 axes.
const landingDisplay = localFont({
  src: [{ path: "../../fonts/newsreader.woff2", weight: "200 800", style: "normal" }],
  variable: "--l-font-display",
  display: "swap",
  adjustFontFallback: "Times New Roman",
  fallback: ["Georgia", "serif"],
});
const landingText = localFont({
  src: [{ path: "../../fonts/hanken-grotesk.woff2", weight: "400 600", style: "normal" }],
  variable: "--l-font-text",
  display: "swap",
  adjustFontFallback: "Arial",
  fallback: ["system-ui", "arial"],
});
const landingMono = localFont({
  src: [{ path: "../../fonts/jetbrains-mono.woff2", weight: "400 700", style: "normal" }],
  variable: "--l-font-mono",
  display: "swap",
  adjustFontFallback: false,
  fallback: ["ui-monospace", "monospace"],
});

export const landingFontClass = `${landingDisplay.variable} ${landingText.variable} ${landingMono.variable}`;
