/**
 * /memories: memory v1 records (`session_memories`) --
 *   what Membral remembered from coding sessions, the records agents are
 *   served (docs/design/memory-v1.md §2/§4). Server-rendered from
 *   ?project= (id or name) / ?kind= / ?q= / ?page=; a non-empty ?q= runs
 *   the same `memorySearch` agents call. Fetching lives in
 *   lib/memory/session-memories-browse.ts, render in
 *   session-memories-content.tsx.
 */
import { log } from "@/lib/log";
import {
  type BrowseSessionMemory,
  listMemoryProjects,
  countSessionMemoriesByKind,
  listSessionMemories,
  type MemoryProjectOption,
  parseMemoryKind,
  parsePage,
  resolveProjectParam,
  SESSION_MEMORIES_PAGE_SIZE,
  searchSessionMemories,
} from "@/lib/memory/session-memories-browse";
import { createClient } from "@/lib/supabase/server";
import type { MemoryKind } from "@/lib/memory/schema";
import { SessionMemoriesContent } from "./session-memories-content";

function firstOrNull(v: string | string[] | undefined): string | null {
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

export default async function MemoriesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const q = (firstOrNull(sp.q) ?? "").trim();
  const kind = parseMemoryKind(firstOrNull(sp.kind));
  const page = parsePage(firstOrNull(sp.page));

  let projects: MemoryProjectOption[] = [];
  let records: BrowseSessionMemory[] = [];
  let hasMore = false;
  let kindCounts: Partial<Record<MemoryKind, number>> | null = null;
  let degraded: string | undefined;
  let error: string | null = null;
  let project: MemoryProjectOption | null = null;

  if (user) {
    try {
      // #173: with no ?project= the filter is null whatever the project list
      // holds, so the list/search and count reads start alongside
      // listMemoryProjects instead of after it (the helpers await the list
      // only for the name join). With ?project= the id has to be resolved
      // from the list first, so that path stays sequential. Any of the
      // three failing still lands in the same catch below.
      const projectParam = firstOrNull(sp.project);
      const projectsRead = listMemoryProjects(supabase, user.id);
      if (projectParam) {
        projects = await projectsRead;
        project = resolveProjectParam(projects, projectParam);
      }
      const projectId = project?.id ?? null;
      const projectsInput = projectParam ? projects : projectsRead;
      // UX W6: counts for the kind chips; a failed count only drops the numbers.
      const counting = countSessionMemoriesByKind(supabase, user.id, { projectId }).catch(() => null);
      const reading = q
        ? searchSessionMemories(supabase, user.id, projectsInput, { query: q, projectId, kind }).then((result) => ({
            records: result.records,
            degraded: result.degraded,
            hasMore: false,
          }))
        : listSessionMemories(supabase, user.id, projectsInput, {
            projectId,
            kind,
            limit: SESSION_MEMORIES_PAGE_SIZE,
            offset: (page - 1) * SESSION_MEMORIES_PAGE_SIZE,
          }).then((result) => ({ records: result.records, degraded: undefined, hasMore: result.hasMore }));
      // allSettled, then surface failures in the old order (projects, then
      // records): a failed records read still renders with the project
      // dropdown filled and no counts, exactly as when the reads were serial.
      const [projectsSettled, readSettled] = await Promise.allSettled([projectsRead, reading]);
      if (projectsSettled.status === "rejected") throw projectsSettled.reason;
      projects = projectsSettled.value;
      if (!projectParam) project = resolveProjectParam(projects, projectParam);
      if (readSettled.status === "rejected") throw readSettled.reason;
      records = readSettled.value.records;
      degraded = readSettled.value.degraded;
      hasMore = readSettled.value.hasMore;
      kindCounts = await counting;
    } catch (e) {
      log.warn("memories page: session memories read failed", { user_id: user.id, error: (e as Error).message });
      error = q ? "Search failed. Try again, or clear the search to browse." : "Could not load memories. Try reloading.";
    }
  }

  return (
    <SessionMemoriesContent
      records={records}
      projects={projects}
      filters={{ project, kind, q, page }}
      hasMore={hasMore}
      kindCounts={kindCounts}
      degraded={degraded}
      error={error}
    />
  );
}
