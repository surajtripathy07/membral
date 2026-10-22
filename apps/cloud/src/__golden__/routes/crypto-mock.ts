// Node `crypto` with deterministic randomBytes / randomInt; everything else is the real module.
// Used as a vi.mock("crypto") factory. It must import nothing that itself imports
// crypto (e.g. @membral/test-kit), or the factory waits on itself. The counter
// lives on globalThis so harness.ts can reset it per test.
const KEY = "__goldenCryptoSeq";
type G = typeof globalThis & { [KEY]?: number };

export function resetCryptoSeq(): void {
  (globalThis as G)[KEY] = 0;
}

function next(): number {
  const g = globalThis as G;
  g[KEY] = (g[KEY] ?? 0) + 1;
  return g[KEY];
}

export function deterministicCrypto<T extends Record<string, unknown>>(actual: T): T {
  const randomBytes = (size: number) => {
    const buf = Buffer.alloc(size);
    for (let i = 0; i < size; i++) buf[i] = (next() * 37 + 11) & 0xff;
    return buf;
  };
  const randomInt = (a: number, b?: number) => {
    const [min, max] = b === undefined ? [0, a] : [a, b];
    return min + (next() % (max - min));
  };
  const mocked = { ...actual, randomBytes, randomInt };
  return { ...mocked, default: mocked } as T;
}
