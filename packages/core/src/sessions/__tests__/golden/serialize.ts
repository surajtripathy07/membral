// Step 0.2 (behaviour lock, D-059/D-051): shared serializer for the parser/
// forge-action golden tests in this directory. Every golden test compares a
// full parser output against a committed JSON snapshot via
// `expect(...).toMatchFileSnapshot(...)`, so the snapshot's byte content has
// to be stable across runs and across machines. Two properties make that so:
//
// 1. Stable key order: `JSON.stringify` on a plain object preserves
//    *insertion* order, which is whatever order the parser happened to build
//    the object in — not guaranteed by any documented contract. This
//    serializer re-inserts every object's keys in sorted order (recursively,
//    including array elements) before stringifying, so the snapshot's key
//    order never depends on incidental object-construction order upstream.
// 2. No volatile fields: nothing in `RawCodeSession`/`RawTurn`/`ForgeAction`
//    is derived from `Date.now()`, `Math.random()`, `process.cwd()`, a real
//    filesystem path, or any other run-dependent source (verified by
//    grepping packages/core/src/sessions/*.ts for those calls — none found,
//    2026-09-27). `contentHash` is `sha256` of the fixture's own committed
//    bytes (claude-code.ts parseTranscript, `const contentHash = createHash
//    ("sha256")...`), which is as stable as the fixture file itself. The one
//    place this test suite could have introduced a volatile value — the
//    `root` path passed to a deliberately-missing-directory `detect()` call,
//    for the SessionRootUnreadableError golden — is worked around by never
//    deriving that path from `__dirname`/`import.meta.url`: the golden test
//    passes a hardcoded, machine-independent literal instead, so no
//    normalizer is needed anywhere in this suite.
function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/** Deterministic, key-sorted JSON serialization for a golden snapshot, with a trailing newline. */
export function golden(value: unknown): string {
  return `${JSON.stringify(sortDeep(value), null, 2)}\n`;
}
