// G3 3D-6 — the dominant `rounded-card border border-line bg-surface p-N`
// literal (1-4 summary panels; see list-row.tsx's B0 note on when NOT to use
// this) pulled into one primitive. Variants (extra classes, non-div
// wrappers, classes ordered before the base string) stay inline — this only
// covers the plain div sites so the base string lives in one place.
import type { ComponentPropsWithoutRef } from "react";

export interface CardProps extends ComponentPropsWithoutRef<"div"> {
  padding: 4 | 6;
  className?: string;
}

export function Card({ padding, className, children, ...divProps }: CardProps) {
  return (
    <div className={`rounded-card border border-line bg-surface p-${padding}${className ? " " + className : ""}`} {...divProps}>
      {children}
    </div>
  );
}
