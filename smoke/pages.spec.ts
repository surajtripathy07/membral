// Browser half of `npm run smoke` (goal 2026-09-12 W8/D7, issue #144).
// Only ever invoked by smoke/run.mjs, which sets these env vars after
// creating a throwaway user + importing its two fixture sessions:
//   SMOKE_BASE_URL, SMOKE_EMAIL, SMOKE_PASSWORD, SMOKE_SESSION_ID
import { expect, test } from "@playwright/test";

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set — this spec must be run via \`npm run smoke\`, not standalone.`);
  return v;
}

const EMAIL = requiredEnv("SMOKE_EMAIL");
const PASSWORD = requiredEnv("SMOKE_PASSWORD");
const SESSION_ID = requiredEnv("SMOKE_SESSION_ID");

test("throwaway user sees their imported session and cost on the dashboard", async ({ page }) => {
  // --- sign in with the throwaway user's password (the plain email/password
  // form on /login — see apps/cloud/src/app/(auth)/login/page.tsx) ---
  await page.goto("/login");
  await page.locator("#email").fill(EMAIL);
  await page.locator("#password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  // login() redirects to "/" on success (safeNext's default) — wait for the
  // navigation away from /login rather than a specific destination path.
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 15_000 });

  // --- /code/session/<id>: the turn count renders (ADR 0021 Q6 — "N turns
  // (M yours, K tool calls)" in the session header) ---
  await page.goto(`/code/session/${SESSION_ID}`);
  await expect(page.getByText(/\d+ turns/).first()).toBeVisible();

  // --- /code/stats: a cost figure renders (formatCostUsd — "$" + digits) ---
  await page.goto("/code/stats");
  await expect(page.getByText(/\$\d/).first()).toBeVisible();

  // --- /pulse (goal 2026-09-26 P7): the Yesterday and Open threads blocks
  // render. The two fixture sessions carry no forge refs, so each block may
  // legitimately be empty — assert the heading and then either the calm
  // empty-state sentence or at least one thread row, whichever appears. ---
  await page.goto("/pulse");
  await expect(page.getByRole("heading", { name: /^Yesterday$/ })).toBeVisible();
  const openHeading = page.getByRole("heading", { name: /^Open threads/ });
  await expect(openHeading).toBeVisible();
  const openSection = page.locator("section", { has: openHeading });
  const openEmpty = openSection.getByText("Nothing you committed to is still waiting on a close.");
  const openRows = openSection.locator("li[data-ref]");
  await expect(openEmpty.or(openRows.first())).toBeVisible();
  // Never the word the goal forbids (B6).
  await expect(page.getByText(/unresolved/i)).toHaveCount(0);
});
