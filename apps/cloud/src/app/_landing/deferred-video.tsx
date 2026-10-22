"use client";

import { useState } from "react";

type Props = {
  poster: string;
  width: number;
  height: number;
  /** Rows shown from the top; the rest of the frame (Claude Code's slash-command menu) is cropped off. */
  visibleHeight: number;
  label: string;
  webm: string;
  mp4: string;
  /** The frame's lines as text, shown instead of the still under 640 px. */
  excerpt: string;
};

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-canvas";

// The final-answer frame shows as a plain image first, so no player controls or fade cover the
// last lines of the answer and the frame reads with nothing playing. It is lazy (below the first
// screen), so its bytes do not compete with the first paint. The recording loads only when the
// reader asks for it, then plays muted with controls; nothing ever autoplays on its own, so reduced
// motion has nothing to stop. The still is cropped by its box (explicit aspect ratio, no layout shift); the
// playing video is shown whole, controls included.
// Under 640 px the still would be too small to read, so the same lines show as real text instead (the
// hidden still is lazy and never loads there). The page never scrolls sideways.
export function DeferredVideo({ poster, width, height, visibleHeight, label, webm, mp4, excerpt }: Props) {
  const [playing, setPlaying] = useState(false);
  const media = "block w-full h-auto";

  return (
    // From sm up, a paper matte frames the dark terminal recording so it reads as an inset still on the page.
    <div className="mt-3 sm:max-w-[1046px] sm:rounded-card sm:border sm:border-line sm:bg-sunken sm:p-2">
      {playing ? null : (
        <pre className="sm:hidden rounded-card border border-line-strong bg-sunken px-4 py-3 font-mono font-normal text-body-sm text-ink-2 whitespace-pre-wrap [overflow-wrap:anywhere]">
          {excerpt}
        </pre>
      )}
      <div
        className={`${playing ? "block" : "hidden sm:block"} max-w-[1028px] overflow-hidden rounded-card border border-line-strong bg-sunken`}
        // The player is shown whole: its controls sit along the bottom edge.
        style={{ aspectRatio: `${width} / ${playing ? height : visibleHeight}` }}
      >
        {playing ? (
          <video
            className={media}
            style={{ aspectRatio: `${width} / ${height}` }}
            width={width}
            height={height}
            aria-label={label}
            poster={poster}
            controls
            muted
            playsInline
            autoPlay
          >
            <source src={webm} type="video/webm" />
            <source src={mp4} type="video/mp4" />
          </video>
        ) : (
          // biome-ignore lint/performance/noImgElement: a static, pre-sized webp below the fold; next/image adds nothing here
          <img
            src={poster}
            alt={label}
            width={width}
            height={height}
            loading="lazy"
            decoding="async"
            className={media}
            style={{ aspectRatio: `${width} / ${height}` }}
          />
        )}
      </div>
      {playing ? null : (
        <button
          type="button"
          onClick={() => setPlaying(true)}
          className={`mt-2 inline-flex items-center min-h-11 px-3 rounded-sm border border-line text-body-sm text-ink-2 hover:text-ink hover:border-line-strong ${focusRing}`}
        >
          Play the recording
        </button>
      )}
    </div>
  );
}
