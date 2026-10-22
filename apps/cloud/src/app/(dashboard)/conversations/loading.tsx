// Design review #119, item 2 — skeleton for /conversations, matching the
// decrowded layout (item 5): header, stat tiles, the Recent Conversations
// list (now position 2), the code-activity card, the weekly chart, and the
// collapsed "More analytics" bar. Geometry mirrors the real page's own
// classes (rounded-xl border border-line bg-surface p-6, the same grid
// breakpoints) so there's no layout jump once real content lands.
import { PageFrame } from "@/components/ui/page-frame";

export default function ConversationsLoading() {
  return (
    <PageFrame width="data" className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="h-8 w-40 animate-pulse rounded bg-raised" />
        <div className="h-7 w-48 animate-pulse rounded-lg bg-raised" />
      </div>

      {/* Stat tiles */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="rounded-xl border border-line bg-surface p-6">
            <div className="h-3.5 w-24 animate-pulse rounded bg-raised" />
            <div className="mt-3 h-8 w-14 animate-pulse rounded bg-raised" />
          </div>
        ))}
      </div>

      {/* Recent Conversations list */}
      <div className="rounded-xl border border-line bg-surface p-6">
        <div className="mb-4 flex items-center justify-between">
          <div className="h-4 w-36 animate-pulse rounded bg-raised" />
          <div className="h-3 w-16 animate-pulse rounded bg-raised" />
        </div>
        <div className="divide-y divide-line">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="flex items-center justify-between py-3">
              <div className="flex min-w-0 items-center gap-3">
                <div className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-raised" />
                <div className="h-3.5 w-56 animate-pulse rounded bg-raised" />
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <div className="h-3 w-12 animate-pulse rounded bg-raised" />
                <div className="h-3 w-10 animate-pulse rounded bg-raised" />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Weekly activity */}
      <div className="rounded-xl border border-line bg-surface p-6">
        <div className="mb-4 h-4 w-52 animate-pulse rounded bg-raised" />
        <div className="flex items-end gap-2" style={{ height: "200px" }}>
          {Array.from({ length: 12 }).map((_, i) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: static shimmer placeholders
              key={i}
              className="w-full flex-1 animate-pulse rounded-t bg-raised"
              style={{ height: `${20 + ((i * 13) % 70)}%` }}
            />
          ))}
        </div>
      </div>

      {/* Collapsed "More analytics" bar */}
      <div className="rounded-xl border border-line bg-surface p-6">
        <div className="h-4 w-32 animate-pulse rounded bg-raised" />
      </div>
    </PageFrame>
  );
}
