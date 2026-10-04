/**
 * Every spec imports `test` from here. Before each test the test orchestrator wipes all
 * activity (reports, questions, watches), so no spec reads another spec's leftovers.
 * A watch trips on the modal firsthand report at its place, so reports left behind by an
 * earlier spec at the same place would outvote the new one.
 */
import { test as base } from "@playwright/test";

export { expect } from "@playwright/test";

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
