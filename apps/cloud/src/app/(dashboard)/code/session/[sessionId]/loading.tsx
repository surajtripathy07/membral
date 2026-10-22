// Design review #119, item 2 — skeleton for /code/session/[sessionId]:
// breadcrumb, the header card (title, meta line, files touched, facts), and
// the user-spine timeline (dot + line per turn, matching SpineGroupView's
// own `relative pl-6` geometry).
import { PageFrame } from "@/components/ui/page-frame";
export default function CodeSessionLoading() {
  return (
    <PageFrame width="read" className="space-y-6">
      <div className="flex items-center gap-2">
        <div className="h-3.5 w-14 animate-pulse rounded bg-raised" />
        <div className="h-3.5 w-2 animate-pulse rounded bg-raised" />
        <div className="h-3.5 w-40 animate-pulse rounded bg-raised" />
      </div>

      <header className="rounded-card border border-line bg-surface p-6">
        <div className="h-5 w-64 max-w-full animate-pulse rounded bg-raised" />
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-3 w-16 animate-pulse rounded bg-raised" />
          ))}
        </div>
        <div className="mt-3 h-3 w-1/2 animate-pulse rounded bg-raised" />
      </header>

      <section className="space-y-5 rounded-card border border-line bg-surface p-6">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="relative pl-6">
            <span className="absolute left-0 top-1.5 h-2 w-2 rounded-full bg-line-strong" />
            <div className="h-4 w-3/4 animate-pulse rounded bg-raised" />
            <div className="mt-1.5 h-3 w-20 animate-pulse rounded bg-raised" />
          </div>
        ))}
      </section>
    </PageFrame>
  );
}
