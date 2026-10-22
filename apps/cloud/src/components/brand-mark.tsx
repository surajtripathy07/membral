// The Membral bracket mark (app/icon.svg) and wordmark, drawn in currentColor /
// theme tokens so they read on paper and ink alike — /logo.svg hard-codes a
// dark-only palette and is not used on themed surfaces.

export /** The bracket mark from app/icon.svg, drawn in currentColor so it follows the theme. */
function BrandMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <path d="M11 6H7v20h4" stroke="currentColor" strokeWidth={3} strokeLinecap="square" strokeLinejoin="miter" />
      <path d="M21 6h4v20h-4" stroke="currentColor" strokeWidth={3} strokeLinecap="square" strokeLinejoin="miter" />
      <rect x="13.5" y="15" width="5" height="2.6" fill="currentColor" />
    </svg>
  );
}

/** Mark + serif wordmark, as the sidebar shows it. */
export function BrandLockup({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <BrandMark className="h-5 w-5 text-accent" />
      <span className="font-serif text-lead font-semibold text-ink">Membral</span>
    </span>
  );
}
