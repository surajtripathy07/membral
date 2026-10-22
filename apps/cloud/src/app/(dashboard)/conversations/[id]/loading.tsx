// Design review #119, item 2 — skeleton for /conversations/[id]: back link,
// the source/model/date + title header, the "Continue in Claude Code"
// block, and alternating message bubbles (same idiom as bridge/[id]'s
// MessagesSkeleton). Contained to `mx-auto max-w-3xl`, matching the real
// page, so nothing jumps width when real content lands.
import { PageFrame } from "@/components/ui/page-frame";
export default function ConversationDetailLoading() {
  return (
    <PageFrame width="read">
      <div className="mb-6 h-4 w-40 animate-pulse rounded bg-raised" />

      <div className="mb-8">
        <div className="mb-2 flex items-center gap-2">
          <div className="h-3 w-14 animate-pulse rounded bg-raised" />
          <div className="h-3 w-20 animate-pulse rounded bg-raised" />
          <div className="h-3 w-24 animate-pulse rounded bg-raised" />
        </div>
        <div className="h-7 w-2/3 animate-pulse rounded bg-raised" />
      </div>

      <div className="mb-8 h-10 w-56 animate-pulse rounded-lg border border-line bg-surface" />

      <div className="space-y-3">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className={`flex ${i % 2 === 0 ? "justify-end" : "justify-start"}`}>
            <div
              className={`h-12 w-2/3 max-w-[80%] animate-pulse rounded-xl ${
                i % 2 === 0 ? "bg-accent-soft" : "border border-line bg-surface"
              }`}
            />
          </div>
        ))}
      </div>
    </PageFrame>
  );
}
