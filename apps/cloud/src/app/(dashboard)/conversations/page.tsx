import { PageFrame } from "@/components/ui/page-frame";
import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { formatRelativeDateShort } from "@/lib/format/dates";
import { getSourceMeta } from "@/lib/source-meta";
import { getConversationStats } from "@/lib/stats";
import type { ConversationStats } from "@/lib/stats";

const BRIDGE_CHAT_SOURCE = "claude-code-chat";

function getSourceStyle(source: string) {
  return getSourceMeta(source);
}

function getSourceLabel(source: string): string {
  return getSourceMeta(source).label;
}

export default async function ConversationsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const params = await searchParams;
  const page = Math.max(1, parseInt(params.page ?? "1", 10) || 1);

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  let stats: ConversationStats;
  try {
    // UX audit B8: the Chats/Code sessions/All toggle is gone — code sessions
    // live on /code now (their own dedicated surface), so this page is
    // always the 'chat' lane (ADR 0039's default), never 'code' or 'all'.
    stats = await getConversationStats(user.id, page, 20, "chat");
  } catch {
    return (
      <div className="text-error">
        Failed to load conversation stats. Please try again later.
      </div>
    );
  }

  const maxWeeklyCount = Math.max(...stats.weeklyActivity.map((w) => w.count), 1);
  // UX audit B8: the 5 stat tiles (Total, ChatGPT, Claude, Bridge chat, Code
  // sessions — the last two gone entirely: Bridge was deleted as a feature,
  // and Code sessions live on /code) become one header line, most-used
  // source first.
  // UX W6: the bridge was deleted, so its lane ("Bridge chat",
  // source='claude-code-chat') gets no count in the header; its old chats
  // still list below and still count in the total.
  const bySourceSorted = Object.entries(stats.bySource)
    .filter(([source]) => source !== BRIDGE_CHAT_SOURCE)
    .sort(([, a], [, b]) => b - a);

  return (
    <PageFrame width="data" className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-ink">Chats</h1>
        <p className="mt-1 text-sm text-muted">
          {stats.total} chat{stats.total === 1 ? "" : "s"}
          {bySourceSorted.length > 0 && (
            <>
              {" · "}
              {bySourceSorted.map(([source, count], i) => (
                <span key={source}>
                  {i > 0 && " · "}
                  <span className={getSourceStyle(source).text}>{getSourceLabel(source)}</span> {count}
                </span>
              ))}
            </>
          )}
        </p>
      </div>

      {/* Recent Conversations — decrowd pass (design review #119, item 5):
          promoted to position 2, right after the header, so it (and the
          first-run empty state) is never buried below several analytics
          sections a new user's account has nothing in yet. */}
      <div className="rounded-xl border border-line bg-surface p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-medium text-muted">
            {stats.page === 1 ? "Recent Conversations" : `Conversations — Page ${stats.page}`}
          </h2>
          <span className="text-xs text-muted">
            {stats.total} total
          </span>
        </div>
        {stats.recentConversations.length === 0 ? (
          <div className="text-sm text-muted">
            No conversations yet — import an export or install the extension.{" "}
            <Link href="/import" className="text-accent hover:underline">
              Import an export →
            </Link>{" "}
            <Link href="/setup" className="text-accent hover:underline">
              Get the extension →
            </Link>
          </div>
        ) : (
          <div className="divide-y divide-line">
            {stats.recentConversations.map((conv, i) => {
              const style = getSourceStyle(conv.source);
              // Carry the current list page through so the conversation's back
              // link can return here instead of always resetting to page 1.
              const detailHref =
                stats.page > 1 ? `/conversations/${conv.id}?page=${stats.page}` : `/conversations/${conv.id}`;
              return (
                <Link
                  key={conv.id}
                  href={detailHref}
                  className="sb-reveal flex items-center justify-between py-3 first:pt-0 last:pb-0 transition-colors hover:bg-raised -mx-2 px-2 rounded-lg"
                  style={{ animationDelay: `${Math.min(i, 10) * 30}ms` }}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${style.accent}`} />
                    <span className="truncate text-sm text-ink">
                      {conv.title || "Untitled"}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 shrink-0 ml-4">
                    <span className={`text-xs ${style.text}`}>
                      {getSourceLabel(conv.source)}
                    </span>
                    <span className="text-xs text-muted">
                      {formatRelativeDateShort(conv.created_at)}
                    </span>
                  </div>
                </Link>
              );
            })}
          </div>
        )}

        {/* Pagination */}
        {stats.totalPages > 1 && (
          <div className="mt-4 flex items-center justify-between border-t border-line pt-4">
            {stats.page > 1 ? (
              <Link
                href={`/conversations?page=${stats.page - 1}`}
                className="rounded-lg border border-line-strong px-3 py-1.5 text-sm text-ink-2 hover:border-muted hover:text-ink transition-colors"
              >
                Previous
              </Link>
            ) : (
              <span />
            )}
            <span className="text-xs text-muted">
              Page {stats.page} of {stats.totalPages}
            </span>
            {stats.page < stats.totalPages ? (
              <Link
                href={`/conversations?page=${stats.page + 1}`}
                className="rounded-lg border border-line-strong px-3 py-1.5 text-sm text-ink-2 hover:border-muted hover:text-ink transition-colors"
              >
                Next
              </Link>
            ) : (
              <span />
            )}
          </div>
        )}
      </div>

      {/* Decrowd pass (design review #119, item 5) — Weekly activity, Types /
          Topics / Cross-platform collapsed into one <details>, closed by
          default, so these analytics sections stop competing with the list
          above for a new user's attention. UX audit B8 folds Weekly Activity
          in here too (it used to sit visible, outside this disclosure) —
          nothing about any section's own data/props changed, only where they
          render. */}
      <details className="group rounded-xl border border-line bg-surface p-6">
        <summary className="flex cursor-pointer list-none items-center justify-between text-sm font-medium text-muted hover:text-ink-2">
          <span>More analytics</span>
          <svg
            className="h-4 w-4 shrink-0 text-muted transition-transform group-open:rotate-180"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 9l-7 7-7-7" />
          </svg>
        </summary>

        <div className="mt-4 space-y-4">
          {/* Weekly activity */}
          <div>
            <h3 className="mb-3 text-xs font-medium uppercase tracking-wide text-muted">Weekly Activity (Last 12 Weeks)</h3>
            <div className="flex items-end gap-2" style={{ height: "160px" }}>
              {stats.weeklyActivity.map(({ week, count }) => {
                const pct = maxWeeklyCount > 0 ? (count / maxWeeklyCount) * 100 : 0;
                return (
                  <div key={week} className="group/bar relative flex flex-1 flex-col items-center justify-end h-full">
                    {count > 0 && (
                      <span className="mb-1 text-xs text-muted group-hover/bar:text-ink-2">{count}</span>
                    )}
                    <div
                      className="w-full rounded-t bg-accent transition-colors group-hover/bar:opacity-90"
                      style={{
                        height: `${Math.max(pct, count > 0 ? 3 : 0)}%`,
                        minHeight: count > 0 ? "6px" : "0px",
                      }}
                    />
                    <div className="pointer-events-none absolute -top-8 left-1/2 -translate-x-1/2 rounded bg-line-strong px-2 py-1 text-xs text-ink opacity-0 transition-opacity group-hover/bar:opacity-100 whitespace-nowrap">
                      {week}: {count}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="mt-2 flex justify-between text-xs text-muted">
              <span>{stats.weeklyActivity[0]?.week}</span>
              <span>{stats.weeklyActivity[stats.weeklyActivity.length - 1]?.week}</span>
            </div>
          </div>

          {/* Types + topics, one row */}
          <div className="grid gap-4 lg:grid-cols-2">
            {/* Conversation types */}
            <div>
              <h3 className="mb-3 text-xs font-medium uppercase tracking-wide text-muted">Conversation Types</h3>
              {Object.keys(stats.byType).length === 0 ? (
                <p className="text-sm text-muted">No type data yet</p>
              ) : (
                <div className="space-y-3">
                  {Object.entries(stats.byType)
                    .sort(([, a], [, b]) => b - a)
                    .map(([type, count]) => {
                      const pct = stats.total > 0 ? (count / stats.total) * 100 : 0;
                      return (
                        <div key={type}>
                          <div className="mb-1 flex items-center justify-between text-sm">
                            <span className="text-ink-2">{type}</span>
                            <span className="text-muted">{count}</span>
                          </div>
                          <div className="h-2 rounded-full bg-raised">
                            <div
                              className="h-2 rounded-full bg-accent"
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                        </div>
                      );
                    })}
                </div>
              )}
            </div>

            {/* Top topics */}
            <div>
              <h3 className="mb-3 text-xs font-medium uppercase tracking-wide text-muted">Top Topics</h3>
              {stats.topTopics.length === 0 ? (
                <p className="text-sm text-muted">No topics yet</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {stats.topTopics.map(({ topic, count }) => (
                    <span
                      key={topic}
                      className="inline-flex items-center gap-1.5 rounded-full bg-raised px-3 py-1 text-sm text-ink-2"
                    >
                      {topic}
                      <span className="text-xs text-muted">{count}</span>
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Cross-platform comparison */}
          <CrossPlatformComparison stats={stats} />
        </div>
      </details>
    </PageFrame>
  );
}

function CrossPlatformComparison({ stats }: { stats: ConversationStats }) {
  // We need per-source type breakdown. Since we don't have that from the current
  // stats shape, we'll show a simpler comparison based on available data.
  const sources = Object.keys(stats.bySource);
  if (sources.length < 2) return null;

  // Find dominant source per type using a simple heuristic:
  // The source with the most conversations is likely the "workhorse"
  const sorted = Object.entries(stats.bySource).sort(([, a], [, b]) => b - a);
  const primary = sorted[0];
  const secondary = sorted[1];

  return (
    <div className="rounded-xl border border-line bg-surface p-6">
      <h2 className="mb-3 text-sm font-medium text-muted">Cross-Platform Usage</h2>
      <div className="flex flex-wrap gap-4">
        {sorted.map(([source, count]) => {
          const style = getSourceStyle(source);
          const pct = stats.total > 0 ? Math.round((count / stats.total) * 100) : 0;
          return (
            <div key={source} className="flex items-center gap-2">
              <span className={`inline-block h-3 w-3 rounded-full ${style.accent}`} />
              <span className={`text-sm ${style.text}`}>
                {getSourceLabel(source)}
              </span>
              <span className="text-sm text-muted">{pct}%</span>
            </div>
          );
        })}
      </div>
      {primary && secondary && (
        <p className="mt-3 text-sm text-muted">
          You use{" "}
          <span className={getSourceStyle(primary[0]).text}>
            {getSourceLabel(primary[0])}
          </span>{" "}
          most ({primary[1]} conversations), followed by{" "}
          <span className={getSourceStyle(secondary[0]).text}>
            {getSourceLabel(secondary[0])}
          </span>{" "}
          ({secondary[1]} conversations).
        </p>
      )}
    </div>
  );
}

