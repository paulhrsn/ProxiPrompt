/**
 * Every spec imports `test` from here. Before each test the test orchestrator wipes all
 * activity (reports, questions, watches), so no spec reads another spec's leftovers.
 * A watch trips on the modal firsthand report at its place, so reports left behind by an
 * earlier spec at the same place would outvote the new one.
 */
import { expect, test as base, type Page } from "@playwright/test";

export { expect };

const ORCH_URL = process.env.E2E_ORCH_URL ?? "http://127.0.0.1:8081";

export const test = base.extend<{ cleanSlate: void }>({
  cleanSlate: [
    async ({}, use) => {
      const res = await fetch(`${ORCH_URL}/dev/wipe`, { method: "POST", headers: { "X-ProxiPrompt-Dev": "1" } });
      if (!res.ok) throw new Error(`dev wipe failed: ${res.status} ${await res.text()}`);
      await use();
    },
    { auto: true },
  ],
});

/**
 * Real user path into the app. With SpacetimeAuth configured the app opens on the
 * "Sign in" screen, so a tester takes the visible "Use demo session" entry; without it the
 * welcome screen offers "Explore the demo". Resolves once the "Your name" step shows.
 */
export async function enterDemo(page: Page) {
  const yourName = page.getByRole("heading", { name: "Your name" });
  const signIn = page.getByRole("heading", { name: "Sign in" });
  const welcome = page.getByRole("heading", { name: "Know before you go." });
  await expect(yourName.or(signIn).or(welcome)).toBeVisible({ timeout: 20_000 });
  if (await signIn.isVisible()) await page.getByRole("button", { name: "Use demo session" }).click();
  else if (await welcome.isVisible()) await page.getByRole("button", { name: "Explore the demo" }).click();
  await expect(yourName).toBeVisible();
}
