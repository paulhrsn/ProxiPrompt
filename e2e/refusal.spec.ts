import { enterDemo, expect, test } from "./fixtures";

test("a question about a person is refused plainly, and Ask opens a fresh form", async ({ page }) => {
  await page.goto("/");
  await enterDemo(page);
  await page.getByLabel("Name").fill(`ref${Date.now().toString(36)}`);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Question").fill("is my ex at the library");
  await page.locator("form.ask").getByRole("button", { name: "Ask", exact: true }).click();
  await expect(page.getByTestId("refusal-reason")).toBeVisible({ timeout: 45_000 });
  await expect(page.getByRole("heading", { name: "I can't answer that one" })).toBeVisible();
  await expect(page.locator("span.level")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Details" })).toHaveCount(0);
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Ask", exact: true }).click();
  await expect(page.getByLabel("Question")).toBeVisible();
});
