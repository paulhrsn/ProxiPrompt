/**
 * Watch a place in a real browser against the test stack (see scripts/e2e-browser.sh).
 */
import type { Page } from "@playwright/test";
import { enterDemo, expect, test } from "./fixtures";

const SHAPIRO = "Shapiro Undergraduate Library";

async function onboard(page: Page, username: string) {
  await page.goto("/");
  await enterDemo(page);
  await page.getByLabel("Name").fill(username);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: SHAPIRO })).toBeVisible();
}

test("notify me when seats open, then the watch reports it", async ({ browser }) => {
  const tag = Math.random().toString(36).slice(2, 7);
  const askerCtx = await browser.newContext({ permissions: ["notifications"] });
  const nearCtx = await browser.newContext({ permissions: ["notifications"] });
  const asker = await askerCtx.newPage();
  const near = await nearCtx.newPage();
  try {
    await onboard(asker, `w${tag}`);
    await onboard(near, `r${tag}`);
    await near.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "You" }).click();
    await near.getByLabel("Location", { exact: true }).selectOption({ label: SHAPIRO });
    await expect(near.getByTestId("demo-location")).toHaveText("Simulated location");

    await asker.getByLabel("Question").fill("Tell me when seats open up");
    await asker.getByRole("button", { name: "Notify me when" }).click();
    await expect(asker).toHaveURL(/#\/q\/\d+/, { timeout: 15_000 });
    await expect(asker.getByTestId("watch-note")).toBeVisible();

    await asker.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Questions" }).click();
    await expect(asker.getByRole("heading", { name: "Watching" })).toBeVisible({ timeout: 20_000 });
    await expect(asker.locator(".card").filter({ hasText: "Tell me when seats open up" }).first()).toBeVisible();

    const ping = near.locator(".ping");
    await expect(ping).toBeVisible({ timeout: 45_000 });
    const sets = ping.locator("fieldset");
    const n = await sets.count();
    expect(n).toBeGreaterThan(0);
    for (let i = 0; i < n; i++) {
      const labels = sets.nth(i).locator("label");
      const count = await labels.count();
      let picked = false;
      for (let j = 0; j < count; j++) {
        const text = (await labels.nth(j).innerText()).toLowerCase();
        if (/plenty|some|many/.test(text) && !/few|none|no /.test(text)) {
          await labels.nth(j).click();
          picked = true;
          break;
        }
      }
      if (!picked) await labels.first().click();
    }
    await ping.getByRole("button", { name: "Send", exact: true }).click();
    await expect(near.getByText(/signal sent/i)).toBeVisible();

    await expect(asker.getByText("Seats opened up")).toBeVisible({ timeout: 45_000 });
    await asker.getByRole("button", { name: "Stop watching" }).click();
    await expect(asker.getByRole("heading", { name: "Watching" })).toHaveCount(0);
  } finally {
    await askerCtx.close();
    await nearCtx.close();
  }
});
