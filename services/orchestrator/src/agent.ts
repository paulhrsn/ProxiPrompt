import {
  parsePlanResponse,
  parseSummarizePostResponse,
  parseSynthesizeResponse,
  type PlanRequest,
  type PlanResponse,
  type SummarizePostRequest,
  type SummarizePostResponse,
  type SynthesizeRequest,
  type SynthesizeResponse,
} from "@proxiprompt/core";

const AGENT_URL = () => (process.env.AGENT_URL ?? "http://127.0.0.1:8001").replace(/\/$/, "");

async function postJson<T>(path: string, body: unknown, parse: (raw: unknown) => T): Promise<T> {
  const res = await fetch(`${AGENT_URL()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(25_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`agent ${path} ${res.status}: ${text.slice(0, 200)}`);
  }
  return parse(await res.json());
}

export const callPlan = (req: PlanRequest): Promise<PlanResponse> =>
  postJson("/plan", req, parsePlanResponse);

export const callSynthesize = (req: SynthesizeRequest): Promise<SynthesizeResponse> =>
  postJson("/synthesize", req, parseSynthesizeResponse);

export const callSummarize = (req: SummarizePostRequest): Promise<SummarizePostResponse> =>
  postJson("/summarize_post", req, parseSummarizePostResponse);

export async function agentHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${AGENT_URL()}/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}
