// Signed-out landing smoke (goal 2026-10-10 landing-readme-value-conveyance, G1).
// Needs no sign-in and no SMOKE_* env: it only reads baseURL from smoke/playwright.config.ts.
import { expect, test } from "@playwright/test";

const HEADLINE = "Your coding agent can answer from what your past sessions found.";
// The maintainer's no-cost-claim ruling: the page states no percentage, savings or speed claim.
const COST_CLAIM = /\b\d+ ?%|cheaper|savings?|faster/i;

test("signed-out landing renders the headline and the install command", async ({ page }) => {
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  page.on("pageerror", (e) => consoleErrors.push(String(e)));
  page.on("requestfailed", (r) => failedRequests.push(`${r.url()} ${r.failure()?.errorText ?? ""}`));
  const origin = new URL(test.info().project.use.baseURL ?? "http://localhost:3001").origin;
  page.on("response", (r) => {
    if (r.url().startsWith(origin) && r.status() >= 400) failedRequests.push(`${r.status()} ${r.url()}`);
  });

  // Desktop render: signed out means no redirect to /login or the dashboard.
  await page.goto("/");
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(HEADLINE);

  // Primary CTA: the install command and its copy button (the hero and the closing Start section each have one).
  const copyButtons = page.getByRole("button", { name: "Copy the install command" });
  await expect(copyButtons.first()).toBeVisible();
  await expect(page.locator("code", { hasText: "npm run cli:install" }).first()).toBeVisible();

  // Proof: the compact block and the hero line both link to the full recorded runs on /proof.
  await expect(page.locator("#proof-h")).toBeVisible();
  await expect(page.locator('main a[href="/proof"]')).toHaveCount(2);

  // Lazy media only loads once scrolled to; walk the page so every image is requested.
  await page.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += 600) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 50));
    }
    window.scrollTo(0, 0);
  });
  await page.waitForLoadState("networkidle");

  // Every <img> has alt text and decoded to a nonzero size; video posters are set.
  const imgs = await page.locator("img").evaluateAll((els) =>
    els.map((el) => {
      const i = el as HTMLImageElement;
      return { src: i.currentSrc || i.src, alt: i.getAttribute("alt"), w: i.naturalWidth, h: i.naturalHeight };
    }),
  );
  for (const i of imgs) {
    expect(i.alt, `alt for ${i.src}`).not.toBeNull();
    expect(i.w * i.h, `natural size of ${i.src}`).toBeGreaterThan(0);
  }
  const posters = await page.locator("video").evaluateAll((els) => els.map((el) => (el as HTMLVideoElement).poster));
  for (const p of posters) expect(p, "video poster").not.toBe("");

  // No dev indicator, and none of the words the no-cost-claim ruling forbids.
  await expect(page.locator("nextjs-portal")).toHaveCount(0);
  const text = await page.locator("body").innerText();
  expect(text.match(COST_CLAIM)?.[0] ?? null, "cost-claim wording on the page").toBeNull();

  expect(consoleErrors, "console errors").toEqual([]);
  expect(failedRequests, "failed same-origin requests").toEqual([]);
});

test("landing has no horizontal scroll at 390px", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const { scroll, inner } = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    inner: window.innerWidth,
  }));
  expect(scroll).toBeLessThanOrEqual(inner);
});
