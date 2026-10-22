import { PageFrame } from "@/components/ui/page-frame";
import { createClient } from "@/lib/supabase/server";
import Link from "next/link";
import { notFound } from "next/navigation";
import { isUuid } from "@/lib/device-auth";
import { getMemoryTypeMeta } from "@/lib/memory-type-meta";
import { getSourceMeta } from "@/lib/source-meta";
import { loadConversationPage } from "./load";
import { type ConversationMessage, MessageList } from "./message-list";

function BackToConversationsLink({ href, className }: { href: string; className: string }) {
  return (
    <Link href={href} className={className}>
      <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 19l-7-7 7-7" />
      </svg>
      Back to conversations
    </Link>
  );
}

function ConversationErrorState({ kind, backHref }: { kind: "not-found" | "no-access"; backHref: string }) {
  const copy =
    kind === "no-access"
      ? {
          title: "You don't have access to this conversation",
          body: "It may belong to a different account, or your session may have expired. Try signing in again, or head back to your conversations.",
        }
      : {
          title: "Conversation not found",
          body: "This conversation may have been deleted, or the link is out of date.",
        };

  return (
    <PageFrame width="read">
      <BackToConversationsLink
        href={backHref}
        className="mb-6 inline-flex items-center gap-1 text-sm text-muted transition hover:text-ink-2"
      />
      <div className="rounded-xl border border-line bg-surface p-8 text-center">
        <svg
          className="mx-auto h-10 w-10 text-faint"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1}
            d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z"
          />
        </svg>
        <h1 className="mt-4 text-lg font-semibold text-ink">{copy.title}</h1>
        <p className="mx-auto mt-2 max-w-sm text-sm text-muted">{copy.body}</p>
        <Link
          href={backHref}
          className="mt-6 inline-block rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-ink transition-colors hover:bg-accent/90"
        >
          Back to conversations
        </Link>
      </div>
    </PageFrame>
  );
}

export default async function ConversationDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ page?: string }>;
}) {
  const { id } = await params;
  // A non-uuid segment is a 404, never a Postgres uuid-cast 500 (review r2 N6).
  if (!isUuid(id)) notFound();
  const { page } = await searchParams;
  const listPage = Math.max(1, parseInt(page ?? "1", 10) || 1);
  const backHref = listPage > 1 ? `/conversations?page=${listPage}` : "/conversations";

  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return <ConversationErrorState kind="no-access" backHref={backHref} />;
  }

  const loaded = await loadConversationPage(supabase, user.id, id);

  if (loaded.kind === "missing") {
    return <ConversationErrorState kind={loaded.exists ? "no-access" : "not-found"} backHref={backHref} />;
  }

  const { conversation, memories } = loaded;

  const messages: ConversationMessage[] = Array.isArray(conversation.messages) ? conversation.messages : [];

  const sourceStyle = getSourceMeta(conversation.source ?? "");

  const date = conversation.created_at
    ? new Date(conversation.created_at).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : null;

  return (
    <PageFrame width="read">
      {/* Back link */}
      <BackToConversationsLink
        href={backHref}
        className="mb-6 inline-flex items-center gap-1 text-sm text-muted transition hover:text-ink-2"
      />

      {/* Header */}
      <div className="mb-8">
        <div className="mb-2 flex items-center gap-2">
          <span className={`text-xs font-medium ${sourceStyle.text}`}>
            {sourceStyle.label}
          </span>
          {conversation.model && (
            <span className="text-xs text-muted">{conversation.model}</span>
          )}
          {date && <span className="text-xs text-muted">{date}</span>}
        </div>
        <h1 className="text-2xl font-bold text-ink">
          {conversation.title || "Untitled"}
        </h1>
      </div>

      {/* Messages */}
      {messages.length === 0 ? (
        <p className="py-12 text-center text-sm text-muted">
          No messages in this conversation.
        </p>
      ) : (
        <MessageList messages={messages} />
      )}

      {/* Related Memories */}
      {memories.length > 0 && (
        <div className="mt-10">
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-muted">
            Related Memories
          </h2>
          <div className="space-y-2">
            {memories.map((memory) => {
              const style = getMemoryTypeMeta(memory.type);
              return (
                <div
                  key={memory.id}
                  className="rounded-xl border border-line bg-surface p-3"
                >
                  <div className="mb-1 flex items-center gap-2">
                    <span
                      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${style.bg} ${style.text}`}
                    >
                      {memory.type}
                    </span>
                    <span className="text-xs font-mono text-muted">
                      {Math.round(memory.confidence * 100)}%
                    </span>
                  </div>
                  <p className="text-sm text-ink-2">{memory.content}</p>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </PageFrame>
  );
}
