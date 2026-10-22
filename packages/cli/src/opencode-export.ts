// opencode SQLite reader (goal 2026-09-12 W6/D5) — the CLI-side half of the
// opencode parser split with `packages/core/src/sessions/opencode.ts`. core
// has zero runtime dependencies, so it never touches a SQLite driver; this
// module queries `~/.local/share/opencode/opencode.db` directly and hands
// `opencodeParser.parse()` a plain JSON blob (`OpencodeSessionExport`,
// JSON.stringify'd) as its `raw` bytes — the same "parse() only ever
// operates on bytes already in memory" contract every parser follows.
//
// Driver choice: `node:sqlite` (Node's built-in synchronous SQLite binding,
// stable since Node 22.5, `readOnly` since 22.5 too). Deliberately NOT
// `better-sqlite3` (an extra dependency for something Node now ships) and
// NOT shelling out to the `sqlite3` binary (slower, harder to get
// structured rows out of safely, and not guaranteed present the way a Node
// built-in is).
//
// Node-version gate (2026-09-12 review, finding 1 — CI ran Node 20, which
// has no `node:sqlite` at all; a top-level static import crashed module
// evaluation for every test/binary that reached this file): the import is
// DYNAMIC (`await import("node:sqlite")`), so a Node < 22.5 host degrades
// gracefully to `sqliteUnavailable: true` (opencode reports as not
// importable) instead of crashing. `packages/cli/package.json` now also
// declares `"engines": {"node": ">=22.5.0"}` and CI runs Node 22.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  OpencodeMessageRow,
  OpencodePartRow,
  OpencodeSessionExport,
  OpencodeSessionRow,
  OpencodeSubAgentExport,
  SessionRef,
} from "@membral/core";

export function defaultOpencodeDbPath(root: string): string {
  return join(root, "opencode.db");
}

/**
 * F-008: `await import("node:sqlite")` itself raises Node's
 * ExperimentalWarning ("SQLite is an experimental feature...") the moment
 * the module loads — there's no per-import way to silence just that one
 * warning; `--no-warnings` would also hide every OTHER experimental-API
 * warning (fetch, etc.) for the whole process, which is too broad. Instead,
 * swap in a `process.emitWarning` that swallows only a warning named
 * `ExperimentalWarning` whose message mentions "SQLite", for the exact
 * duration of `fn`, then restore the original — every other warning
 * (including a differently-worded ExperimentalWarning) still comes
 * through unchanged.
 */
export async function withoutSqliteExperimentalWarning<T>(fn: () => Promise<T>): Promise<T> {
  const original = process.emitWarning;
  const filtered = (warning: string | Error, ...rest: unknown[]): void => {
    const message = warning instanceof Error ? warning.message : warning;
    const typeArg = rest[0];
    const name =
      warning instanceof Error
        ? warning.name
        : typeof typeArg === "string"
          ? typeArg
          : typeArg && typeof typeArg === "object" && "type" in typeArg
            ? ((typeArg as { type?: string }).type ?? "Warning")
            : "Warning";
    if (name === "ExperimentalWarning" && message.includes("SQLite")) return;
    (original as (...args: unknown[]) => void)(warning, ...rest);
  };
  process.emitWarning = filtered as typeof process.emitWarning;
  try {
    return await fn();
  } finally {
    process.emitWarning = original;
  }
}

export interface DiscoveredOpencodeSession {
  ref: SessionRef;
  /** JSON.stringify'd `OpencodeSessionExport` — pass straight to `opencodeParser.parse(ref, raw)`. */
  raw: string;
}

export interface OpencodeDiscoveryHandle {
  /**
   * True when the database file exists but couldn't be opened or queried
   * (corruption, permissions) — distinct from "no database yet" (opencode
   * never used on this machine, a legitimate empty state) and from
   * `sqliteUnavailable`. Mirrors claude-code.ts's `SessionRootUnreadableError`
   * distinction: "capture is broken" must never look identical to "nothing
   * new" (2026-09-12 review, finding 5).
   */
  unreadable: boolean;
  /**
   * True when this Node runtime has no `node:sqlite` (finding 1) — also a
   * distinct failure, not "no sessions".
   */
  sqliteUnavailable: boolean;
  /**
   * Lazily reads one session's messages/parts at a time as it's iterated —
   * never materializes the whole corpus in memory up front (2026-09-12
   * review, finding 4: the naive array-building version peaked at 523MB RSS
   * against this machine's 208MB database; a 1GB+ install would risk OOM,
   * and `membral agent`'s sweep runs this in-process).
   */
  sessions: AsyncGenerator<DiscoveredOpencodeSession>;
  /** Only meaningful after `sessions` has been fully consumed. */
  skippedCount(): number;
}

function emptyHandle(overrides: Partial<OpencodeDiscoveryHandle> = {}): OpencodeDiscoveryHandle {
  return {
    unreadable: false,
    sqliteUnavailable: false,
    // Intentionally empty — the "nothing to discover" case.
    sessions: (async function* emptyGenerator() {})(),
    skippedCount: () => 0,
    ...overrides,
  };
}

// Raw `session` table columns (snake_case, as SQLite returns them) —
// converted to the core package's camelCase `OpencodeSessionRow` below.
interface SessionRowRaw {
  id: string;
  parent_id: string | null;
  directory: string;
  title: string;
  agent: string | null;
  model: string | null;
  time_created: number;
  time_updated: number;
  cost: number;
  tokens_input: number;
  tokens_output: number;
  tokens_reasoning: number;
  tokens_cache_read: number;
  tokens_cache_write: number;
}

function toSessionRow(r: SessionRowRaw): OpencodeSessionRow {
  return {
    id: r.id,
    parentId: r.parent_id,
    directory: r.directory,
    title: r.title,
    agent: r.agent,
    modelRaw: r.model,
    timeCreated: r.time_created,
    timeUpdated: r.time_updated,
    cost: r.cost,
    tokensInput: r.tokens_input,
    tokensOutput: r.tokens_output,
    tokensReasoning: r.tokens_reasoning,
    tokensCacheRead: r.tokens_cache_read,
    tokensCacheWrite: r.tokens_cache_write,
  };
}

/**
 * Opens `<root>/opencode.db` and returns a handle that lazily yields every
 * top-level opencode session (`parent_id IS NULL`) plus its direct
 * sub-agent children, one at a time, as ready-to-parse JSON blobs.
 *
 * Never throws. Three distinct "nothing came back" shapes, on purpose (see
 * `OpencodeDiscoveryHandle`'s field docs): no database file at all (opencode
 * never used — legitimate empty state, `unreadable`/`sqliteUnavailable`
 * both false), `sqliteUnavailable` (Node < 22.5), and `unreadable` (the
 * database exists but can't be opened/queried — treat exactly like
 * claude-code's `SessionRootUnreadableError`: exit non-zero, skip the
 * heartbeat, never silently report "healthy, nothing new").
 */
export interface DiscoverOpencodeOptions {
  /**
   * --since prefilter: only top-level sessions with `time_updated` (epoch
   * ms) at or after this are selected. Descendants of a selected parent
   * are still exported whatever their own time_updated.
   */
  updatedSinceMs?: number;
}

export async function discoverOpencodeSessions(
  root: string,
  onWarn?: (message: string) => void,
  opts: DiscoverOpencodeOptions = {},
): Promise<OpencodeDiscoveryHandle> {
  const dbPath = defaultOpencodeDbPath(root);
  if (!existsSync(dbPath)) return emptyHandle();

  type SqliteModule = typeof import("node:sqlite");
  let DatabaseSync: SqliteModule["DatabaseSync"];
  try {
    ({ DatabaseSync } = await withoutSqliteExperimentalWarning(() => import("node:sqlite")));
  } catch (err) {
    onWarn?.(`opencode import needs Node >= 22.5 (node:sqlite unavailable): ${errMessage(err)}`);
    return emptyHandle({ sqliteUnavailable: true });
  }

  let db: InstanceType<SqliteModule["DatabaseSync"]>;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch (err) {
    onWarn?.(`failed to open opencode database at ${dbPath}: ${errMessage(err)}`);
    return emptyHandle({ unreadable: true });
  }

  // A db may hold only the legacy tables (`session`/`message`/`part`), only the
  // v2 tables (`session_v2`/`session_message`, written by newer opencode), or
  // both (opencode migrated legacy rows into v2 and kept the old ones).
  let hasLegacy = false;
  let hasV2 = false;
  try {
    const names = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as unknown as { name: string }[]).map(
        (r) => r.name,
      ),
    );
    hasLegacy = names.has("session") && names.has("message") && names.has("part");
    hasV2 = names.has("session_v2") && names.has("session_message");
    if (!hasLegacy && !hasV2) throw new Error("no opencode session tables found");
  } catch (err) {
    onWarn?.(`failed to query opencode sessions: ${errMessage(err)}`);
    closeQuietly(db);
    return emptyHandle({ unreadable: true });
  }

  const since = opts.updatedSinceMs === undefined ? undefined : Math.floor(opts.updatedSinceMs);
  // Where each session row came from; a v2 row always wins over a legacy row with the same id.
  const origin = new Map<string, "legacy" | "v2">();
  const v2Ids = new Set<string>();
  const merged = new Map<string, SessionRowRaw>();
  // A store whose tables lack a column this reader needs (or whose read fails) is reported and
  // dropped on its own; the other store in the same db still imports.
  let skipped = 0;
  let v2MessageOrder = "seq, id";
  if (hasLegacy) {
    try {
      const rows = (since === undefined
        ? db.prepare("SELECT * FROM session WHERE parent_id IS NULL ORDER BY id").all()
        : db
            .prepare("SELECT * FROM session WHERE parent_id IS NULL AND time_updated >= ? ORDER BY id")
            .all(since)) as unknown as SessionRowRaw[];
      for (const r of rows) {
        merged.set(r.id, r);
        origin.set(r.id, "legacy");
      }
    } catch (err) {
      onWarn?.(`  ! opencode legacy store unreadable, skipping it: ${errMessage(err)}`);
      hasLegacy = false;
      skipped++;
    }
  }
  if (hasV2) {
    try {
      const cols = new Set(
        (db.prepare("PRAGMA table_info(session_message)").all() as unknown as { name: string }[]).map((c) => c.name),
      );
      // `seq` is the message order; without it fall back to creation time.
      if (!cols.has("seq")) v2MessageOrder = "time_created, id";
      for (const r of db.prepare("SELECT id FROM session_v2").all() as unknown as { id: string }[]) v2Ids.add(r.id);
      // Selected when the session, any direct child, or any message of the session or of a direct
      // child changed since `since` (a parent's own time_updated is not guaranteed to move when a
      // sub-agent or a message does).
      const rows = (since === undefined
        ? db.prepare("SELECT * FROM session_v2 WHERE parent_id IS NULL ORDER BY id").all()
        : db
            .prepare(
              `SELECT * FROM session_v2 s WHERE s.parent_id IS NULL AND (
                 s.time_updated >= ?1
                 OR EXISTS (SELECT 1 FROM session_v2 c WHERE c.parent_id = s.id AND c.time_updated >= ?1)
                 OR EXISTS (SELECT 1 FROM session_message m WHERE m.session_id = s.id AND m.time_updated >= ?1)
                 OR EXISTS (SELECT 1 FROM session_v2 c JOIN session_message m ON m.session_id = c.id
                            WHERE c.parent_id = s.id AND m.time_updated >= ?1)
               ) ORDER BY s.id`,
            )
            .all(since)) as unknown as SessionRowRaw[];
      // v2 owns its ids over legacy rows
      for (const r of rows) {
        merged.set(r.id, r);
        origin.set(r.id, "v2");
      }
    } catch (err) {
      onWarn?.(`  ! opencode v2 store unreadable, skipping it: ${errMessage(err)}`);
      hasV2 = false;
      v2Ids.clear();
      skipped++;
    }
  }
  if (!hasLegacy && !hasV2) {
    onWarn?.("failed to query opencode sessions: no readable session store");
    closeQuietly(db);
    return emptyHandle({ unreadable: true });
  }
  for (const id of v2Ids) {
    if (origin.get(id) !== "legacy") continue;
    merged.delete(id);
    origin.delete(id);
  }
  const topLevel = [...merged.values()].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));

  const dbPathForRef = dbLabel(db, dbPath);

  async function* gen(): AsyncGenerator<DiscoveredOpencodeSession> {
    try {
      // Prepares can throw on a schema mismatch; that must cost one store, never the sweep.
      const tryPrepare = (sql: string, what: string) => {
        try {
          return db.prepare(sql);
        } catch (err) {
          onWarn?.(`  ! opencode ${what} unreadable: ${errMessage(err)}`);
          return undefined;
        }
      };
      const legacyMessageStmt = hasLegacy
        ? tryPrepare("SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created, id", "legacy messages")
        : undefined;
      const legacyPartStmt = hasLegacy
        ? tryPrepare(
            "SELECT message_id AS messageId, data FROM part WHERE session_id = ? ORDER BY time_created, id",
            "legacy parts",
          )
        : undefined;
      const v2MessageStmt = hasV2
        ? tryPrepare(
            `SELECT id, type, data FROM session_message WHERE session_id = ? ORDER BY ${v2MessageOrder}`,
            "v2 messages",
          )
        : undefined;
      // ORDER BY id (2026-09-12 review, finding 7) — without it, subAgents[]
      // ordering rested on SQLite's unspecified scan order rather than the
      // query itself, which is the one gap standing between "verified
      // byte-stable across two real runs" and "guaranteed byte-stable",
      // i.e. contentHash idempotency for a session with sub-agents.
      const legacyChildrenStmt = hasLegacy
        ? tryPrepare("SELECT * FROM session WHERE parent_id = ? ORDER BY id", "legacy children")
        : undefined;
      const v2ChildrenStmt = hasV2
        ? tryPrepare("SELECT * FROM session_v2 WHERE parent_id = ? ORDER BY id", "v2 children")
        : undefined;

      const v2Unknown = new Map<string, number>();
      let v2BadRows = 0;

      function childrenOf(parentId: string): SessionRowRaw[] {
        const merged = new Map<string, SessionRowRaw>();
        if (legacyChildrenStmt) {
          for (const r of legacyChildrenStmt.all(parentId) as unknown as SessionRowRaw[]) {
            if (v2Ids.has(r.id)) continue;
            merged.set(r.id, r);
            origin.set(r.id, "legacy");
          }
        }
        if (v2ChildrenStmt) {
          for (const r of v2ChildrenStmt.all(parentId) as unknown as SessionRowRaw[]) {
            merged.set(r.id, r);
            origin.set(r.id, "v2");
          }
        }
        return [...merged.values()].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
      }

      function messagesAndParts(id: string): { messages: OpencodeMessageRow[]; parts: OpencodePartRow[] } {
        if (origin.get(id) === "v2") {
          if (!v2MessageStmt) throw new Error("v2 message statement unavailable");
          const rows = v2MessageStmt.all(id) as unknown as V2MessageRow[];
          const out = v2ToLegacyRows(rows);
          v2BadRows += out.badRows;
          for (const [t, n] of out.unknownTypes) v2Unknown.set(t, (v2Unknown.get(t) ?? 0) + n);
          return { messages: out.messages, parts: out.parts };
        }
        if (!legacyMessageStmt || !legacyPartStmt) throw new Error("legacy message statements unavailable");
        return {
          messages: legacyMessageStmt.all(id) as unknown as OpencodeMessageRow[],
          parts: legacyPartStmt.all(id) as unknown as OpencodePartRow[],
        };
      }

      async function* exportDescendants(
        parentId: string,
        seen: Set<string>,
      ): AsyncGenerator<DiscoveredOpencodeSession> {
        let children: SessionRowRaw[];
        try {
          children = childrenOf(parentId);
        } catch (err) {
          onWarn?.(`  ! failed to read sub-agent sessions for ${parentId}: ${errMessage(err)}`);
          return;
        }
        for (const c of children) {
          if (seen.has(c.id)) continue; // a parent_id cycle must never loop forever
          seen.add(c.id);
          let raw: string;
          try {
            const child = toSessionRow(c);
            const grandchildren = childrenOf(child.id);
            const own = messagesAndParts(child.id);
            const childExport: OpencodeSessionExport = {
              session: child,
              messages: own.messages,
              parts: own.parts,
              subAgents:
                grandchildren.length > 0
                  ? grandchildren.map((g) => {
                      const gs = toSessionRow(g);
                      return { session: gs, messages: messagesAndParts(gs.id).messages };
                    })
                  : undefined,
            };
            raw = JSON.stringify(childExport);
          } catch (err) {
            skipped++;
            onWarn?.(`  ! skipping malformed opencode sub-agent session ${c.id}: ${errMessage(err)}`);
            continue;
          }
          yield {
            ref: { source: "opencode", sourceSessionId: c.id, path: `${dbPathForRef}#${c.id}` },
            raw,
          };
          yield* exportDescendants(c.id, seen);
        }
      }

      for (const row of topLevel) {
        try {
          const session = toSessionRow(row);
          const { messages, parts } = messagesAndParts(session.id);

          let subAgents: OpencodeSubAgentExport[] | undefined;
          try {
            const children = childrenOf(session.id);
            if (children.length > 0) {
              subAgents = children.map((c) => {
                const childSession = toSessionRow(c);
                return { session: childSession, messages: messagesAndParts(childSession.id).messages };
              });
            }
          } catch (err) {
            // One session's sub-agent lookup failing shouldn't drop the
            // session itself — degrade to "no sub-agents reported"
            // (SOURCE-OPTIONAL).
            onWarn?.(`  ! failed to read sub-agent sessions for ${session.id}: ${errMessage(err)}`);
          }

          const exportData: OpencodeSessionExport = { session, messages, parts, subAgents };
          yield {
            ref: { source: "opencode", sourceSessionId: session.id, path: `${dbPathForRef}#${session.id}` },
            raw: JSON.stringify(exportData),
          };

          // Every descendant (child, grandchild, …) is ALSO its own session
          // — its full messages/parts, `session.parentId` = its DIRECT
          // parent — yielded depth-first right after its parent so the
          // parser links it (`parentSessionId`) and its turns reach memory
          // extraction. One failing child is skipped, never the parent.
          yield* exportDescendants(session.id, new Set([session.id]));
        } catch (err) {
          skipped++;
          onWarn?.(`  ! skipping malformed opencode session row: ${errMessage(err)}`);
        }
      }

      if (v2BadRows > 0) onWarn?.(`  ! skipped ${v2BadRows} opencode v2 message row(s) with unreadable data`);
      if (v2Unknown.size > 0) {
        const summary = [...v2Unknown].map(([t, n]) => `${t} x${n}`).join(", ");
        onWarn?.(`  ! skipped opencode v2 message row(s) of unknown type: ${summary}`);
      }
    } finally {
      closeQuietly(db);
    }
  }

  return { unreadable: false, sqliteUnavailable: false, sessions: gen(), skippedCount: () => skipped };
}

// --- opencode v2 storage (`session_v2` + `session_message`) ---------------------------------
// v2 keeps one `session_message` row per message (`type`: user | assistant | system | synthetic |
// compaction | idle), ordered by `seq`. An assistant row's `data` carries its content blocks inline
// (`text`, `reasoning`, `tool` with call + result in `state`), so each row is re-expressed as one
// legacy `message` row plus its `part` rows, and the core parser needs no v2 branch. Row types that
// are not conversation turns (system prompt text, synthetic nudges, compaction snapshots, idle
// markers) are known and skipped silently; any other type is counted and reported once.

interface V2MessageRow {
  id: string;
  type: string;
  data: string;
}

const V2_SKIPPED_TYPES = new Set(["system", "synthetic", "compaction", "idle"]);

function asObject(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function v2ToolOutput(state: Record<string, unknown>): string {
  const content = Array.isArray(state.content) ? state.content : [];
  const texts: string[] = [];
  for (const item of content) {
    const o = asObject(item);
    if (o?.type === "text" && typeof o.text === "string") texts.push(o.text);
  }
  if (texts.length === 0 && state.status === "error") {
    const msg = asObject(state.error)?.message;
    if (typeof msg === "string") return msg;
  }
  return texts.join("\n");
}

export function v2ToLegacyRows(rows: V2MessageRow[]): {
  messages: OpencodeMessageRow[];
  parts: OpencodePartRow[];
  badRows: number;
  unknownTypes: Map<string, number>;
} {
  const messages: OpencodeMessageRow[] = [];
  const parts: OpencodePartRow[] = [];
  const unknownTypes = new Map<string, number>();
  let badRows = 0;
  for (const row of rows) {
    if (V2_SKIPPED_TYPES.has(row.type)) continue;
    if (row.type !== "user" && row.type !== "assistant") {
      unknownTypes.set(row.type, (unknownTypes.get(row.type) ?? 0) + 1);
      continue;
    }
    let data: Record<string, unknown> | undefined;
    try {
      data = asObject(JSON.parse(row.data));
    } catch {
      data = undefined;
    }
    if (!data) {
      badRows++;
      continue;
    }
    const time = asObject(data.time);
    const created = typeof time?.created === "number" ? time.created : undefined;
    if (row.type === "user") {
      messages.push({ id: row.id, data: JSON.stringify({ role: "user", time: { created } }) });
      if (typeof data.text === "string" && data.text) {
        parts.push({ messageId: row.id, data: JSON.stringify({ type: "text", text: data.text }) });
      }
      continue;
    }
    const model = asObject(data.model);
    messages.push({
      id: row.id,
      data: JSON.stringify({
        role: "assistant",
        modelID: typeof model?.id === "string" ? model.id : undefined,
        providerID: typeof model?.providerID === "string" ? model.providerID : undefined,
        time: { created, completed: typeof time?.completed === "number" ? time.completed : undefined },
        finish: typeof data.finish === "string" ? data.finish : undefined,
      }),
    });
    for (const block of Array.isArray(data.content) ? data.content : []) {
      const b = asObject(block);
      if (!b) {
        badRows++;
        continue;
      }
      const bt = asObject(b.time);
      const start = typeof bt?.created === "number" ? bt.created : created;
      if ((b.type === "text" || b.type === "reasoning") && typeof b.text === "string") {
        parts.push({ messageId: row.id, data: JSON.stringify({ type: b.type, text: b.text, time: { start } }) });
      } else if (b.type === "tool" && typeof b.name === "string") {
        const state = asObject(b.state) ?? {};
        parts.push({
          messageId: row.id,
          data: JSON.stringify({
            type: "tool",
            tool: b.name,
            callID: typeof b.id === "string" ? b.id : undefined,
            state: {
              status: state.status,
              input: asObject(state.input),
              output: v2ToolOutput(state),
              metadata: asObject(state.metadata),
              time: { start, end: typeof bt?.completed === "number" ? bt.completed : undefined },
            },
          }),
        });
      }
    }
  }
  return { messages, parts, badRows, unknownTypes };
}

function closeQuietly(db: { close(): void }): void {
  try {
    db.close();
  } catch {
    // already closed or never fully opened — nothing further to do
  }
}

function dbLabel(db: { location(dbName?: string): string | null }, dbPath: string): string {
  try {
    return db.location() ?? dbPath;
  } catch {
    return dbPath;
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
