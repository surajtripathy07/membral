import { defineConfig } from "vitest/config";

// Step 0.7 (architecture refactor programme): coverage ratchet only. Plain
// `vitest run` behaves exactly as with no config file; thresholds apply only
// under `--coverage` (root `npm run coverage`). Thresholds are the measured
// values rounded DOWN: raise them when coverage grows, never lower them.
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/__tests__/**", "src/**/*.test.ts"],
      // Measured 2026-09-27 on refactor/g0-lock.
      // Ratchet: measured on 2026-09-27 minus a 1-point margin for environment variance; raise, never lower.
      thresholds: { statements: 79, branches: 78, functions: 80, lines: 79 },
    },
  },
});
