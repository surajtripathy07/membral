// Playwright config for `npm run smoke` (goal 2026-09-12 W8/D7, issue #144).
// Driven entirely by smoke/run.mjs, which sets SMOKE_BASE_URL/SMOKE_EMAIL/
// SMOKE_PASSWORD/SMOKE_SESSION_ID before invoking `npx playwright test
// --config smoke/playwright.config.ts` — this file is never run standalone
// against a real target without those env vars set.
import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.SMOKE_BASE_URL ?? "http://localhost:3001";

export default defineConfig({
  testDir: __dirname,
  testMatch: ["pages.spec.ts", "landing.spec.ts", "proof.spec.ts"],
  // Playwright's default outputDir/reporter paths are relative to the
  // process CWD, not this config file's directory — smoke/run.mjs spawns
  // `playwright test` with cwd set to the repo root, so both are pinned
  // under smoke/ explicitly (matching the .gitignore entries for this
  // directory) rather than littering the repo root.
  outputDir: `${__dirname}/test-results`,
  timeout: 30_000,
  retries: 0,
  reporter: [["list"], ["html", { outputFolder: `${__dirname}/playwright-report`, open: "never" }]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
