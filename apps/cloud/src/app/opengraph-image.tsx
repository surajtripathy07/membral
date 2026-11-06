import { readFile } from "node:fs/promises";
import { ImageResponse } from "next/og";
import { HEADLINE, OG_IMAGE } from "./_landing/content";

// Link-preview card for the landing (and every route without its own): 1200 x 630, paper ground, the wordmark, the
// headline, and a small dark plate holding the prompt and the one line the agent answers with. Fonts are the landing's
// three families vendored as files in _landing/og/ (OFL), read at render time, so nothing is fetched from a third party.
// Satori renders flex layouts only and knows no CSS variables, so the paper, ink and accent values are repeated here.
export const alt = OG_IMAGE.alt;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const PAPER = "#eef0eb";
const INK = "#121410";
const ACCENT = "#2338c8";
const TERM = "#282a36";

async function font(name: string) {
  const url = new URL(`./_landing/og/${name}.woff`, import.meta.url);
  return readFile(url);
}

export default async function Image() {
  const [serif, sans, mono] = await Promise.all([
    font("newsreader-500"),
    font("hanken-grotesk-500"),
    font("jetbrains-mono-500"),
  ]);
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: "56px 72px",
        background: PAPER,
        color: INK,
        fontFamily: "Hanken",
        borderTop: `10px solid ${INK}`,
      }}
    >
      <div style={{ display: "flex", alignItems: "center" }}>
        <div style={{ width: 22, height: 22, background: ACCENT, marginRight: 16 }} />
        <div style={{ fontFamily: "Newsreader", fontSize: 44, letterSpacing: -0.5 }}>membral</div>
      </div>
      <div
        style={{
          display: "flex",
          fontFamily: "Newsreader",
          fontSize: 76,
          lineHeight: 1.06,
          letterSpacing: -1.5,
          maxWidth: 1000,
        }}
      >
        {HEADLINE}
      </div>
      <div style={{ display: "flex", flexDirection: "column", background: TERM, padding: "20px 28px", color: "#f8f8f2" }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontFamily: "Mono", fontSize: 20, color: "#999999" }}>
          <span>{"[ " + OG_IMAGE.figLabel + " ]"}</span>
          <span>Claude Code</span>
        </div>
        <div style={{ display: "flex", fontFamily: "Mono", fontSize: 24, marginTop: 12, color: "#d47658" }}>
          {"> "}
          <span style={{ color: "#f8f8f2", marginLeft: 12 }}>{OG_IMAGE.prompt}</span>
        </div>
        <div style={{ display: "flex", fontFamily: "Mono", fontSize: 28, marginTop: 14, color: "#f8f8f2" }}>
          <span style={{ width: 11, height: 11, borderRadius: 6, background: "#f8f8f2", marginRight: 16, marginTop: 11, flexShrink: 0 }} />
          <span style={{ borderBottom: `3px solid ${ACCENT}` }}>{OG_IMAGE.answerLine}</span>
        </div>
      </div>
    </div>,
    {
      ...size,
      fonts: [
        { name: "Newsreader", data: serif, weight: 500, style: "normal" },
        { name: "Hanken", data: sans, weight: 500, style: "normal" },
        { name: "Mono", data: mono, weight: 500, style: "normal" },
      ],
    },
  );
}
