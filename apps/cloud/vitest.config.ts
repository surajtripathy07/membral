import { configDefaults, defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    // B3: the store-parity tests run under vitest.db.config.ts (`npm run test:db`), on both stores.
    exclude: [...configDefaults.exclude, "**/__db__/**"],
    // Step 0.7 (architecture refactor programme): coverage ratchet. Applies
    // only under `--coverage` (root `npm run coverage`); plain `vitest run` is
    // unchanged. Thresholds are the values measured 2026-09-27 on
    // refactor/g0-lock, rounded DOWN: raise them as coverage grows, never lower.
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/__tests__/**", "src/**/*.test.{ts,tsx}", "src/__golden__/**"],
      // Ratchet: measured on 2026-09-27 minus a 1-point margin for environment variance; raise, never lower.
      thresholds: { statements: 79, branches: 83, functions: 90, lines: 79 },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  // Automatic JSX runtime (issue #21 M4): lets .tsx component tests use
  // renderToStaticMarkup without every source file needing an explicit
  // `import React from "react"` — matches Next.js's own bundler JSX runtime,
  // no new dependency (esbuild ships this transform already).
  esbuild: {
    jsx: "automatic",
  },
});
