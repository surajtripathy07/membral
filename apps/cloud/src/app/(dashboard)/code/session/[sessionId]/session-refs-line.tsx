"use client";

// UX audit B6 ("*(missing)* refs acted on — ADD a one-line SessionRefsLine
// under the meta line: '#17 merged · #41 no close seen'"). `refs` is
// page.tsx's `computeThreads(...).recent` for this session's own
// `code_session_issues` rows — the same exported ladder/closure engine
// Today's open threads use, just fed one session's rows instead of every
// session's, so "open · no close seen" means exactly what it means there
// (§5: wording/mechanics unchanged).
//
// Maintainer requirement: a ref links only through `forgeUrl` on the
// host-qualified ref; when that returns null (no host, or a host this
// product doesn't point at), render plain text instead of a broken or
// wrong-repo link.
//
// Refs render exactly as Today's rows do: `threadRefLabel` (the shared D-065
// `refLabel` rule — `#N` on github.com, `#N`/`!N` on a glab-family host,
// `owner/repo#N`/`owner/repo!N` elsewhere), so MR !17 and issue #17 never look
// like one ref listed twice. Client component only for ShowAll.
import { ShowAll } from "@/components/ui/show-all";
import { forgeUrl } from "@/lib/format/forge-url";
import type { Thread } from "@/lib/threads/open-threads";
import { threadRefLabel } from "@/lib/threads/view";

function verbLabel(thread: Thread): string {
  if (thread.closure) {
    if (thread.closure.kind === "action") return thread.closure.verb;
    return thread.closure.merged_into ? "merged" : "closed";
  }
  if (thread.open) return "open · no close seen";
  if (thread.ladder.build_verb) return thread.ladder.build_verb.replace(/_/g, " ");
  if (thread.ladder.review_verb) return thread.ladder.review_verb;
  if (thread.ladder.triaged) return "triaged";
  if (thread.ladder.discussed) return "discussed";
  return "mentioned";
}

// §3.3's rule ("no list renders more than 10 items, 5 on Today, before a
// ShowAll"): the first 5 refs, then an expandable "+N more".
export const REFS_SHOWN = 5;

export function SessionRefsLine({ refs }: { refs: readonly Thread[] }) {
  if (refs.length === 0) return null;
  return (
    <ShowAll
      items={refs}
      initial={REFS_SHOWN}
      label={(n) => `+${n} more`}
      className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1 font-mono text-label text-muted [&>button]:mt-0"
      renderItem={(t, i) => {
        const href = forgeUrl(t.ref, { kind: t.refKind, family: t.forge_family });
        const label = threadRefLabel(t);
        return (
          <span key={`${t.ref}-${t.refKind}`} data-testid="session-ref">
            {i > 0 && <span className="mr-3">·</span>}
            {href ? (
              <a href={href} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                {label}
              </a>
            ) : (
              <span>{label}</span>
            )}{" "}
            {verbLabel(t)}
          </span>
        );
      }}
    />
  );
}
