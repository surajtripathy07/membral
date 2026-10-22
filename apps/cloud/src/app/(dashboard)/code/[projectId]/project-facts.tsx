// "Activity details" for /code/[projectId] (GitHub issue #87's code-graph
// facts UI, redesigned for the /code information-design pass — maintainer
// verdict on the old layout: "very crowded, too much information"). This is
// real signal straight from code_kg_nodes/code_kg_edges, but it's RAW
// ACTIVITY, not one of the above-the-fold questions (what is this / what
// happened / what to remember) — so it lives collapsed at the BOTTOM of the
// page behind a single disclosure, last. Native <details>/<summary>
// throughout — no client JS needed for any of the collapsing here,
// including the nested "scratch/notes" and "show all" toggles.
//
// DELIBERATELY renders each file/tool key VERBATIM as both the visible label
// AND the `title` attribute — cwd fragmentation means the "same" file on
// disk can appear under several distinct paths, each its own chip. No
// basename dedupe/merging here, ever (locked by a negative test in
// __tests__/project-facts.test.tsx). shortenSessionPath only shortens the
// DISPLAY label; `key`/`title` always carry the untouched original path.
import type { ProjectFactBucket, ProjectFactItem, ShapedProjectFacts } from "@/lib/code-sessions/view";
import { shortenSessionPath } from "@/lib/code-sessions/view";

const TOP_N = 8;

function FactChip({ label, count, title }: { label: string; count: number; title: string }) {
  return (
    <span
      className="inline-flex max-w-full items-center gap-1 truncate rounded-xs border border-line px-1.5 py-0.5 font-mono text-micro text-ink-2"
      title={title}
    >
      <span className="truncate">{label}</span>
      {/* A singleton (session_count === 1) chip showing "×1" visually implies
          recurrence it doesn't have — only show the count once something has
          actually recurred (F4 adversarial finding, carried over). */}
      {count > 1 && <span className="shrink-0 text-accent">×{count}</span>}
    </span>
  );
}

/**
 * Files get the source/scratch split (design brief): a coding agent's own
 * memory dir and scratchpad are real recurrence, but they're noise relative
 * to the repo — group them behind a collapsed "+N scratch/notes" toggle so
 * they never crowd out actual source files in the visible top-N row.
 */
function FileChips({ items }: { items: ProjectFactItem[] }) {
  const shaped = items.map((item) => ({ item, shortened: shortenSessionPath(item.label, null) }));
  const source = shaped.filter((s) => s.shortened.group === "source");
  const scratch = shaped.filter((s) => s.shortened.group === "scratch");
  const visibleSource = source.slice(0, TOP_N);
  const extraSource = source.length - visibleSource.length;

  return (
    <div>
      {visibleSource.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {visibleSource.map(({ item, shortened }) => (
            <FactChip key={item.key} label={shortened.display} count={item.sessionCount} title={item.key} />
          ))}
          {extraSource > 0 && <span className="text-micro text-muted">+{extraSource} more</span>}
        </div>
      )}
      {scratch.length > 0 && (
        <details className={visibleSource.length > 0 ? "mt-1.5" : ""}>
          <summary className="cursor-pointer text-micro text-muted hover:text-ink-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface">
            +{scratch.length} scratch/notes
          </summary>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {scratch.map(({ item, shortened }) => (
              <FactChip key={item.key} label={shortened.display} count={item.sessionCount} title={item.key} />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function ToolChips({ bucket }: { bucket: ProjectFactBucket }) {
  const visible = bucket.items.slice(0, TOP_N);
  const extra = bucket.items.length - visible.length + bucket.moreCount;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {visible.map((t) => (
        <FactChip key={t.key} label={t.label} count={t.sessionCount} title={t.key} />
      ))}
      {extra > 0 && <span className="text-micro text-muted">+{extra} more</span>}
    </div>
  );
}

function SubagentList({ bucket }: { bucket: ProjectFactBucket }) {
  const total = bucket.items.length + bucket.moreCount;
  return (
    <details>
      <summary className="cursor-pointer text-micro text-muted hover:text-ink-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface">
        {total} sub-agent{total === 1 ? "" : "s"} · show all
      </summary>
      <p className="mt-1.5 font-mono text-micro text-ink-2">
        {bucket.items.map((s) => (s.sessionCount > 1 ? `${s.label} (×${s.sessionCount})` : s.label)).join(", ")}
        {bucket.moreCount > 0 ? `, +${bucket.moreCount} more` : ""}
      </p>
    </details>
  );
}

export function ProjectFacts({
  facts,
  recurringFilesTools,
}: {
  facts: ShapedProjectFacts | null;
  /** rollup.recurring_files_tools (P1c synthesis pass) — an LLM-paraphrased
   *  list, distinct from `facts` (read straight from the graph) and can
   *  drift from it; kept because the LLM's judgment about what's *notable*
   *  is a different, complementary signal than raw session_count recurrence. */
  recurringFilesTools: string[];
}) {
  const hasGraphFacts =
    !!facts && (facts.files.items.length > 0 || facts.tools.items.length > 0 || facts.subagents.items.length > 0);
  if (!hasGraphFacts && recurringFilesTools.length === 0) return null;

  return (
    <details className="rounded-card border border-line bg-surface">
      <summary className="cursor-pointer select-none px-4 py-3 section-label hover:text-ink-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface">
        Activity details
      </summary>
      <div className="space-y-4 border-t border-line-soft px-4 py-4">
        {hasGraphFacts && facts && (
          <>
            <p className="text-micro text-muted">
              from session activity — counts are a floor; the same file may appear under more than one path
            </p>
            {facts.files.items.length > 0 && (
              <div>
                <h3 className="mb-1.5 font-serif text-body-sm font-semibold text-ink-2">Files</h3>
                <FileChips items={facts.files.items} />
              </div>
            )}
            {facts.tools.items.length > 0 && (
              <div>
                <h3 className="mb-1.5 font-serif text-body-sm font-semibold text-ink-2">Tools</h3>
                <ToolChips bucket={facts.tools} />
              </div>
            )}
            {facts.subagents.items.length > 0 && (
              <div>
                <h3 className="mb-1.5 font-serif text-body-sm font-semibold text-ink-2">Sub-agents</h3>
                <SubagentList bucket={facts.subagents} />
              </div>
            )}
          </>
        )}
        {recurringFilesTools.length > 0 && (
          <div>
            <h3 className="mb-1.5 font-serif text-body-sm font-semibold text-ink-2">Notable — AI summary</h3>
            <p className="mb-1.5 text-micro text-muted">
              paraphrased by the rollup pass — may drift from the activity above
            </p>
            <div className="flex flex-wrap gap-1.5">
              {recurringFilesTools.map((f) => (
                <span
                  key={f}
                  className="truncate rounded-xs border border-line px-1.5 py-0.5 font-mono text-micro text-ink-2"
                  title={f}
                >
                  {f}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </details>
  );
}
