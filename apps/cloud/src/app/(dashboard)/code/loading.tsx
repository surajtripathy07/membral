// Design review #119, item 2 — skeleton for /code: header, the search+sort
// toolbar (project-list.tsx), and a grid of fixed-height project cards
// (h-44, same as ProjectCard/GroupCard) so the grid doesn't reflow once real
// cards land.
import { PageFrame } from "@/components/ui/page-frame";
export default function CodeLoading() {
  return (
    <PageFrame width="data" className="space-y-6">
      <div>
        <div className="h-8 w-28 animate-pulse rounded bg-raised" />
        <div className="mt-2 h-3.5 w-96 max-w-full animate-pulse rounded bg-raised" />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="h-9 min-w-[200px] flex-1 animate-pulse rounded-sm border border-line-strong bg-surface" />
        <div className="flex items-center gap-1">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-7 w-20 animate-pulse rounded-sm bg-raised" />
          ))}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="flex h-44 flex-col gap-2 rounded-card border border-line bg-surface p-5">
            <div className="flex items-start justify-between gap-2">
              <div className="h-4 w-2/3 animate-pulse rounded bg-raised" />
              <div className="h-5 w-16 shrink-0 animate-pulse rounded-xs bg-raised" />
            </div>
            <div className="h-3 w-1/2 animate-pulse rounded bg-raised" />
            <div className="h-3 w-full animate-pulse rounded bg-raised" />
            <div className="h-3 w-3/4 animate-pulse rounded bg-raised" />
            <div className="mt-auto h-3 w-1/3 animate-pulse rounded bg-raised" />
          </div>
        ))}
      </div>
    </PageFrame>
  );
}
