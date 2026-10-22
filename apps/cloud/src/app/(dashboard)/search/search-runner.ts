// Search-as-you-type request handling for /search (#173). Each query gets its
// own AbortController and starting a new one aborts the previous, so a slow,
// stale response can never overwrite newer results: aborted fetches reject
// with AbortError (ignored), and every state write checks that its query is
// still the live one. Kept out of page.tsx (a page file may only export its
// component) so it is testable with a fake fetch.
import type { SearchResultData } from "@/components/search-result";
import type { MemoryRow } from "@/lib/database.types";

export type SearchMode = "hybrid" | "keyword" | "semantic";
export type SearchTab = "conversations" | "memories" | "all";
/** ADR 0039 (W6/D7 follow-up) — same lane contract as /conversations. */
export type SearchLane = "all" | "chat" | "code";

export interface SearchQuery {
  q: string;
  mode: SearchMode;
  tab: SearchTab;
  lane: SearchLane;
}

/** The page's state setters. */
export interface SearchSink {
  setResults: (results: SearchResultData[]) => void;
  setMemoryResults: (results: MemoryRow[]) => void;
  setLoading: (loading: boolean) => void;
  setSearched: (searched: boolean) => void;
}

export interface SearchRunnerDeps {
  /** The signed-in session's access token, or null when signed out. */
  getAccessToken: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
  sink: SearchSink;
}

export function createSearchRunner({ getAccessToken, fetchImpl = fetch, sink }: SearchRunnerDeps) {
  let current: AbortController | null = null;

  function cancel(): void {
    current?.abort();
    current = null;
  }

  async function run({ q, mode, tab, lane }: SearchQuery): Promise<void> {
    cancel();
    if (!q.trim()) {
      sink.setResults([]);
      sink.setMemoryResults([]);
      sink.setSearched(false);
      // The aborted query (if any) no longer clears the spinner itself.
      sink.setLoading(false);
      return;
    }

    const controller = new AbortController();
    current = controller;
    const { signal } = controller;
    const live = () => !signal.aborted;

    sink.setLoading(true);
    sink.setSearched(true);

    try {
      const token = await getAccessToken();
      if (!live()) return;
      if (!token) {
        sink.setResults([]);
        sink.setMemoryResults([]);
        return;
      }

      const headers = { Authorization: `Bearer ${token}` };
      const promises: Promise<void>[] = [];

      // Conversations
      if (tab === "conversations" || tab === "all") {
        const params = new URLSearchParams({ q: q.trim(), mode, limit: "20", lane });
        promises.push(
          fetchImpl(`/api/search?${params}`, { headers, signal })
            .then((res) => (res.ok ? res.json() : { results: [] }))
            .then((data) => {
              if (live()) sink.setResults(data.results ?? []);
            })
            .catch(() => {
              if (live()) sink.setResults([]);
            }),
        );
      } else {
        sink.setResults([]);
      }

      // Memories
      if (tab === "memories" || tab === "all") {
        const memParams = new URLSearchParams({ q: q.trim(), limit: "20" });
        promises.push(
          fetchImpl(`/api/memories?${memParams}`, { headers, signal })
            .then((res) => (res.ok ? res.json() : { memories: [] }))
            .then((data) => {
              if (live()) sink.setMemoryResults(data.memories ?? []);
            })
            .catch(() => {
              if (live()) sink.setMemoryResults([]);
            }),
        );
      } else {
        sink.setMemoryResults([]);
      }

      await Promise.all(promises);
    } catch {
      if (live()) {
        sink.setResults([]);
        sink.setMemoryResults([]);
      }
    } finally {
      if (current === controller) sink.setLoading(false);
    }
  }

  return { run, cancel };
}
