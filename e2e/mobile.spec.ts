import { enterDemo, expect, test } from "./fixtures";

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

test("mobile layout, question starters, place search and navigation", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/");
  await enterDemo(page);
  await page.getByLabel("Name", { exact: true }).fill(`ui${Date.now().toString(36)}`);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Know before you go." })).toBeVisible();
  const askBounds = await page.locator("form.ask").getByRole("button", { name: "Ask", exact: true }).boundingBox();
  const tabBounds = await page.getByRole("navigation", { name: "Primary" }).boundingBox();
  expect(askBounds!.y + askBounds!.height).toBeLessThanOrEqual(tabBounds!.y);
  await page.screenshot({ path: "test-results/mobile-home.png", fullPage: true });
  await page.getByRole("button", { name: "Is it quiet?" }).click();
  await expect(page.getByLabel("Question", { exact: true })).toHaveValue("Is it quiet?");
  await expect(page.getByRole("button", { name: "Is it quiet?", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("form.ask").getByRole("button", { name: "Ask", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Change", exact: false }).first().click();
  await page.getByLabel("Place", { exact: true }).fill("Michigan Union");
  await page.getByRole("button", { name: /Michigan Union.*530/ }).click();
  await expect(page.getByRole("heading", { name: "Michigan Union", exact: true })).toBeVisible();
  const nav = page.getByRole("navigation", { name: "Primary" });
  await nav.getByRole("button", { name: "Questions" }).click();
  await expect(page.getByRole("heading", { name: "Curiosity starts here." })).toBeVisible();
  await nav.getByRole("button", { name: "Posts", exact: true }).click();
  await page.getByRole("button", { name: /Post an update/ }).click();
  await expect(page.getByLabel("Update", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.screenshot({ path: "test-results/mobile-posts.png", fullPage: true });
  for (const width of [320, 390, 430, 1024]) {
    await page.setViewportSize({ width, height: 844 });
    await page.screenshot({ path: `test-results/layout-${width}.png`, fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  await nav.getByRole("button", { name: "Ask", exact: true }).click();
  await expect(page.locator("form.ask")).toHaveCSS("animation-name", "none");
  expect(errors).toEqual([]);
});


test("signed-out sign-in screen offers email sign-in and the demo session at phone and desktop sizes", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("pp.devMode", "0"));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(page.getByLabel("Email")).toBeVisible();
  const signInButton = page.locator("section.sign-in").getByRole("button", { name: "Sign in", exact: true });
  await expect(signInButton).toBeDisabled();
  await page.getByLabel("Email").fill("someone@umich.edu");
  await expect(signInButton).toBeEnabled();
  await page.getByLabel("Email").fill("");
  await expect(page.getByRole("button", { name: "Dev", exact: true })).toHaveCount(0);
  for (const width of [320, 390, 1024]) {
    await page.setViewportSize({ width, height: 844 });
    const action = await page.getByRole("button", { name: "Use demo session" }).boundingBox();
    expect(action!.y + action!.height).toBeLessThan(844);
    expect(action!.height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `test-results/signin-${width}.png`, fullPage: true });
  }
  await page.getByRole("button", { name: "Use demo session" }).click();
  await expect(page.getByRole("heading", { name: "Your name" })).toBeVisible();
});
