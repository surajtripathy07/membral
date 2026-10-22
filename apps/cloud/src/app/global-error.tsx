"use client";

// Last-resort boundary (issue #179): replaces the root layout when it throws,
// so it owns <html>/<body> and imports the token sheet itself. Shows only the
// opaque digest, never the error text.
import "./globals.css";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body className="bg-canvas font-sans text-ink antialiased">
        <main className="mx-auto w-full max-w-3xl space-y-4 px-4 pt-8 pb-16 lg:px-6">
          <h1 className="font-serif text-2xl text-ink">Something went wrong</h1>
          <p className="text-sm text-ink-2">Membral could not load. Nothing was lost. Try again in a moment.</p>
          {error.digest ? (
            <p className="text-xs text-muted">
              Reference: <code className="font-mono">{error.digest}</code>
            </p>
          ) : null}
          <button
            type="button"
            onClick={() => reset()}
            className="rounded-sm border border-line-strong bg-surface px-3 py-1.5 text-sm text-ink hover:bg-raised focus-visible:outline-2 focus-visible:outline-focus"
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
