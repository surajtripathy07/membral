import { getServiceClient } from "@/lib/db/clients";
import { selectAllRows } from "@/lib/util/pagination";

/**
 * ADR 0039 (W6/D7) — conversations lane: 'chat' (default) excludes
 * source='claude-code' code sessions from every count/list below, matching
 * "conversation list / search / sync counts exclude claude-code by default,
 * with a Code sessions toggle"; 'code' flips to ONLY code sessions; 'all'
 * mixes both lanes (used by the toggle's "show everything" state).
 */
export type ConversationLane = "all" | "chat" | "code";

export interface ConversationStats {
  total: number;
  bySource: Record<string, number>;
  byType: Record<string, number>;
  topTopics: Array<{ topic: string; count: number }>;
  recentConversations: Array<{
    id: string;
    source: string;
    title: string;
    created_at: string;
  }>;
  weeklyActivity: Array<{ week: string; count: number }>;
  page: number;
  pageSize: number;
  totalPages: number;
}

export async function getConversationStats(
  userId: string,
  page: number = 1,
  pageSize: number = 20,
  lane: ConversationLane = "chat",
): Promise<ConversationStats> {
  const supabase = getServiceClient();

  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  // ADR 0039 (W6/D7): applied to every conversations-table read below (not
  // the extracted_metadata join — that table is populated only by the old
  // chat-extraction pipeline and never by a code session, so it's a no-op
  // for the code lane in practice, and topics/type aren't part of this
  // task's "don't inflate the count" requirement anyway).
  //
  // Goal 2026-08-27 D5: `total`/`bySource`/`weeklyActivity` all need the
  // EXACT row set, not PostgREST's ~1000-row default page — a single
  // uncapped `.select()` here used to silently truncate `total`/`bySource`
  // once a user's corpus crossed 1,000 conversations (founder corpus is
  // 1,191 chat-lane rows alone). Paginate past the cap with the same
  // `selectAllRows` helper the KG pipeline already uses for this exact
  // problem (lib/kg/pagination.ts) instead of a `count:'exact', head:true`
  // aggregate — the per-week/per-source breakdowns need the actual rows,
  // and the corpus is small enough (low thousands) that draining it in
  // 1000-row pages is cheap.
  let conversations: Array<{ id: string; source: string; created_at: string | null }>;
  try {
    conversations = await selectAllRows<{ id: string; source: string; created_at: string | null }>(
      (rangeFrom, rangeTo) => {
        let q = supabase
          .from("conversations")
          .select("id, source, created_at")
          .eq("user_id", userId)
          .order("id", { ascending: true })
          .range(rangeFrom, rangeTo);
        if (lane === "chat") q = q.neq("source", "claude-code");
        else if (lane === "code") q = q.eq("source", "claude-code");
        return q;
      },
    );
  } catch (e) {
    throw new Error(`Failed to fetch conversations: ${(e as Error).message}`);
  }

  const metadataQuery = supabase
    .from("extracted_metadata")
    .select("topics, conversation_type, conversation_id, conversations!inner(user_id)")
    .eq("conversations.user_id", userId);

  let recentQuery = supabase.from("conversations").select("id, source, title, created_at").eq("user_id", userId);
  if (lane === "chat") recentQuery = recentQuery.neq("source", "claude-code");
  else if (lane === "code") recentQuery = recentQuery.eq("source", "claude-code");

  const [metadataResult, recentResult] = await Promise.all([
    metadataQuery,
    recentQuery.order("created_at", { ascending: false }).range(from, to),
  ]);

  if (metadataResult.error) {
    throw new Error(`Failed to fetch metadata: ${metadataResult.error.message}`);
  }
  if (recentResult.error) {
    throw new Error(`Failed to fetch recent conversations: ${recentResult.error.message}`);
  }

  const total = conversations.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const metadata = metadataResult.data ?? [];
  const recent = recentResult.data ?? [];

  // By source
  const bySource: Record<string, number> = {};
  for (const conv of conversations) {
    bySource[conv.source] = (bySource[conv.source] ?? 0) + 1;
  }

  // By type
  const byType: Record<string, number> = {};
  for (const m of metadata) {
    const type = m.conversation_type ?? "unknown";
    byType[type] = (byType[type] ?? 0) + 1;
  }

  // Top topics — flatten all topic arrays and count
  const topicCounts: Record<string, number> = {};
  for (const m of metadata) {
    const topics = m.topics ?? [];
    for (const topic of topics) {
      topicCounts[topic] = (topicCounts[topic] ?? 0) + 1;
    }
  }
  const topTopics = Object.entries(topicCounts)
    .map(([topic, count]) => ({ topic, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  // Recent conversations
  const recentConversations = recent.map((c) => ({
    id: c.id,
    source: c.source,
    title: c.title,
    created_at: c.created_at ?? "",
  }));

  // Weekly activity — last 12 weeks
  const weeklyActivity = buildWeeklyActivity(conversations);

  return {
    total,
    bySource,
    byType,
    topTopics,
    recentConversations,
    weeklyActivity,
    page,
    pageSize,
    totalPages,
  };
}

interface ConversationDateRow {
  created_at: string | null;
}

export function buildWeeklyActivity(conversations: ConversationDateRow[]): Array<{ week: string; count: number }> {
  const now = new Date();
  // Start of current week (Monday)
  const currentWeekStart = new Date(now);
  currentWeekStart.setHours(0, 0, 0, 0);
  const dayOfWeek = currentWeekStart.getDay();
  const diff = dayOfWeek === 0 ? 6 : dayOfWeek - 1; // Monday = 0
  currentWeekStart.setDate(currentWeekStart.getDate() - diff);

  // Build 12 week buckets
  const weeks: Array<{ start: Date; label: string; count: number }> = [];
  for (let i = 11; i >= 0; i--) {
    const weekStart = new Date(currentWeekStart);
    weekStart.setDate(weekStart.getDate() - i * 7);
    const label = weekStart.toISOString().slice(0, 10);
    weeks.push({ start: weekStart, label, count: 0 });
  }

  for (const conv of conversations) {
    const dateStr = conv.created_at;
    if (!dateStr) continue;
    const date = new Date(dateStr);

    for (let i = weeks.length - 1; i >= 0; i--) {
      if (date >= weeks[i].start) {
        // Check it's within this week (before next week start)
        const nextWeekStart =
          i < weeks.length - 1 ? weeks[i + 1].start : new Date(weeks[i].start.getTime() + 7 * 24 * 60 * 60 * 1000);
        if (date < nextWeekStart) {
          weeks[i].count++;
        }
        break;
      }
    }
  }

  return weeks.map(({ label, count }) => ({ week: label, count }));
}
