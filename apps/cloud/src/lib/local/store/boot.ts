// Opens the embedded store (rung two, docs/design/2026-10-25_docker-free-store.md): PGlite with pgvector, one owner
// per data dir, prelude + migrations, ANALYZE, registered for the shim. Called from instrumentation.ts before the
// extraction loop. A no-op unless local mode, not on Vercel, and MEMBRAL_STORE=pglite.
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { migrationsDir, pgDataDir, preludePath, storeKind } from "@/lib/env";
import { isLocalMode } from "@/lib/local/mode";
import { acquireLock } from "./lock";
import { type Maintenance, startMaintenance } from "./maintenance";
import { applyMigrations, applyPrelude } from "./migrate";
import { clearStore, getStore, registerStore, setStoreState } from "./registry";
import type { QueryResult, StoreHandle, StoreTx } from "./types";

const SEARCH_PATH = "public, extensions";
// timestamptz columns must serialise as `...+00:00` whatever TZ the process runs under (PostgREST behind Postgres does).
const TIMEZONE = "UTC";

function toResult(r: { rows: unknown[]; affectedRows?: number; fields: { name: string }[] }): QueryResult {
  return {
    rows: r.rows as Record<string, unknown>[],
    affectedRows: r.affectedRows,
    fields: r.fields.map((f) => ({ name: f.name })),
  };
}

interface TxContext {
  done: boolean;
  after: (() => void)[];
}
// Marks code running inside a handle.transaction callback, so a re-entrant handle call (which would wait for the very
// queue slot it occupies, forever) fails loudly instead.
const txContext = new AsyncLocalStorage<TxContext>();
const REENTRANT = "store.query called inside a transaction; use the tx argument";

/** Runs fn after the current transaction finishes; returns false (and does nothing) when not inside one. */
function deferAfterTransaction(fn: () => void): boolean {
  const c = txContext.getStore();
  if (!c || c.done) return false;
  c.after.push(fn);
  return true;
}

/** A rejection (not a synchronous throw) so callers can `.catch()` it. For fire-and-forget work started inside a
 *  transaction callback, wrap it in `txContext.exit(() => ...)` so it queues behind the transaction instead. */
function reentrantRejection(): Promise<never> | undefined {
  const c = txContext.getStore();
  return c && !c.done ? Promise.reject(new Error(REENTRANT)) : undefined;
}

/** Wraps a PGlite as a StoreHandle: one statement or transaction at a time (promise mutex). */
export function createPgliteHandle(db: PGlite, opts: { onWrite?: () => void } = {}): StoreHandle {
  let tail: Promise<unknown> = Promise.resolve();
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => undefined);
    return run;
  };
  return {
    kind: "pglite",
    query: (sql, params) => {
      const re = reentrantRejection();
      if (re) return re;
      return serialize(async () => toResult(await db.query(sql, params as unknown[])));
    },
    transaction: <T>(fn: (tx: StoreTx) => Promise<T>) => {
      const re = reentrantRejection();
      if (re) return re;
      return serialize(async () => {
        const ctx: TxContext = { done: false, after: [] };
        await db.exec("begin");
        try {
          await db.exec(`set local search_path = ${SEARCH_PATH}`);
          await db.exec(`set local timezone = '${TIMEZONE}'`);
          const tx: StoreTx = { query: async (sql, params) => toResult(await db.query(sql, params as unknown[])) };
          const out = await txContext.run(ctx, () => fn(tx));
          await db.exec("commit");
          return out;
        } catch (e) {
          await db.exec("rollback").catch(() => undefined);
          throw e;
        } finally {
          ctx.done = true;
          for (const f of ctx.after.splice(0)) f(); // deferred work queues behind this transaction
        }
      });
    },
    noteWrite: () => opts.onWrite?.(),
  };
}

export interface BootedStore {
  handle: StoreHandle;
  db: PGlite;
  /** Runs ANALYZE now, through the handle's queue (never inside a request transaction). */
  analyzeNow(): Promise<void>;
  close(): Promise<void>;
}

export interface BootOptions {
  dataDir?: string;
  migrationsDir?: string;
  preludeFile?: string;
  /** Install SIGTERM/SIGINT handlers (default true). */
  signals?: boolean;
  analyzeIntervalMs?: number;
}

/** Opens and registers the store. Returns undefined when the environment does not ask for one. */
export async function bootEmbeddedStore(opts: BootOptions = {}): Promise<BootedStore | undefined> {
  if (!isLocalMode() || storeKind() !== "pglite") return undefined;
  const existing = getStore();
  if (existing) return undefined; // HMR or a double register(): never open a second store
  setStoreState("starting");
  let release: (() => void) | undefined;
  let db: PGlite | undefined;
  let maintenance: Maintenance | undefined;
  try {
    const dataDir = opts.dataDir ?? pgDataDir();
    if (!dataDir) throw new Error("MEMBRAL_STORE=pglite needs MEMBRAL_PGDATA (the data directory).");
    const migDir = opts.migrationsDir ?? migrationsDir() ?? path.join(process.cwd(), "supabase", "migrations");
    const prelude = opts.preludeFile ?? preludePath() ?? path.join(migDir, "..", "local", "auth-prelude.sql");
    if (!fs.existsSync(prelude)) throw new Error(`Auth prelude not found: ${prelude}`);

    const inMemory = dataDir.startsWith("memory://");
    if (!inMemory) release = await acquireLock(dataDir);
    db = new PGlite({ dataDir, extensions: { vector } });
    await db.waitReady;
    // A reopened data dir starts on search_path=public; `::vector` fails until extensions is on it.
    const session = `set search_path = ${SEARCH_PATH}; set timezone = '${TIMEZONE}'`;
    await db.exec(session);
    await applyPrelude(db, prelude);
    await db.exec(session);
    await applyMigrations(db, migDir);
    await db.exec(session);
    const owned = db;
    // Every ANALYZE goes through the handle's queue: outside any request transaction, as the session (owner) role.
    let m: Maintenance | undefined;
    const handle = createPgliteHandle(db, { onWrite: () => m?.noteWrite() });
    // txContext.exit: a write-triggered ANALYZE started inside a transaction callback must queue behind it, not throw.
    const analyze = () => txContext.exit(() => handle.query("analyze"));
    await analyze();
    maintenance = m = startMaintenance(analyze, {
      intervalMs: opts.analyzeIntervalMs,
      onError: (e) => console.error("store ANALYZE failed", e),
    });
    const mt = m;
    registerStore(handle);

    let closed: Promise<void> | undefined;
    const close = () =>
      (closed ??= (async () => {
        mt.stop();
        clearStore();
        setStoreState(undefined);
        process.off("SIGTERM", onSignal);
        process.off("SIGINT", onSignal);
        try {
          await owned.close();
        } finally {
          release?.();
        }
      })());
    const onSignal = () => {
      void close().finally(() => process.exit(0));
    };
    if (opts.signals !== false) {
      process.once("SIGTERM", onSignal);
      process.once("SIGINT", onSignal);
    }
    setStoreState("ready");
    return {
      handle,
      db,
      analyzeNow: () => {
        // Inside a transaction callback the ANALYZE cannot run (it needs the queue slot the transaction holds):
        // schedule it for after the transaction and return at once.
        if (deferAfterTransaction(() => void mt.analyzeNow())) return Promise.resolve();
        return mt.analyzeNow();
      },
      close,
    };
  } catch (e) {
    setStoreState("error");
    maintenance?.stop();
    try {
      await db?.close();
    } catch {
      /* ignore */
    }
    release?.();
    throw e;
  }
}
