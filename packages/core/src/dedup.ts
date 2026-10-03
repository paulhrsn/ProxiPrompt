export interface JobSummary {
  id: string;
  placeId: string;
  dimensionKeys: string[];
  status: string;
  deadlineAtMs: number;
  createdAtMs: number;
}

/** Jaccard similarity of two key sets; 0 when both are empty. */
export function jaccard(a: string[], b: string[]): number {
  const sa = new Set(a);
  const sb = new Set(b);
  const union = new Set([...sa, ...sb]).size;
  if (union === 0) return 0;
  let inter = 0;
  for (const k of sa) if (sb.has(k)) inter++;
  return inter / union;
}

export const ATTACH_MIN_JACCARD = 0.5;

/**
 * Active job (status 'collecting') at the same place, not past its deadline,
 * with Jaccard ≥ 0.5. Prefers highest overlap, then newest.
 */
export function findAttachableJob(
  jobs: JobSummary[],
  placeId: string,
  dimensionKeys: string[],
  nowMs: number,
): JobSummary | null {
  let best: { job: JobSummary; overlap: number } | null = null;
  for (const job of jobs) {
    if (job.status !== "collecting" || job.placeId !== placeId || nowMs >= job.deadlineAtMs) continue;
    const overlap = jaccard(job.dimensionKeys, dimensionKeys);
    if (overlap < ATTACH_MIN_JACCARD) continue;
    if (
      !best ||
      overlap > best.overlap ||
      (overlap === best.overlap && job.createdAtMs > best.job.createdAtMs)
    ) {
      best = { job, overlap };
    }
  }
  return best?.job ?? null;
}
