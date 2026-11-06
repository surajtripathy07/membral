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

// The recorded final-answer frame, in the landing's own system (.pv in globals.css). Same behaviour as the dashboard
// proof video it replaces on /proof: a pre-sized still first (lazy, so it never competes with first paint), the clip
// loads only when asked and plays muted with controls, nothing autoplays, so reduced motion has nothing to stop.
// Under 640 px the still is too small to read, so the frame's lines show as text and the lazy still never loads.
export function ProofVideo({ poster, width, height, visibleHeight, label, webm, mp4, excerpt }: Props) {
  const [playing, setPlaying] = useState(false);
  return (
    <div className={`pvid${playing ? " playing" : ""}`}>
      {playing ? null : <pre className="ex">{excerpt}</pre>}
      <div className="frame" style={{ aspectRatio: `${width} / ${playing ? height : visibleHeight}` }}>
        {playing ? (
          <video
            width={width}
            height={height}
            aria-label={label}
            poster={poster}
            controls
            muted
            playsInline
            autoPlay
            style={{ aspectRatio: `${width} / ${height}` }}
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
            style={{ aspectRatio: `${width} / ${height}` }}
          />
        )}
      </div>
      {playing ? null : (
        <button type="button" className="play" onClick={() => setPlaying(true)}>
          Play the recording
        </button>
      )}
    </div>
  );
}
