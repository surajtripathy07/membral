// One memory v1 record, as /memories and the project page's memory section
// render it: a kind glyph, the sentence and the receipt link on line 1, the
// verbatim quote (clamped to one line; click to expand — the same
// details/summary + group-open pattern conversations/page.tsx's "More
// analytics" disclosure uses, so no client component is needed) and the
// project/date/verified/sub-agent receipts on line 2.
//
// UX audit B5: a `ListRow` divider, not a bordered card — about half the
// height per record. "✓ Verified" is dropped: with the corpus verified by
// default, a check mark on every row was chrome that carried no
// information (audit §2 P4); only the exception ("Not verified") renders.
// The sub-agent chip is decorative provenance, so it stays hidden until the
// row is hovered.
import Link from "next/link";
import { blockerAge, isFreshBlocker } from "@/lib/domain/blockers";
import { formatRelativeDate } from "@/lib/format/dates";
import { type BrowseSessionMemory, receiptHref } from "@/lib/memory/session-memories-browse";

export const KIND_LABELS: Record<BrowseSessionMemory["kind"], string> = {
  preference: "Preference",
  decision: "Decision",
  learning: "Learning",
  blocker: "Blocker",
  outcome: "Outcome",
};

export function SessionMemoryCard({
  record,
  showProject = true,
  now,
}: {
  record: BrowseSessionMemory;
  showProject?: boolean;
  now?: Date;
}) {
  return (
    <div className="group/row flex flex-col gap-1 border-b border-line-soft py-2.5 last:border-b-0" data-testid="session-memory">
      <div className="flex items-start gap-2">
        {/* UX W6: the kind as a word, not a one-letter glyph. */}
        <span className="mt-0.5 w-20 shrink-0 text-micro font-medium text-muted" data-testid="memory-kind">
          {KIND_LABELS[record.kind]}
        </span>
        <p className="min-w-0 flex-1 text-body-sm leading-relaxed text-ink">
          {record.text}
        </p>
        <Link
          href={receiptHref(record)}
          className="shrink-0 text-micro text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          session, turn {record.turn_idx} →
        </Link>
      </div>
      <div className="pl-22">
        {record.quote && (
          <details className="group/quote">
            <summary className="line-clamp-1 cursor-pointer list-none text-micro italic text-muted group-open/quote:line-clamp-none">
              &ldquo;{record.quote}&rdquo;
            </summary>
          </details>
        )}
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-micro text-muted">
          {showProject && record.project_name && (
            <>
              <Link href={`/code/${record.code_project_id}`} className="text-ink-2 hover:underline">
                {record.project_name}
              </Link>
              <span aria-hidden="true">·</span>
            </>
          )}
          {/* #436: the archive still lists a blocker past the fresh window, marked old. */}
          <time dateTime={record.created_at}>
            {isFreshBlocker(record, now?.getTime())
              ? formatRelativeDate(record.created_at, now)
              : `old · ${blockerAge(record.created_at, now?.getTime())}`}
          </time>
          {!record.verified && (
            <>
              <span aria-hidden="true">·</span>
              <span title="The quote was not found in the session transcript">Not verified</span>
            </>
          )}
          {record.from_sub_agent && (
            <span className="opacity-0 transition-opacity group-hover/row:opacity-100">· from a sub-agent</span>
          )}
        </div>
      </div>
    </div>
  );
}
