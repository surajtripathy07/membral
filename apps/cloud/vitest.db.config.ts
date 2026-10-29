// The `db` test project (B3, rung two): the same test files run against the embedded store (MEMBRAL_TEST_STORE=pglite,
// the default) and against a real Supabase stack (MEMBRAL_TEST_STORE=postgrest). They live in src/**/__db__/ and are
// left out of the default `vitest run` (vitest.config.ts). One fork, no module isolation: the store boots once and
// every file shares it, so a file's seed rows are visible to the next (tests that write use newUser()).
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["src/**/__db__/*.db.test.ts"],
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    isolate: false,
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 300_000,
  },
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
  esbuild: { jsx: "automatic" },
});
