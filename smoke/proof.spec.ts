// Signed-out /proof smoke: the recorded runs the landing links to. Needs no sign-in and no SMOKE_* env.
import { expect, test } from "@playwright/test";

const CLIPS = [
  "/demos/without-membral-answer-12s.mp4",
  "/demos/with-membral-answer-12s.mp4",
  "/demos/without-membral-answer.webp",
  "/demos/with-membral-answer.webp",
];

test("signed-out /proof renders the outage and both recorded clips", async ({ page, request }) => {
  const consoleErrors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  page.on("pageerror", (e) => consoleErrors.push(String(e)));

  const res = await page.goto("/proof");
  expect(res?.status()).toBe(200);
  await expect(page).toHaveURL(/\/proof$/);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.locator("#outage-h")).toBeVisible();
  await expect(page.locator("#pair-h")).toBeVisible();

  // Both recorded answers: a still each, and a button that loads the clip.
  await expect(page.locator('img[src*="/demos/"]')).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Play the recording" })).toHaveCount(2);
  await page.getByRole("button", { name: "Play the recording" }).first().click();
  await expect(page.locator('video source[src$=".mp4"]')).toHaveCount(1);
  for (const clip of CLIPS) {
    const r = await request.get(clip);
    expect(r.status(), clip).toBe(200);
  }

  expect(consoleErrors, "console errors").toEqual([]);
});

test("/proof has no horizontal scroll at 390px", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/proof");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const { scroll, inner } = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    inner: window.innerWidth,
  }));
  expect(scroll).toBeLessThanOrEqual(inner);
});
