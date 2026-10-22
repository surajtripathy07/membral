"use client";

// Shared body for every error.tsx under (dashboard) (issue #179). Calm copy,
// the opaque digest if Next supplied one, and a way out. Never renders
// error.message or the stack: in production Next strips server error text
// down to the digest, and client errors can carry anything.
import Link from "next/link";
import { PageFrame } from "@/components/ui/page-frame";

export interface RouteErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function RouteError({ error, reset }: RouteErrorProps) {
  return (
    <PageFrame width="read" className="space-y-4">
      <h1 className="font-serif text-2xl text-ink">Something went wrong on this page</h1>
      <p className="text-sm text-ink-2">
        The page could not be shown. Try again, or head back to Today.
      </p>
      {error.digest ? (
        <p className="text-xs text-muted">
          Reference: <code className="font-mono">{error.digest}</code>
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-4">
        <button
          type="button"
          onClick={() => reset()}
          className="rounded-sm border border-line-strong bg-surface px-3 py-1.5 text-sm text-ink hover:bg-raised focus-visible:outline-2 focus-visible:outline-focus"
        >
          Try again
        </button>
        <Link href="/pulse" className="text-sm text-accent underline underline-offset-2">
          Back to Today
        </Link>
      </div>
    </PageFrame>
  );
}
