/**
 * SPEC §14 steps 1-7 in real Chromium, against the test stack on :5174.
 * `pnpm e2e:browser` starts that stack on proxiprompt-test. Do not point this
 * at :5173: that app uses the live proxiprompt database.
 */
import type { BrowserContext, Page } from "@playwright/test";
import { enterDemo, expect, test } from "./fixtures";

const SHAPIRO = "Shapiro Undergraduate Library";
const UNION = "Michigan Union";
const QUESTION = "Is Shapiro worth going to if I need somewhere quiet to study?";
const FOLLOWUP = "Can I find a quiet seat at Shapiro right now?";

function indexOf(lines: string[], pattern: RegExp): number {
  return lines.findIndex((line) => pattern.test(line));
}

async function timeline(page: Page): Promise<string[]> {
  return page.locator(".timeline li").allTextContents();
}

async function onboard(page: Page, username: string) {
  await page.goto("/");
  await enterDemo(page);
  await page.getByLabel("Name").fill(username);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: SHAPIRO })).toBeVisible();
}

async function setDemo(page: Page, placeName: string) {
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "You" }).click();
  await page.getByLabel("Location", { exact: true }).selectOption({ label: placeName });
  await expect(page.getByTestId("demo-location")).toHaveText("Simulated location");
}

async function ask(page: Page, question: string) {
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Ask" }).click();
  await expect(page.getByRole("heading", { name: SHAPIRO })).toBeVisible();
  await page.getByLabel("Question").fill(question);
  await page.locator("form.ask").getByRole("button", { name: "Ask" }).click();
  await expect(page).toHaveURL(/#\/q\/\d+/);
}

async function answerPrompt(page: Page) {
  const ping = page.locator(".ping");
  await expect(ping).toBeVisible();
  const sets = ping.locator("fieldset");
  const n = await sets.count();
  expect(n).toBeGreaterThan(0);
  for (let i = 0; i < n; i++) {
    await sets.nth(i).locator("label").first().click();
  }
  const send = ping.getByRole("button", { name: "Send", exact: true });
  await expect(send).toBeEnabled();
  await send.click();
  await expect(page.getByRole("status").filter({ hasText: /signal sent/i })).toBeVisible();
}

test("canonical demo: nearby answers, far is skipped, second ask reuses evidence", async ({ browser }) => {
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
    const asker = await open(`a${tag}`);
    const near1 = await open(`b${tag}`);
    const near2 = await open(`c${tag}`);
    const far = await open(`d${tag}`);

    await setDemo(near1, SHAPIRO);
    await setDemo(near2, SHAPIRO);
    await setDemo(far, UNION);

    // Reproduce switching from a responder window to the asker. Backgrounding a
    // connected responder must preserve the recent presence grace period.
    await near1.evaluate(()=>{
      Object.defineProperty(document,"visibilityState",{configurable:true,get:()=>"hidden"});
      document.dispatchEvent(new Event("visibilitychange"));
    });

    await ask(asker, QUESTION);

    await expect
      .poll(async () => (await timeline(asker)).join("\n"), { timeout: 45_000 })
      .toMatch(/Asking \d+ (person|people) near Shapiro/);
    const lines = await timeline(asker);
    console.log("asker timeline", lines);
    const understood = indexOf(lines, /^Understanding your question$/);
    const checked = indexOf(lines, /Checking recent updates|Found \d+ recent update/);
    const asking = indexOf(lines, /Asking \d+ (person|people) near Shapiro/);
    expect(understood, lines.join(" | ")).toBeGreaterThanOrEqual(0);
    expect(checked, lines.join(" | ")).toBeGreaterThan(understood);
    expect(asking, lines.join(" | ")).toBeGreaterThan(checked);
    expect(lines[asking]).toContain("Asking 2 people");

    await expect(near1.locator(".ping")).toBeVisible({ timeout: 20_000 });
    await expect(near2.locator(".ping")).toBeVisible({ timeout: 20_000 });
    await expect(far.locator(".ping")).toHaveCount(0);

    await Promise.all([answerPrompt(near1), answerPrompt(near2)]);

    const meta = asker.locator("p").filter({ has: asker.locator("span.level") });
    await expect(meta).toBeVisible({ timeout: 60_000 });
    await expect(meta).toContainText(/\b(High|Medium|Low)\b/);
    await expect(meta).toContainText("2 reports");
    await expect(asker.locator("h1")).not.toHaveText(QUESTION);
    await expect(asker.getByText("Not enough fresh evidence")).toHaveCount(0);
    await expect(far.locator(".ping")).toHaveCount(0);

    const follow = await open(`e${tag}`);
    await ask(follow, FOLLOWUP);
    // The timeline unmounts once an answer exists, so keep every paint of the page.
    let followText = "";
    await expect
      .poll(async () => {
        followText += `\n${await follow.locator("body").innerText()}`;
        return followText;
      }, { timeout: 45_000 })
      .toMatch(/Reusing fresh evidence/);
    await expect(follow.locator("span.level")).toBeVisible({ timeout: 60_000 });
    await expect(follow.getByText(/Insufficient fresh evidence|Not enough fresh evidence/)).toHaveCount(0);

    const sendButtons = () =>
      near1.locator(".ping").getByRole("button", { name: "Send" }).count()
        .then(async (b) => b + (await near2.locator(".ping").getByRole("button", { name: "Send" }).count()));
    await expect.poll(sendButtons, { timeout: 8_000, intervals: [500, 1000, 1000] }).toBe(0);
    await expect(far.locator(".ping")).toHaveCount(0);
  } finally {
    await Promise.all(contexts.map((ctx) => ctx.close()));
  }
});
