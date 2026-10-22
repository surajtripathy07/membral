"use client";

import { PageFrame } from "@/components/ui/page-frame";
import { useState, useRef, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { SearchResult, type SearchResultData } from "@/components/search-result";
import type { MemoryRow } from "@/lib/database.types";
import { MEMORY_TYPE_META } from "@/lib/memory-type-meta";
// Lane default is 'all' (goal 2026-08-27 D6 fix, #106) — consistent with /memories defaulting to All; the maintainer may reverse this one-line default.
import { createSearchRunner, type SearchLane, type SearchMode, type SearchTab } from "./search-runner";

const MODES: { value: SearchMode; label: string }[] = [
  { value: "hybrid", label: "Hybrid" },
  { value: "keyword", label: "Keyword" },
  { value: "semantic", label: "Semantic" },
];

const LANES: { value: SearchLane; label: string }[] = [
  { value: "chat", label: "Chats" },
  { value: "code", label: "Code sessions" },
  { value: "all", label: "All" },
];

const TABS: { value: SearchTab; label: string }[] = [
  { value: "all", label: "All" },
  { value: "conversations", label: "Conversations" },
  { value: "memories", label: "Memories" },
];

export default function SearchPage() {
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<SearchMode>("hybrid");
  const [tab, setTab] = useState<SearchTab>("all");
  const [lane, setLane] = useState<SearchLane>("all");
  const [results, setResults] = useState<SearchResultData[]>([]);
  const [memoryResults, setMemoryResults] = useState<MemoryRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // #173: one runner per mount; each query aborts the one before it, so a
  // stale response never overwrites newer results (see search-runner.ts).
  const runnerRef = useRef<ReturnType<typeof createSearchRunner> | null>(null);
  if (runnerRef.current === null) {
    runnerRef.current = createSearchRunner({
      getAccessToken: async () => {
        const {
          data: { session },
        } = await createClient().auth.getSession();
        return session?.access_token ?? null;
      },
      sink: { setResults, setMemoryResults, setLoading, setSearched },
    });
  }
  const runner = runnerRef.current;
  useEffect(() => () => runner.cancel(), [runner]);

  // Debounced search on query, mode, tab, or lane change
  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      void runner.run({ q: query, mode, tab, lane });
    }, 300);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [query, mode, tab, lane, runner]);

  const hasResults = results.length > 0 || memoryResults.length > 0;

  return (
    <PageFrame width="read">
      {/* Search input */}
      <div className="relative">
        <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-4">
          <svg
            className="h-5 w-5 text-muted"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </svg>
        </div>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search conversations and memories..."
          className="w-full rounded-xl border border-line bg-surface py-3.5 pl-12 pr-4 text-base text-ink placeholder-muted shadow-sm transition focus:border-accent focus:outline-none focus:ring-1 focus:ring-focus"
          autoFocus
        />
      </div>

      {/* Tab toggle — primary control */}
      <div className="mt-4 flex gap-1 rounded-lg bg-raised p-1">
        {TABS.map(({ value, label }) => (
          <button
            key={value}
            onClick={() => setTab(value)}
            className={`flex-1 rounded-md px-3 py-2 text-sm font-semibold transition ${
              tab === value
                ? "bg-raised text-ink shadow-sm"
                : "text-muted hover:text-ink-2"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Lane + Mode — secondary controls, shrunk to a compact right-aligned
          chip row (only relevant when conversations are in view). UX audit
          B9: Mode collapses behind an "Options" disclosure — Hybrid is
          already the default, so most visits never need it open; Lane stays
          visible since it changes what's searched, not just how. */}
      {(tab === "conversations" || tab === "all") && (
        <div className="mt-2 flex flex-wrap items-center justify-end gap-3">
          {/* Lane toggle (ADR 0039, W6/D7 follow-up) — Chats/Code
              sessions/All; excludes code sessions by default. */}
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] uppercase tracking-wide text-muted">Lane</span>
            <div className="flex gap-0.5 rounded-md bg-raised p-1">
              {LANES.map(({ value, label }) => (
                <button
                  key={value}
                  onClick={() => setLane(value)}
                  className={`rounded px-2 py-1 text-xs font-medium transition ${
                    lane === value
                      ? "bg-raised text-ink shadow-sm"
                      : "text-muted hover:text-ink-2"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <details className="group">
            <summary className="cursor-pointer list-none text-[11px] uppercase tracking-wide text-muted hover:text-ink-2">
              Options
              {mode !== "hybrid" && ` · ${MODES.find((m) => m.value === mode)?.label}`}
            </summary>
            <div className="mt-1.5 flex items-center justify-end gap-1.5">
              <span className="text-[11px] uppercase tracking-wide text-muted">Mode</span>
              <div className="flex gap-0.5 rounded-md bg-raised p-1">
                {MODES.map(({ value, label }) => (
                  <button
                    key={value}
                    onClick={() => setMode(value)}
                    className={`rounded px-2 py-1 text-xs font-medium transition ${
                      mode === value
                        ? "bg-raised text-ink shadow-sm"
                        : "text-muted hover:text-ink-2"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </details>
        </div>
      )}

      {/* Results */}
      <div className="mt-6">
        {loading && (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className="animate-pulse rounded-xl border border-line bg-surface p-4"
              >
                <div className="mb-2 flex gap-2">
                  <div className="h-5 w-16 rounded-full bg-raised" />
                  <div className="h-5 w-20 rounded bg-raised" />
                </div>
                <div className="h-4 w-3/4 rounded bg-raised" />
                <div className="mt-2 h-3 w-full rounded bg-raised" />
              </div>
            ))}
          </div>
        )}

        {!loading && hasResults && (
          <p className="mb-3 text-xs text-muted" data-testid="result-count">
            {results.length} conversation{results.length === 1 ? "" : "s"} · {memoryResults.length} memor{memoryResults.length === 1 ? "y" : "ies"}
          </p>
        )}

        {!loading && hasResults && (
          <div className="space-y-6">
            {/* Conversation results */}
            {results.length > 0 && (tab === "conversations" || tab === "all") && (
              <div>
                {tab === "all" && (
                  <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted">
                    Conversations
                  </h2>
                )}
                <div className="space-y-3">
                  {results.map((result, i) => (
                    <div key={result.id} className="sb-reveal" style={{ animationDelay: `${Math.min(i, 10) * 30}ms` }}>
                      <SearchResult result={result} />
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Memory results */}
            {memoryResults.length > 0 && (tab === "memories" || tab === "all") && (
              <div>
                {tab === "all" && (
                  <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted">
                    Memories
                  </h2>
                )}
                <div className="space-y-3">
                  {memoryResults.map((memory) => {
                    const style = MEMORY_TYPE_META[memory.type] ?? {
                      bg: "bg-raised",
                      text: "text-muted",
                    };
                    return (
                      <div
                        key={memory.id}
                        className="rounded-xl border border-line bg-surface p-4 transition hover:border-line"
                      >
                        <div className="mb-2 flex items-center gap-2">
                          <span
                            className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${style.bg} ${style.text}`}
                          >
                            {memory.type}
                          </span>
                          <span className="text-xs font-mono text-muted">
                            {Math.round(memory.confidence * 100)}%
                          </span>
                        </div>
                        <p className="text-sm text-ink">{memory.content}</p>
                        {memory.tags?.length > 0 && (
                          <div className="mt-2 flex flex-wrap gap-1">
                            {memory.tags.map((tag) => (
                              <span
                                key={tag}
                                className="rounded-full bg-raised px-2 py-0.5 text-xs text-muted"
                              >
                                {tag}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}

        {!loading && searched && !hasResults && (
          <div className="py-16 text-center">
            <p className="text-sm text-muted">
              No results found for &ldquo;{query}&rdquo;
            </p>
          </div>
        )}

        {!loading && !searched && (
          <div className="py-16 text-center">
            <svg
              className="mx-auto h-12 w-12 text-muted"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1}
                d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
              />
            </svg>
            <p className="mt-4 text-sm text-muted">
              Search your conversations and memories across all providers
            </p>
          </div>
        )}
      </div>
    </PageFrame>
  );
}
