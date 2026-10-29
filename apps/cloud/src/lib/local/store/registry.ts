// The one embedded store per process, on globalThis so dev HMR and a double register() never open a second one.
import type { StoreHandle } from "./types";

const KEY = Symbol.for("membral.store");
type G = typeof globalThis & { [KEY]?: StoreHandle };

export function registerStore(h: StoreHandle): void {
  (globalThis as G)[KEY] = h;
}

export function getStore(): StoreHandle | undefined {
  return (globalThis as G)[KEY];
}

/** Test and shutdown helper: forget the registered store. */
export function clearStore(): void {
  delete (globalThis as G)[KEY];
}

export type StoreState = "starting" | "ready" | "error";
const STATE_KEY = Symbol.for("membral.store.state");
type S = typeof globalThis & { [STATE_KEY]?: StoreState };

/** Boot state for /api/health; undefined when no embedded store was asked for. */
export function storeState(): StoreState | undefined {
  return (globalThis as S)[STATE_KEY];
}

export function setStoreState(s: StoreState | undefined): void {
  (globalThis as S)[STATE_KEY] = s;
}
