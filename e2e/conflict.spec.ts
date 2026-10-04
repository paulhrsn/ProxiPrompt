/**
 * Two nearby people give opposite answers: the card must say so and must not claim High
 * confidence. Details then opens a readable sources view, never raw JSON.
 */
import type { BrowserContext, Page } from "@playwright/test";
import { enterDemo, expect, test } from "./fixtures";

const SHAPIRO = "Shapiro Undergraduate Library";

async function onboard(page: Page, username: string) {
  await page.goto("/");
  await enterDemo(page);
  await page.getByLabel("Name").fill(username);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: SHAPIRO })).toBeVisible();
}

async function answerAt(page: Page, which: "first" | "last") {
  const ping = page.locator(".ping");
  await expect(ping).toBeVisible({ timeout: 30_000 });
  const sets = ping.locator("fieldset");
  const n = await sets.count();
  for (let i = 0; i < n; i++) {
    const labels = sets.nth(i).locator("label");
    await (which === "first" ? labels.first() : labels.last()).click();
  }
  await ping.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: /signal sent/i })).toBeVisible();
}

test("conflicting reports lower confidence and Details is readable", async ({ browser }) => {
  const tag = Math.random().toString(36).slice(2, 7);
  const contexts: BrowserContext[] = [];
  const open = async (username: string) => {
    const ctx = await browser.newContext({ permissions: ["notifications"] });
    contexts.push(ctx);
    const page = await ctx.newPage();
    await onboard(page, username);
    return page;
  };
  try {
    const asker = await open(`x${tag}`);
    const a = await open(`y${tag}`);
    const b = await open(`z${tag}`);
    for (const p of [a, b]) {
      await p.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "You" }).click();
      await p.getByLabel("Location", { exact: true }).selectOption({ label: SHAPIRO });
      await expect(p.getByTestId("demo-location")).toHaveText("Simulated location");
    }

    await asker.getByLabel("Question").fill("Are there seats open at Shapiro right now?");
    await asker.locator("form.ask").getByRole("button", { name: "Ask" }).click();
    await expect(asker).toHaveURL(/#\/q\/\d+/);

    await Promise.all([answerAt(a, "first"), answerAt(b, "last")]);

    await expect(asker.locator("span.level")).toBeVisible({ timeout: 150_000 });
    await expect(asker.locator("span.level")).not.toHaveText("High");
    await expect(asker.locator(".caveats")).toContainText("Reports disagree");
    await asker.screenshot({ path: "test-results/answer-conflict.png", fullPage: true });

    await asker.getByRole("button", { name: "Details" }).click();
    const sources = asker.getByTestId("sources-view");
    await expect(sources).toBeVisible();
    await expect(sources.locator("li")).toHaveCount(2);
    await expect(sources).toContainText(/response/i);
    await expect(sources).toContainText(/verified nearby/i);
    await expect(sources).toContainText(/Reports disagree/);
    await expect(asker.locator("pre")).toHaveCount(0);
    expect(await sources.innerText()).not.toMatch(/[{}"]/);
    await asker.screenshot({ path: "test-results/answer-sources.png", fullPage: true });
  } finally {
    await Promise.all(contexts.map((c) => c.close()));
  }
});
