"use client";

import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

// `className` replaces the default prose palette wholesale — the code
// session page passes a token-only palette (globals.css; CLAUDE.md rule 5)
// while the conversations view keeps the default below unchanged.
// react-markdown renders no raw HTML (no rehype-raw), so embedded tags in
// transcript text stay inert. remark-gfm adds pipe tables, strikethrough and
// task lists; tables are styled with tokens here so both palettes get them.
export function Markdown({ content, className }: { content: string; className?: string }) {
  return (
    <div className={className ?? DEFAULT_PROSE}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={TABLE_COMPONENTS}>
        {escapeLeadingHtmlTags(content)}
      </ReactMarkdown>
    </div>
  );
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const LEADING_TAG = /^( {0,3})<(?=\/?[A-Za-z])/;

/**
 * A line opening with `<tag>` / `</tag>` starts a CommonMark HTML block, which
 * swallows the whole paragraph as raw HTML — and raw HTML is never rendered,
 * so `**bold**` after `<analysis>` showed literally (or vanished). Escaping the
 * `<` outside code fences keeps the tag as literal text and lets the rest format.
 */
export function escapeLeadingHtmlTags(content: string): string {
  let fence: string | null = null;
  return (content ?? "")
    .split("\n")
    .map((line) => {
      const f = line.match(FENCE);
      if (f) {
        const mark = f[1];
        if (fence === null) fence = mark;
        else if (mark[0] === fence[0] && mark.length >= fence.length) fence = null;
        return line;
      }
      return fence === null ? line.replace(LEADING_TAG, "$1\\<") : line;
    })
    .join("\n");
}

const TABLE_COMPONENTS: Components = {
  table: ({ node: _node, ...props }) => (
    <div className="not-prose my-3 overflow-x-auto rounded-card border border-line">
      <table className="w-full border-collapse text-left text-body-sm text-ink-2" {...props} />
    </div>
  ),
  thead: ({ node: _node, ...props }) => <thead className="bg-raised text-ink" {...props} />,
  th: ({ node: _node, ...props }) => (
    <th className="border-b border-line px-3 py-1.5 font-medium" {...props} />
  ),
  td: ({ node: _node, ...props }) => <td className="border-t border-line-soft px-3 py-1.5 align-top" {...props} />,
};

const DEFAULT_PROSE =
  "prose prose-sm dark:prose-invert max-w-none prose-headings:text-ink prose-p:text-ink-2 prose-p:leading-relaxed prose-li:text-ink-2 prose-strong:text-ink prose-code:text-accent prose-code:bg-raised prose-code:rounded prose-code:px-1 prose-code:py-0.5 prose-code:text-xs prose-pre:bg-sunken prose-pre:border prose-pre:border-line prose-a:text-accent prose-blockquote:border-line prose-blockquote:text-muted prose-hr:border-line";
