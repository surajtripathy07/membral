// Pure presentational piece for /code/session/[sessionId]'s facts strip
// (GitHub issue #87) — models, tokens, tools-with-counts, and
// files-with-edit-intensity, sourced from the P2a code graph's session
// mirror node + its outgoing touched/used edges. Split out of page.tsx for
// renderToStaticMarkup testability, same precedent as portrait-content.tsx.
//
// UX audit B6 / cost-consistency.md #5: this used to also render
// `estCostUsd` (a STORED snapshot off the code-KG mirror row, "main
// transcript only") as a second, unlabeled "$" next to the header's live
// whole-session total — two unexplained costs in one header. The header's
// total (page.tsx, aggregateAgentStats, live) is now the header's ONLY cost
// figure (B6 done-criteria), so that field is intentionally not read here.
import { totalTokens } from "@/lib/code-sessions/view";
import type { ShapedSessionFacts } from "@/lib/code-sessions/view";
import { formatTokenCount } from "@/lib/format/numbers";

function ToolChip({ label, count }: { label: string; count: number }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-xs border border-line px-1.5 py-0.5 font-mono text-micro text-ink-2">
      {label} {count > 0 && <span className="text-accent">×{count}</span>}
    </span>
  );
}

function FileChip({ label, editCount, created, title }: { label: string; editCount: number; created: boolean | null; title: string }) {
  return (
    <span
      // Capped to a fixed width (was unbounded `max-w-full`) so a long path
      // doesn't take the whole row on its own — with only 3 chips shown
      // (B6), a full-width chip left the other two stranded on their own
      // wrapped lines instead of sharing one.
      className="inline-flex max-w-[180px] items-center gap-1 truncate rounded-xs border border-line px-1.5 py-0.5 font-mono text-micro text-muted"
      title={title}
    >
      <span className="truncate">{label}</span>
      {editCount > 0 && <span className="shrink-0 text-accent">×{editCount}</span>}
      {created !== null && <span className="shrink-0 text-muted">{created ? "new" : "updated"}</span>}
    </span>
  );
}

// UX audit B6: "COLLAPSE to the first 3, then '+N files'" — the source is
// already capped upstream (`files.moreCount`, shapeSessionFacts), this just
// tightens that cap for the header strip specifically.
const FILE_CHIPS_SHOWN = 3;

// B6 done-criteria budget ("header block ≤ 540px desktop, ≤ 1,000px phone"):
// a session touching many distinct tool types (Bash, Agent, Task runners,
// …) can wrap the tool-chip row to 3-4 lines on its own. The audit's own
// verdict keeps the tool chips ("Keep the tool chips") — this caps the row
// the same way the file-chip row already is, never dropping the count.
const TOOL_CHIPS_SHOWN = 8;

export function SessionFacts({ facts }: { facts: ShapedSessionFacts | null }) {
  if (!facts) return null;
  const { models, usage, tools, files } = facts;
  const tokens = totalTokens(usage);
  const hasHeaderLine = models.length > 0 || tokens > 0;
  if (!hasHeaderLine && tools.items.length === 0 && files.items.length === 0) return null;

  const visibleToolChips = tools.items.slice(0, TOOL_CHIPS_SHOWN);
  const hiddenToolChips = tools.items.length - visibleToolChips.length + tools.moreCount;
  const visibleFileChips = files.items.slice(0, FILE_CHIPS_SHOWN);
  const hiddenFileChips = files.items.length - visibleFileChips.length + files.moreCount;

  return (
    <div className="mt-3 space-y-2 border-t border-line-soft pt-3">
      {hasHeaderLine && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-label tabular-nums text-muted">
          {models.length > 0 && <span>{models.join(", ")}</span>}
          {tokens > 0 && <span>{formatTokenCount(tokens)} tokens</span>}
        </div>
      )}
      {visibleToolChips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {visibleToolChips.map((t) => (
            <ToolChip key={t.key} label={t.label} count={t.callCount} />
          ))}
          {hiddenToolChips > 0 && <span className="text-micro text-muted">+{hiddenToolChips} more</span>}
        </div>
      )}
      {visibleFileChips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {visibleFileChips.map((f) => (
            <FileChip key={f.key} label={f.label} editCount={f.editCount} created={f.created} title={f.key} />
          ))}
          {hiddenFileChips > 0 && <span className="text-micro text-muted">+{hiddenFileChips} files</span>}
        </div>
      )}
    </div>
  );
}
