// Design review #119, item 2 — skeleton for /code/[projectId]: breadcrumb,
// the header card (name, remote, summary, stats strip), the two-column
// sessions-timeline + side-cards layout, and the cost/memory/facts sections
// below. Mirrors the real page's `lg:grid-cols-[minmax(0,1fr)_320px]` split
// so the columns don't reflow once real content lands.
import { Card } from "@/components/ui/card";
import { PageFrame } from "@/components/ui/page-frame";
export default function CodeProjectLoading() {
  return (
    <PageFrame width="data" className="space-y-6">
      <div className="flex items-center gap-2">
        <div className="h-3.5 w-14 animate-pulse rounded bg-raised" />
        <div className="h-3.5 w-2 animate-pulse rounded bg-raised" />
        <div className="h-3.5 w-40 animate-pulse rounded bg-raised" />
      </div>

      <header className="rounded-card border border-line bg-surface p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="h-7 w-72 max-w-full animate-pulse rounded bg-raised" />
            <div className="mt-2 h-3 w-48 animate-pulse rounded bg-raised" />
          </div>
          <div className="h-9 w-32 shrink-0 animate-pulse rounded-sm bg-raised" />
        </div>
        <div className="mt-3 space-y-2">
          <div className="h-3.5 w-full max-w-[70ch] animate-pulse rounded bg-raised" />
          <div className="h-3.5 w-2/3 max-w-[70ch] animate-pulse rounded bg-raised" />
        </div>
        <div className="mt-4 flex flex-wrap gap-x-5 gap-y-1.5">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-3 w-20 animate-pulse rounded bg-raised" />
          ))}
        </div>
      </header>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-3">
          <div className="h-3 w-32 animate-pulse rounded bg-raised" />
          {[0, 1, 2, 3].map((i) => (
            <Card key={i} padding={4}>
              <div className="h-3.5 w-3/4 animate-pulse rounded bg-raised" />
              <div className="mt-2 h-3 w-1/3 animate-pulse rounded bg-raised" />
            </Card>
          ))}
        </div>

        <div className="space-y-4">
          {[0, 1, 2].map((i) => (
            <Card key={i} padding={4}>
              <div className="h-3 w-24 animate-pulse rounded bg-raised" />
              <div className="mt-2 h-3 w-full animate-pulse rounded bg-raised" />
              <div className="mt-1.5 h-3 w-2/3 animate-pulse rounded bg-raised" />
            </Card>
          ))}
        </div>
      </div>

      <Card padding={6}>
        <div className="h-3.5 w-48 animate-pulse rounded bg-raised" />
      </Card>

      <Card padding={6}>
        <div className="h-3.5 w-32 animate-pulse rounded bg-raised" />
      </Card>
    </PageFrame>
  );
}
