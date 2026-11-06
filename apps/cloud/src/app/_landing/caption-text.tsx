import { Fragment } from "react";

// Caption text with no break inside a date (2026-10-08) or between a number and its unit (9 s, 88 ms).
const DATE = /(\d{4}-\d{2}-\d{2})/;
const UNIT = /(\d)\s+(s|ms|MB|GB|days?|runs?)\b/g;

export function CaptionText({ text }: { text: string }) {
  return (
    <>
      {text.split(DATE).map((part, i) =>
        i % 2 === 1 ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: static split of a constant string
          <span key={i} className="nw">
            {part}
          </span>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: static split of a constant string
          <Fragment key={i}>{part.replace(UNIT, "$1 $2")}</Fragment>
        ),
      )}
    </>
  );
}
