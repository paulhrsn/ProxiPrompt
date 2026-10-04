/**
 * Posting is one step from a known location, and "Still true" is a brief confirmation.
 */
import { enterDemo, expect, test } from "./fixtures";

const SHAPIRO = "Shapiro Undergraduate Library";

test("composer defaults to the current place; Still true confirmation fades", async ({ page }) => {
  const tag = Math.random().toString(36).slice(2, 7);
  await page.goto("/");
  await enterDemo(page);
  await page.getByLabel("Name").fill(`p${tag}`);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: SHAPIRO })).toBeVisible();

  const nav = page.getByRole("navigation", { name: "Primary" });
  await nav.getByRole("button", { name: "You" }).click();
  await page.getByLabel("Location", { exact: true }).selectOption({ label: SHAPIRO });
  await expect(page.getByTestId("demo-location")).toHaveText("Simulated location");

  await nav.getByRole("button", { name: "Posts", exact: true }).click();
  await page.getByRole("button", { name: /Post an update/ }).click();
  await expect(page.locator(".chosen-place")).toContainText(SHAPIRO);
  await page.getByLabel("Update", { exact: true }).fill("Third floor is quiet.");
  await page.getByRole("button", { name: "Post update" }).click();

  const card = page.locator("article.card").filter({ hasText: "Third floor is quiet." });
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: /Comment/ }).click();
  await card.getByRole("button", { name: "Still true" }).click();
  const note = card.getByText("Marked still true.");
  await expect(note).toBeVisible();
  await expect(note).toHaveCount(0, { timeout: 8_000 });
});
