import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { callPlan, callSynthesize } from '../src/agent.js';
afterEach(()=>vi.restoreAllMocks());
it('gives the planner its complete review/planning budget plus transport margin', async()=>{
  const timeout=vi.spyOn(AbortSignal,'timeout');
  vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response('unavailable',{status:503}));
  await expect(callPlan({} as never)).rejects.toThrow('agent /plan 503');
  const workerBudget=timeout.mock.calls[0][0];
  const planner=readFileSync(fileURLToPath(new URL('../../agent/src/proxiprompt_agent/planner.py',import.meta.url)),'utf8');
  const agentBudget=Number(planner.match(/PLAN_TOTAL_TIMEOUT_S = ([\d.]+)/)![1])*1000;
  expect(workerBudget).toBe(50000); expect(workerBudget).toBeGreaterThan(agentBudget);
  await expect(callSynthesize({} as never)).rejects.toThrow('agent /synthesize 503');
  const llm=readFileSync(fileURLToPath(new URL('../../agent/src/proxiprompt_agent/llm.py',import.meta.url)),'utf8');
  const llmBudget=Number(llm.match(/TOTAL_TIMEOUT_S = ([\d.]+)/)![1])*1000;
  expect(timeout.mock.calls[1][0]).toBeGreaterThan(llmBudget);
});
