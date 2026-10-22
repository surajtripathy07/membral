import Link from "next/link";
import { formatDate } from "@/lib/format/dates";
import { formatSimilarity } from "@/lib/format/numbers";
import { getSourceMeta } from "@/lib/source-meta";

export interface SearchResultData {
  id: string;
  source: string;
  title: string;
  created_at: string | null;
  summary: string | null;
  similarity: number | null;
}

export function SearchResult({ result }: { result: SearchResultData }) {
  const style = getSourceMeta(result.source);
  const date = formatDate(result.created_at);
  const similarity = formatSimilarity(result.similarity);

  return (
    <Link
      href={`/conversations/${result.id}`}
      className="group block rounded-xl border border-line bg-surface p-4 transition hover:border-line hover:bg-raised/80"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="mb-2 flex items-center gap-2">
            <span
              className={`inline-flex shrink-0 items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${style.bg} ${style.text}`}
            >
              {style.label}
            </span>
            {date && (
              <span className="text-xs text-muted">{date}</span>
            )}
          </div>
          <h3 className="truncate text-sm font-medium text-ink group-hover:text-accent">
            {result.title || "Untitled"}
          </h3>
          {result.summary && (
            <p className="mt-1 line-clamp-2 text-sm text-muted">
              {result.summary}
            </p>
          )}
        </div>
        {similarity && (
          <span className="shrink-0 rounded-md bg-accent-soft px-2 py-1 text-xs font-mono text-accent">
            {similarity}
          </span>
        )}
      </div>
    </Link>
  );
}
