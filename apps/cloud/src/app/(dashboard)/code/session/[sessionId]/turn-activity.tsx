// Split out of page.tsx so the activity rendering is renderToStaticMarkup-
// testable (a Next page file may export only its page/config).
import Link from "next/link";
import { Markdown } from "@/components/markdown";
import { digestFirstLine, type TurnActionView, turnActionViews } from "@/lib/code-sessions/turn-actions";
import { markQuote } from "./quote-mark";
import { type ChildSessionForMatch, toolActivityLabel, toolResultStatus, type TurnRow } from "@/lib/code-sessions/view";

/** #89 (migration 089): the Task/Agent tool_use turn that spawned a sub-agent — an inline link to its own session page, right where the spawn happened in the transcript, in addition to the end-of-page "Sub-agents" section (unmatched children only, see SubAgentSection). */
function SubAgentLink({ child }: { child: ChildSessionForMatch }) {
  return (
    <Link
      href={`/code/session/${child.id}`}
      className="ml-5 mt-0.5 flex items-center gap-1 py-0.5 text-micro text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
    >
      Sub-agent: {child.agentType ?? "agent"}
      {child.description ? ` — ${child.description}` : ""} · {child.turnCount} turn{child.turnCount === 1 ? "" : "s"} →
    </Link>
  );
}

/**
 * What a tool_use turn observably did on a forge/git, next to its tool name:
 * "· commented on owner/repo#145". From the turn's stored, already-redacted
 * props.action(s) only (lib/code-sessions/turn-actions.ts); a ref links only
 * through forgeUrl, plain text otherwise.
 */
function ObservedActions({ views }: { views: TurnActionView[] }) {
  return (
    <span className="min-w-0 text-ink-2">
      {views.map((v, i) => (
        <span key={`${v.verb}-${v.target?.text ?? ""}`} data-testid="turn-action">
          <span className="text-muted">{i === 0 ? "· " : ", "}</span>
          {v.verb}
          {v.target && (
            <>
              {" "}
              {v.target.href ? (
                <a
                  href={v.target.href}
                  target="_blank"
                  rel="noreferrer"
                  className="text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                >
                  {v.target.text}
                </a>
              ) : (
                <span>{v.target.text}</span>
              )}
            </>
          )}
        </span>
      ))}
    </span>
  );
}

function ActivityLineBody({
  turn,
  subAgent,
  projectIdentity,
  glabHosts,
  quote,
}: {
  turn: TurnRow;
  subAgent?: ChildSessionForMatch;
  projectIdentity: string | null;
  glabHosts?: readonly string[];
  quote?: string | null;
}) {
  if (turn.kind === "tool_use") {
    const views = turnActionViews(turn.actions ?? [], projectIdentity, glabHosts);
    const digest = digestFirstLine(turn.inputDigest);
    return (
      <div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 py-0.5 font-mono text-micro text-muted">
          <ToolGlyph />
          <span className="truncate">{toolActivityLabel(turn)}</span>
          {views.length > 0 && <ObservedActions views={views} />}
        </div>
        {digest && (
          <div className="ml-5 truncate font-mono text-micro text-muted" title={digest} data-testid="turn-digest">
            {digest}
          </div>
        )}
        {subAgent && <SubAgentLink child={subAgent} />}
      </div>
    );
  }
  if (turn.kind === "tool_result") {
    const status = toolResultStatus(turn);
    const style =
      status === "error"
        ? "text-error"
        : status === "ok"
          ? "text-ok"
          : "text-muted";
    return (
      <div className="py-0.5">
        <span className={`inline-flex items-center rounded-xs border border-line px-1.5 py-0.5 font-mono text-micro ${style}`}>
          {turn.tool_name ? `${turn.tool_name} → ` : ""}
          {status}
        </span>
      </div>
    );
  }
  if (turn.kind === "thinking") {
    return (
      <p className="whitespace-pre-wrap break-words py-0.5 text-body-sm italic text-muted">
        {markQuote(turn.text ?? "", quote) ?? turn.text}
      </p>
    );
  }
  // assistant prose — markdown (fences, bullets, emphasis) via the shared
  // Markdown component with a token-only palette; no raw HTML is rendered.
  // A cited quote found in this turn: plain text with the mark (marking inside rendered markdown would mean parsing it).
  const marked = markQuote(turn.text ?? "", quote);
  if (marked) return <p className="whitespace-pre-wrap break-words py-0.5 text-body-sm text-ink-2">{marked}</p>;
  return <Markdown content={turn.text ?? ""} className={ASSISTANT_PROSE} />;
}

/** Per-turn anchor (`#turn-<idx>`) so a memory receipt or any other deep link can
 * jump straight to the step that produced it — `scroll-mt-24` keeps it clear of
 * the page's own header when the browser lands on the hash. */
export function ActivityLine({
  turn,
  subAgent,
  projectIdentity = null,
  glabHosts,
  quote,
}: {
  turn: TurnRow;
  subAgent?: ChildSessionForMatch;
  /** The quote a memory record cites (`?quote=`), marked in this turn's text. Pass it for the focused turn only. */
  quote?: string | null;
  /** code_projects.repo_identity of the session — qualifies a bare `#N` action ref the way attribution stores it. */
  projectIdentity?: string | null;
  /** Hosts the page's data shows are glab-family (forge-url.ts `glabHostsFrom`) — their refs link glab-style. */
  glabHosts?: readonly string[];
}) {
  return (
    <div id={`turn-${turn.idx}`} className="scroll-mt-24">
      <ActivityLineBody
        turn={turn}
        subAgent={subAgent}
        projectIdentity={projectIdentity}
        glabHosts={glabHosts}
        quote={quote}
      />
    </div>
  );
}

/** Token-only prose palette for assistant turns (globals.css; never raw gray-*). */
export const ASSISTANT_PROSE =
  "prose prose-sm dark:prose-invert max-w-none py-0.5 text-body-sm text-ink-2 prose-headings:text-ink prose-p:my-1 prose-p:text-ink-2 prose-p:leading-relaxed prose-li:my-0 prose-li:text-ink-2 prose-strong:text-ink prose-code:rounded prose-code:bg-raised prose-code:px-1 prose-code:py-0.5 prose-code:text-micro prose-code:text-ink prose-code:before:content-none prose-code:after:content-none prose-pre:my-1.5 prose-pre:border prose-pre:border-line prose-pre:bg-sunken prose-pre:text-ink-2 prose-a:text-accent prose-blockquote:border-line prose-blockquote:text-muted prose-hr:border-line";

function ToolGlyph() {
  return (
    <svg className="h-3 w-3 shrink-0 text-muted" viewBox="0 0 16 16" fill="none" stroke="currentColor">
      <path strokeWidth="1.3" strokeLinecap="round" d="M3 3l4 5-4 5M9 13h4" />
    </svg>
  );
}
