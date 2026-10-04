/** Reciprocal priority (SPEC §7): answering neighbors earns a boost on your own questions. */
export const RECIPROCITY_WINDOW_MS = 24 * 3_600_000;
export const RECIPROCITY_CAP = 5;

/**
 * Credit for one user, 0..RECIPROCITY_CAP: their prompt responses from the last 24 hours that
 * were real answers. A "not_here" pass earns nothing. Pass only that user's responses.
 */
export function reciprocityCredit(
  responses: { createdAtMs: number; pass: boolean }[],
  nowMs: number,
): number {
  const answered = responses.filter(
    (r) => !r.pass && r.createdAtMs <= nowMs && nowMs - r.createdAtMs < RECIPROCITY_WINDOW_MS,
  ).length;
  return Math.min(answered, RECIPROCITY_CAP);
}
