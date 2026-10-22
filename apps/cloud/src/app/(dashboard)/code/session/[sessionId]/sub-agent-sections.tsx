// Split out of page.tsx so the sub-agent sections are renderToStaticMarkup-
// testable (a Next page file may export only its page/config).
//
// UX audit B6: "MERGE and COLLAPSE into one `<details>` 'Sub-agents (N)'" —
// the two sections below (`HiddenSubAgentsSection`, `SubAgentSection`) kept
// their own tested markup (26 links used to render open by default); the
// combined `SubAgentsDisclosure` at the bottom just wraps both in one
// `Disclosure`, closed by default, with a single count in its summary.
import Link from "next/link";
import { Disclosure } from "@/components/ui/disclosure";
import type { ChildSessionForMatch, SubAgentTreeNode } from "@/lib/code-sessions/view";

function countTree(nodes: readonly SubAgentTreeNode[]): number {
  return nodes.reduce((sum, n) => sum + 1 + countTree(n.children), 0);
}

/** End-of-page fallback for children matchChildSessionsToTurns couldn't join to any spawning turn of this session — a nested spawn whose spawning turn lives in another sub-agent's own transcript. Nested (recursively) by parentAgentId, view.ts's buildSubAgentTree. */
function SubAgentTreeItem({ node }: { node: SubAgentTreeNode }) {
  return (
    <li>
      <Link
        href={`/code/session/${node.child.id}`}
        className="text-body-sm text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
      >
        {node.child.agentType ?? "Sub-agent"}
        {node.child.description ? ` — ${node.child.description}` : ""} · {node.child.turnCount} turn
        {node.child.turnCount === 1 ? "" : "s"} →
      </Link>
      {node.children.length > 0 && (
        <ul className="mt-1.5 space-y-1.5 border-l border-line-soft pl-4">
          {node.children.map((child) => (
            <SubAgentTreeItem key={child.child.id} node={child} />
          ))}
        </ul>
      )}
    </li>
  );
}

/** Children whose spawning tool call is in this session but past the rendered turn window — listed in spawn order with an accurate caption, never lumped in with the genuinely unmatched. */
export function HiddenSubAgentsSection({
  hidden,
  sessionId,
}: {
  hidden: { child: ChildSessionForMatch; turnIdx: number }[];
  sessionId: string;
}) {
  if (hidden.length === 0) return null;
  return (
    <section>
      <h2 className="section-label">Sub-agents in the hidden turns</h2>
      <p className="mt-0.5 text-micro text-muted">
        spawned in turns past the ones shown above —{" "}
        <Link
          href={`/code/session/${sessionId}?all=1`}
          className="text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
        >
          show all turns
        </Link>{" "}
        to see each one in place
      </p>
      <ul className="mt-3 space-y-1.5">
        {hidden.map(({ child, turnIdx }) => (
          <li key={child.id} className="flex items-baseline gap-2">
            <span className="shrink-0 font-mono text-micro text-muted">turn {turnIdx}</span>
            <Link
              href={`/code/session/${child.id}`}
              className="text-body-sm text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
            >
              {child.agentType ?? "Sub-agent"}
              {child.description ? ` — ${child.description}` : ""} · {child.turnCount} turn
              {child.turnCount === 1 ? "" : "s"} →
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function SubAgentSection({ tree }: { tree: SubAgentTreeNode[] }) {
  if (tree.length === 0) return null;
  return (
    <section>
      <h2 className="section-label">Sub-agents</h2>
      <p className="mt-0.5 text-micro text-muted">no spawning tool call in this transcript — started from inside another sub-agent, or by a harness that records none</p>
      <ul className="mt-3 space-y-1.5">
        {tree.map((node) => (
          <SubAgentTreeItem key={node.child.id} node={node} />
        ))}
      </ul>
    </section>
  );
}

/**
 * UX audit B6 done-criteria: "Sub-agents sit behind one disclosure that
 * shows the count." Renders nothing when there is nothing to show, so the
 * count and content stay honestly matched (never a "(0)" disclosure).
 */
export function SubAgentsDisclosure({
  hidden,
  tree,
  sessionId,
}: {
  hidden: { child: ChildSessionForMatch; turnIdx: number }[];
  tree: SubAgentTreeNode[];
  sessionId: string;
}) {
  const count = hidden.length + countTree(tree);
  if (count === 0) return null;
  return (
    <Disclosure summary="Sub-agents" count={count} className="rounded-card border border-line bg-surface p-4">
      <div className="space-y-4">
        <HiddenSubAgentsSection hidden={hidden} sessionId={sessionId} />
        <SubAgentSection tree={tree} />
      </div>
    </Disclosure>
  );
}
