// UX W5: the one way a dashboard row names the sessions behind it (Today's
// threads, Issues rows, Usage outcome rows). The first title shows on one
// truncated line, linked to /code/session/<id> (with a #turn anchor when the
// row traces to one turn); any others sit behind a "+N more" Disclosure that
// lists every one of them — nothing is cut silently.
//
// Titles arrive already cleaned (lib/code-sessions/session-titles.ts: the
// session page's own title source, sub-agents as "parent · label", no
// absolute paths). Server-renderable: no client state.
import Link from "next/link";
import { Disclosure } from "@/components/ui/disclosure";

export interface SessionTitleItem {
  id: string;
  title: string;
  /** Turn the row traces to; the link gets `#turn-N` when set. */
  turnIdx?: number | null;
  /** Hover text (e.g. the session's start time). */
  hint?: string;
  /** Screen-reader label; defaults to "open session <title>". */
  ariaLabel?: string;
}

export function sessionHref(id: string, turnIdx?: number | null): string {
  // v4 item 6: `?turn=N` makes the session page load a window around the turn, so the anchor
  // exists even past the page's default turn cap.
  return turnIdx === null || turnIdx === undefined
    ? `/code/session/${id}`
    : `/code/session/${id}?turn=${turnIdx}#turn-${turnIdx}`;
}

const LINK_CLASS =
  "block min-w-0 truncate rounded-xs text-muted hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus";

function TitleLink({ item }: { item: SessionTitleItem }) {
  return (
    <Link
      href={sessionHref(item.id, item.turnIdx)}
      title={item.hint ?? item.title}
      aria-label={item.ariaLabel ?? `open session ${item.title}`}
      className={LINK_CLASS}
    >
      {item.title}
    </Link>
  );
}

/** `items` in display order (callers pass newest first). Renders nothing for an empty list. */
export function SessionTitleList({ items, className = "" }: { items: readonly SessionTitleItem[]; className?: string }) {
  const [first, ...rest] = items;
  if (!first) return null;
  return (
    <span className={`flex min-w-0 items-baseline gap-2 text-body-sm ${className}`} data-testid="session-titles">
      <span className="min-w-0 flex-1">
        <TitleLink item={first} />
      </span>
      {rest.length > 0 && (
        <Disclosure summary={`+${rest.length} more`} className="shrink-0">
          <ul className="flex flex-col gap-1" data-testid="session-titles-more">
            {rest.map((item) => (
              <li key={item.id} className="flex min-w-0">
                <TitleLink item={item} />
              </li>
            ))}
          </ul>
        </Disclosure>
      )}
    </span>
  );
}
