// Maintainer product-review feedback: "looks fcked .. too much going on in
// there besides the content". Split out of page.tsx (a server component)
// purely so it's renderToStaticMarkup-testable in isolation, same precedent
// as code/[projectId]/project-facts.tsx. No client state needed here — the
// noise-collapse and long-message clamp both use native <details>/<summary>,
// so this stays a server component (Markdown, which it renders into, is
// itself a "use client" leaf — composing a client component under a server
// one is fine, same as the pre-existing page.tsx already did).
//
// Message-index integrity is a hard constraint: search spans cite
// message_start_idx into the stored `messages` array (conversation-chunks.ts
// / mcp/graph-tools.ts). Rows are keyed by their ORIGINAL array index and
// keep their order; the only rows not drawn are ones with nothing to show
// (empty content), and runs of mirrored tool-only / size-cap-emptied
// messages fold into one quiet row keyed by the run's first index. The
// stored array itself is never touched.
import type { ReactNode } from "react";
import { Markdown } from "@/components/markdown";
import {
  classifyMessage,
  countToolSteps,
  hasContentBlockMarkers,
  isLongMessage,
  isToolOnlyMessage,
  type MessageSegment,
  messagePreview,
  parseMessageSegments,
} from "@/lib/conversation-view";

export interface ConversationMessage {
  role: string;
  content: string;
  timestamp?: string | null;
  metadata?: Record<string, unknown> | null;
}

// Token-only prose palette (globals.css; CLAUDE.md rule 5) — replaces the
// Markdown component's legacy gray/blue default for this page.
const PROSE =
  "prose prose-sm dark:prose-invert max-w-none prose-headings:text-ink prose-p:text-ink prose-p:leading-relaxed prose-li:text-ink prose-strong:text-ink prose-code:text-accent prose-code:bg-raised prose-code:rounded prose-code:px-1 prose-code:py-0.5 prose-code:text-label prose-pre:bg-sunken prose-pre:border prose-pre:border-line prose-a:text-accent prose-blockquote:border-line prose-blockquote:text-ink-2 prose-hr:border-line";

function formatMessageTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function NoiseRow({ content }: { content: string }) {
  return (
    <details className="rounded-card border border-line-soft bg-surface px-3 py-1.5">
      <summary className="cursor-pointer select-none text-label text-muted transition-colors hover:text-ink-2">
        system context — expand
      </summary>
      <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-micro text-muted">{content}</pre>
    </details>
  );
}

/** One muted row standing in for a run of mirrored tool-only / size-cap-emptied messages (D8). */
function QuietRun({ toolLines, trimmed }: { toolLines: string[]; trimmed: number }) {
  const steps = toolLines.reduce((n, l) => n + countToolSteps(l), 0);
  const parts: string[] = [];
  if (steps > 0) parts.push(`${steps} tool ${steps === 1 ? "step" : "steps"}`);
  if (trimmed > 0) parts.push(`${trimmed} ${trimmed === 1 ? "message" : "messages"} trimmed (size cap)`);
  const label = parts.join(" · ");
  if (toolLines.length === 0) {
    return <p className="px-3 py-1 text-label text-muted">{label}</p>;
  }
  return (
    <details className="rounded-card border border-line-soft bg-surface px-3 py-1.5">
      <summary className="cursor-pointer select-none text-label text-muted transition-colors hover:text-ink-2">
        {label}
      </summary>
      <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-micro text-muted">{toolLines.join("\n")}</pre>
    </details>
  );
}

function TextBody({ isUser, content }: { isUser: boolean; content: string }) {
  return isUser ? (
    <div className="whitespace-pre-wrap text-body text-ink">{content}</div>
  ) : (
    <Markdown content={content} className={PROSE} />
  );
}

/**
 * Long text clamps to a markdown-stripped plain preview (D6). The preview
 * lives inside <summary> and hides when the <details> opens, so expanding
 * REPLACES it with the full rendered message instead of appending below it.
 */
function ClampedText({ isUser, content }: { isUser: boolean; content: string }) {
  if (!isLongMessage(content)) return <TextBody isUser={isUser} content={content} />;
  return (
    <details className="group">
      <summary className="cursor-pointer list-none">
        <div className="whitespace-pre-wrap text-body text-ink group-open:hidden">{messagePreview(content)}…</div>
        <span className="mt-2 inline-block text-label text-accent hover:underline group-open:hidden">Show more</span>
        <span className="hidden text-label text-accent hover:underline group-open:inline">Show less</span>
      </summary>
      <div className="mt-2">
        <TextBody isUser={isUser} content={content} />
      </div>
    </details>
  );
}

function CollapsedBlock({ label, detail, children }: { label: string; detail?: string; children: ReactNode }) {
  return (
    <details className="rounded-sm border border-line-soft bg-sunken px-3 py-1.5">
      <summary className="cursor-pointer select-none text-label text-muted transition-colors hover:text-ink-2">
        {label}
        {detail && <span className="ml-1 font-mono text-ink-2">{detail}</span>}
      </summary>
      <div className="mt-2">{children}</div>
    </details>
  );
}

function PreBlock({ text }: { text: string }) {
  return <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words font-mono text-micro text-ink-2">{text}</pre>;
}

function Segment({ segment, isUser }: { segment: MessageSegment; isUser: boolean }) {
  switch (segment.kind) {
    case "text":
      return <ClampedText isUser={isUser} content={segment.text} />;
    case "thinking":
      return (
        <CollapsedBlock label="Thinking">
          <div className="whitespace-pre-wrap text-body-sm italic text-muted">{segment.text}</div>
        </CollapsedBlock>
      );
    case "tool_call":
      return (
        <CollapsedBlock label="Tool call" detail={segment.name}>
          {segment.input ? <PreBlock text={segment.input} /> : <p className="text-label text-muted">No input</p>}
        </CollapsedBlock>
      );
    case "tool_result":
      return (
        <CollapsedBlock label="Tool result">
          {segment.text ? <PreBlock text={segment.text} /> : <p className="text-label text-muted">Empty</p>}
        </CollapsedBlock>
      );
    case "artifact":
      return (
        <div className="rounded-sm border border-line bg-surface px-3 py-2">
          <p className="mb-2 text-label text-muted">
            Artifact <span className="font-mono text-ink-2">{segment.label}</span>
          </p>
          <ClampedText isUser={false} content={segment.text} />
        </div>
      );
    case "unknown":
      return (
        <CollapsedBlock label="Unrecognized block" detail={segment.label}>
          <PreBlock text={segment.text} />
        </CollapsedBlock>
      );
  }
}

function MessageBubble({ role, content, timestamp }: ConversationMessage) {
  const isUser = role === "user" || role === "human";
  const time = formatMessageTime(timestamp);
  const segments: MessageSegment[] = hasContentBlockMarkers(content)
    ? parseMessageSegments(content)
    : [{ kind: "text", text: content }];

  return (
    <div
      className={`rounded-card border p-4 ${isUser ? "ml-8 border-line-strong bg-raised" : "mr-8 border-line bg-surface"}`}
    >
      <div className="mb-2 flex items-center gap-2 text-label">
        <span className={`font-medium uppercase tracking-wider ${isUser ? "text-accent" : "text-ink-2"}`}>
          {isUser ? "You" : "Assistant"}
        </span>
        {time && <span className="text-muted">{time}</span>}
      </div>
      <div className="space-y-2">
        {segments.map((segment, j) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: segments are a pure function of the content; their order is their identity.
          <Segment key={j} segment={segment} isUser={isUser} />
        ))}
      </div>
    </div>
  );
}

type RenderItem =
  | { kind: "message"; index: number; message: ConversationMessage }
  | { kind: "noise"; index: number; content: string }
  | { kind: "quiet"; index: number; toolLines: string[]; trimmed: number };

function hasMirrorMetadata(msg: ConversationMessage): boolean {
  return !!msg.metadata && typeof msg.metadata === "object" && "idx" in msg.metadata;
}

/** Pure: decide what each stored message draws as, folding quiet runs (exported for tests). */
export function buildRenderItems(messages: ConversationMessage[]): RenderItem[] {
  const items: RenderItem[] = [];
  const quietTail = (): Extract<RenderItem, { kind: "quiet" }> | null => {
    const last = items[items.length - 1];
    return last && last.kind === "quiet" ? last : null;
  };

  messages.forEach((msg, index) => {
    const content = msg.content ?? "";
    const classification = classifyMessage(msg.role, content);
    if (classification.reason === "role") {
      items.push({ kind: "noise", index, content });
      return;
    }
    const empty = content.trim().length === 0;
    if (empty && !hasMirrorMetadata(msg)) return; // nothing to show, nothing to count
    if (empty || isToolOnlyMessage(content)) {
      let run = quietTail();
      if (!run) {
        run = { kind: "quiet", index, toolLines: [], trimmed: 0 };
        items.push(run);
      }
      if (empty) run.trimmed++;
      else run.toolLines.push(content.trim());
      return;
    }
    if (!hasContentBlockMarkers(content) && classification.isNoise) {
      items.push({ kind: "noise", index, content });
      return;
    }
    items.push({ kind: "message", index, message: msg });
  });
  return items;
}

export function MessageList({ messages }: { messages: ConversationMessage[] }) {
  return (
    <div className="space-y-4">
      {buildRenderItems(messages).map((item) => (
        // Keyed by the ORIGINAL array index (message_start_idx elsewhere
        // indexes into this exact array) — never a content-derived key.
        <div key={item.index}>
          {item.kind === "noise" ? (
            <NoiseRow content={item.content} />
          ) : item.kind === "quiet" ? (
            <QuietRun toolLines={item.toolLines} trimmed={item.trimmed} />
          ) : (
            <MessageBubble {...item.message} />
          )}
        </div>
      ))}
    </div>
  );
}
