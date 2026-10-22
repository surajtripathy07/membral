// Sync & Memory State panel — pure render half (sync-state-panel.tsx owns
// fetch/state, same page.tsx ÷ *-content.tsx split as pulse-content.tsx /
// agent-work-content.tsx). Renders one row per chat source / code harness
// and a Memory row — dark theme, hand-rolled, matching the Second-Brain
// design tokens the rest of /pulse already uses.
//
// The Devices row (online/offline per machine) was removed with the bridge
// (2026-09-12 refocus goal, W2 kill list): its "online" signal was
// devices.last_seen_at bumped by every `membral agent` poll — with that
// daemon gone, nothing refreshes it and every device would read as
// permanently offline. Issue #139 (a remove-control for stray devices on
// this now-gone panel) is moot as a result.
//
// UX audit B2: collapsed to one summary line inside a native <details>; UX
// pass 2 rewrote it as plain sentences shown only when they apply
// (summarizeSync); opening it shows
// the full rows. When something needs action — a source that never synced or
// went stale, or a failed read — the line itself says which source, turns
// warn, and carries the fix link, so the action is visible without the full
// five-row panel taking the first screen. The old "Today · current through …"
// freshness strip folds into the summary's tooltip.
import Link from "next/link";
import { formatAgoLong, formatRelativeShort } from "@/lib/format/dates";
import type { SyncSourceState } from "@/lib/sync-state-rules";
import type { SyncStateResponse } from "@/lib/sync-state-shape";

const SOURCE_LABEL: Record<string, string> = { claude: "Claude", chatgpt: "ChatGPT", grok: "Grok" };
function chatSourceLabel(source: string): string {
  return SOURCE_LABEL[source] ?? source;
}

const STATE_LABEL: Record<SyncSourceState, string> = {
  never: "never synced",
  idle: "idle",
  syncing: "syncing",
  quiet: "quiet",
  stale: "stale",
};
/** Semantic pill color (status tokens): ok idle, syncing syncing, warn quiet/stale, muted never. */
function pillClasses(state: SyncSourceState): string {
  switch (state) {
    case "idle":
      return "border-line text-ok";
    case "syncing":
      return "border-line text-syncing";
    case "quiet":
    case "stale":
      return "border-line text-warn";
    default:
      return "border-line text-muted";
  }
}

function StatePill({ state, label }: { state: SyncSourceState; label: string }) {
  return (
    <span className={`inline-flex shrink-0 items-center rounded-xs border px-1.5 py-0.5 text-label ${pillClasses(state)}`}>
      {label}
    </span>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-body-sm">{children}</div>;
}

function RowLabel({ children }: { children: React.ReactNode }) {
  return <span className="w-24 shrink-0 text-ink">{children}</span>;
}

function RowMeta({ children }: { children: React.ReactNode }) {
  return <span className="text-label text-muted tabular-nums">{children}</span>;
}

/** Chat sources the import page takes an export for, and its per-source instructions anchor. */
const IMPORTABLE: Record<string, string> = { chatgpt: "/import#chatgpt", claude: "/import#claude" };

/** One plain sentence on the status line; `action` is its fix. */
export interface SyncPart {
  text: string;
  action?: { href: string; label: string };
  warn?: boolean;
}

export interface SyncSummary {
  /** The sentences, in order (each only when it applies). */
  parts: SyncPart[];
  /** The parts joined, for tooltips/tests. */
  text: string;
  /** Something needs the user (a source went stale, nothing synced yet, the read failed): the line turns warn. */
  needsAction: boolean;
}

const summary = (parts: SyncPart[]): SyncSummary => ({
  parts,
  text: parts.map((p) => (p.action ? `${p.text} — ${p.action.label}` : p.text)).join(" · "),
  needsAction: parts.some((p) => p.warn),
});

/**
 * Today's one quiet status line, in plain sentences (maintainer, UX pass 2):
 * each part says what it means and what to do, and appears only when it
 * applies. Sources, from /api/sync-state (lib/sync-state-shape.ts):
 *   - chat row `state` stale/never + `lastRunAt` (sync-state-rules.ts deriveChatSourceState)
 *   - code harness rows (deriveCodeHarnessState); none at all = no sessions yet
  * Nothing to say → "Everything is up to date".
 */
export function summarizeSync(data: SyncStateResponse | null, error: string | null, loading: boolean, now: Date = new Date()): SyncSummary {
  if (loading && !data) return summary([{ text: "Checking sync status…" }]);
  if (error || !data) return summary([{ text: "Sync status is unavailable right now — try again shortly", warn: Boolean(error) }]);
  const parts: SyncPart[] = [];

  // Chats (the second lane): a stale source says how old its history is. "Never" speaks only when no chat
  // source has ever synced — an unused source (say Grok) is not a problem to report.
  const anyChat = data.chat.some((r) => r.state !== "never");
  for (const row of data.chat) {
    const label = chatSourceLabel(row.source);
    const href = IMPORTABLE[row.source];
    if (row.state === "stale") {
      const age = formatAgoLong(row.lastRunAt ?? row.lastItemAt, now);
      parts.push({
        text: age ? `${label} history last imported ${age}` : `${label} history hasn't synced recently`,
        action: href ? { href, label: `Import a newer ${label} export →` } : { href: "/setup", label: "Check the extension →" },
        warn: true,
      });
    }
  }
  if (!anyChat && data.chat.length > 0) {
    parts.push({ text: "No chat history yet", action: { href: "/import", label: "Import a ChatGPT or Claude export →" } });
  }

  // Coding sessions (the product's first lane).
  if (data.code.length === 0) {
    parts.push({ text: "No coding sessions yet", action: { href: "/setup", label: "Set up the CLI →" }, warn: true });
  }
  for (const row of data.code) {
    if (row.state !== "stale" && row.state !== "never") continue;
    const age = formatAgoLong(row.lastSessionAt, now);
    parts.push({
      text: age ? `${row.harness} last sent a session ${age}` : `${row.harness} hasn't sent a session yet`,
      action: { href: "/setup", label: "Check setup →" },
      warn: true,
    });
  }

  if (parts.length === 0) parts.push({ text: "Everything is up to date" });
  return summary(parts);
}

export interface SyncStateContentProps {
  loading: boolean;
  error: string | null;
  data: SyncStateResponse | null;
  now?: Date;
  /** Tooltip on the summary line — the per-lane "current through" dates (the deleted freshness strip). */
  freshnessTitle?: string;
}

export function SyncStateContent({ loading, error, data, now = new Date(), freshnessTitle }: SyncStateContentProps) {
  const line = summarizeSync(data, error, loading, now);
  return (
    <details className="group" data-testid="sync-summary" data-needs-action={line.needsAction || undefined}>
      <summary
        className={`cursor-pointer list-none text-body-sm hover:text-ink-2 ${line.needsAction ? "text-warn" : "text-muted"}`}
        title={freshnessTitle || undefined}
      >
        <span className="mr-1.5 inline-block transition group-open:rotate-90" aria-hidden="true">
          ▸
        </span>
        {line.parts.map((p, i) => (
          <span key={p.text} data-testid="sync-part">
            {i > 0 && " · "}
            {p.text}
            {p.action && (
              <>
                {" — "}
                <Link href={p.action.href} className="text-accent underline underline-offset-2 hover:text-ink">
                  {p.action.label}
                </Link>
              </>
            )}
          </span>
        ))}
      </summary>
      <div className="mt-2 rounded-card border border-line bg-surface px-4 py-2">
      {loading && !data && (
        <div className="mt-2 space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static shimmer placeholders
            <div key={i} className="h-6 animate-pulse rounded bg-raised" />
          ))}
        </div>
      )}

      {!loading && error && <p className="py-2 text-body-sm text-muted">Sync state unavailable — try again shortly.</p>}

      {!error && data && (
        <div className="divide-y divide-border-soft">
          {data.chat.map((row) => (
            <Row key={row.source}>
              <RowLabel>{chatSourceLabel(row.source)}</RowLabel>
              <StatePill state={row.state} label={STATE_LABEL[row.state]} />
              {row.state === "never" ? (
                <span className="text-body-sm text-ink-2">
                  Never synced —{" "}
                  <Link href="/import" className="text-accent underline underline-offset-2 hover:text-ink">
                    import an export
                  </Link>{" "}
                  or{" "}
                  <Link href="/setup" className="text-accent underline underline-offset-2 hover:text-ink">
                    install the extension
                  </Link>
                </span>
              ) : (
                <>
                  <RowMeta>{row.conversations.toLocaleString()} conversations</RowMeta>
                  <RowMeta>last item {formatRelativeShort(row.lastItemAt, now)}</RowMeta>
                  <RowMeta>last run {formatRelativeShort(row.lastRunAt, now)}</RowMeta>
                  {row.note && <span className="text-label text-muted">· {row.note}</span>}
                </>
              )}
            </Row>
          ))}

          {data.code.length === 0 ? (
            <Row>
              <RowLabel>Code</RowLabel>
              <StatePill state="never" label={STATE_LABEL.never} />
              <span className="text-body-sm text-ink-2">
                No code sessions yet — needs the CLI,{" "}
                <Link href="/setup" className="text-accent underline underline-offset-2 hover:text-ink">
                  see Setup
                </Link>
              </span>
            </Row>
          ) : (
            data.code.map((row) => (
              <Row key={row.harness}>
                <RowLabel>{row.harness}</RowLabel>
                <StatePill state={row.state} label={STATE_LABEL[row.state]} />
                <RowMeta>{row.projects.toLocaleString()} projects</RowMeta>
                <RowMeta>{row.sessions.toLocaleString()} sessions</RowMeta>
                <RowMeta>last session {formatRelativeShort(row.lastSessionAt, now)}</RowMeta>
                {row.note && <span className="text-label text-muted">· {row.note}</span>}
              </Row>
            ))
          )}
        </div>
      )}
      </div>
    </details>
  );
}
