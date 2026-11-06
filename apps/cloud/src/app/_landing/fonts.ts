import { Hanken_Grotesk, JetBrains_Mono, Newsreader } from "next/font/google";

// Landing-only type (loaded for this route's wrapper, not the dashboard): Newsreader for display (optical size
// axis), Hanken Grotesk for text, JetBrains Mono for labels, figure numbers and commands. The variables are read
// by the `.landing` block in globals.css.
const display = Newsreader({
  subsets: ["latin"],
  axes: ["opsz"],
  style: ["normal"],
  variable: "--l-font-display",
  display: "swap",
});
const text = Hanken_Grotesk({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--l-font-text",
  display: "swap",
});
const mono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "700"],
  variable: "--l-font-mono",
  display: "swap",
});

export const landingFontClass = `${display.variable} ${text.variable} ${mono.variable}`;
