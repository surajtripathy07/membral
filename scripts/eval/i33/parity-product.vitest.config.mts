// vitest config for parity-product.mjs: root = the repository, alias @ -> apps/cloud/src, only the runner file.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../..");

export default defineConfig({
  root: repo,
  test: {
    environment: "node",
    globals: true,
    include: ["scripts/eval/i33/parity-product.runner.ts"],
    testTimeout: 3_600_000,
    hookTimeout: 3_600_000,
  },
  resolve: { alias: { "@": path.join(repo, "apps/cloud/src") } },
});
