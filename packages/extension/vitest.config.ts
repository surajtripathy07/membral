import { resolve } from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  define: {
    "import.meta.env.VITE_SUPABASE_URL": JSON.stringify("https://test.supabase.co"),
    "import.meta.env.VITE_SUPABASE_ANON_KEY": JSON.stringify("test-anon-key"),
    "import.meta.env.VITE_CLOUD_URL": JSON.stringify("http://localhost:3000"),
  },
  resolve: {
    alias: {
      "@membral/core": resolve(__dirname, "../core/src/index.ts"),
    },
  },
  test: {
    globals: false,
    environment: "node",
    // Step 0.7 (architecture refactor programme): coverage ratchet. Applies
    // only under `--coverage` (root `npm run coverage`); plain `vitest run` is
    // unchanged. Thresholds are the values measured 2026-09-27 on
    // refactor/g0-lock, rounded DOWN: raise them as coverage grows, never lower.
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/__tests__/**", "src/**/*.test.ts"],
      // Ratchet: measured on 2026-09-27 minus a 1-point margin for environment variance; raise, never lower.
      thresholds: { statements: 66, branches: 82, functions: 79, lines: 66 },
    },
  },
});
