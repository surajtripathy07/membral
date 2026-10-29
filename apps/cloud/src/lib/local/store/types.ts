// The embedded store's handle (rung two, docs/design/2026-10-25_docker-free-store.md). The shim depends only on
// this, so the store can move into a worker thread later without touching the shim.

export type QueryResult = { rows: Record<string, unknown>[]; affectedRows?: number; fields: { name: string }[] };

export interface StoreTx {
  query(sql: string, params?: unknown[]): Promise<QueryResult>;
}

export interface StoreHandle {
  readonly kind: "pglite";
  /** One statement outside an explicit transaction. */
  query(sql: string, params?: unknown[]): Promise<QueryResult>;
  /** Runs fn in one transaction; requests are serialized, one at a time. Rolls back when fn throws. */
  transaction<T>(fn: (tx: StoreTx) => Promise<T>): Promise<T>;
  /** Called after every write, so maintenance knows when to ANALYZE. */
  noteWrite(): void;
}
