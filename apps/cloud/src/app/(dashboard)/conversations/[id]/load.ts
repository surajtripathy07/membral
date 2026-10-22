// /conversations/[id] data loading (G3 step 3B-6a): the page's reads moved
// verbatim into a named loader — same chains, same sequential await order
// (conversations → [miss: service-role existence check] → memories). The
// page keeps the uuid guard, auth (getUser), the error state and render.

import { getConversationForPage, getConversationIdById } from "@/lib/conversations/queries";
import type { MemoryRow } from "@/lib/database.types";
import { tryServiceClient } from "@/lib/db/clients";
import type { Db } from "@/lib/db/types";
import { listMemoriesForConversation } from "@/lib/memory/queries";

// Row Level Security means a scoped (anon-key) query returns no row both when
// a conversation was deleted/never existed AND when it belongs to another
// user -- we can't tell those apart from that query alone. This bypasses RLS
// with the service role purely to check existence (never to read content),
// so the in-page error state can say which case it actually is.
async function conversationExistsAnywhere(id: string): Promise<boolean> {
  try {
    const service = tryServiceClient();
    if (!service) return false;
    const { data } = await getConversationIdById(service, id);
    return !!data;
  } catch {
    return false;
  }
}

export async function loadConversationPage(supabase: Db, userId: string, id: string) {
  const { data: conversation, error } = await getConversationForPage(supabase, userId, id);

  if (error || !conversation) {
    const exists = await conversationExistsAnywhere(id);
    return { kind: "missing" as const, exists };
  }

  // Fetch memories that reference this conversation
  const { data: relatedMemories } = await listMemoriesForConversation(supabase, userId, id);

  const memories: MemoryRow[] = relatedMemories ?? [];

  return { kind: "found" as const, conversation, memories };
}

export type ConversationPageData = Awaited<ReturnType<typeof loadConversationPage>>;
