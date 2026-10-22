// The three flavour constructors, with the exact signatures of the old
// apps/cloud `lib/{memory,code-sessions,kg}/__tests__/fake-supabase.ts`
// wrappers they replace. See fake-db.ts for what each flavour reproduces.
import { createFakeDb, FakeDb, type Row, type RpcHandler } from "./fake-db.js";

export interface MemoryFakeSupabaseOptions {
  rpc?: Record<string, RpcHandler>;
  onInsert?: (table: string, row: Row) => void;
}

// biome-ignore lint/suspicious/noExplicitAny: test double, cast to SupabaseClient at call sites
export function makeMemoryFakeSupabase(tables: Record<string, Row[]>, opts: MemoryFakeSupabaseOptions = {}): any {
  return createFakeDb({ flavour: "memory", tables, rpc: opts.rpc, onInsert: opts.onInsert }).client;
}

// The clock is the system clock, as it was in the old wrapper (tests steer it with vi.setSystemTime).
export class FakeSupabase extends FakeDb {
  constructor() {
    super({ flavour: "code-sessions", clock: () => new Date().toISOString() });
  }
}

export function makeKgFakeSupabase(initial: Record<string, Row[]> = {}): FakeDb {
  return createFakeDb({ flavour: "kg", tables: initial });
}
