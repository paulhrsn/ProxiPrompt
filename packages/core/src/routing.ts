import type { CoreConfig } from "./config";
import { haversineM } from "./geo";

export interface Candidate {
  userId: string;
  lat: number;
  lng: number;
  source: "gps" | "demo";
  capturedAtMs: number;
  hasActiveDevice: boolean;
  notificationsPaused: boolean;
  lastPromptedAtMs: number | null;
}

export type ExclusionReason =
  | "requester"
  | "stale_location"
  | "out_of_radius"
  | "no_device"
  | "paused"
  | "cooldown"
  | "already_asked";

export interface SelectInput {
  candidates: Candidate[];
  place: { lat: number; lng: number };
  nowMs: number;
  config: CoreConfig;
  radiusM: number;
  /** Max recipients to select in this wave. */
  count: number;
  /** Users already asked for this job. */
  excludeIds: string[];
  requesterId: string;
}

export interface SelectResult {
  selected: { userId: string; distanceM: number; source: "gps" | "demo" }[];
  excluded: { userId: string; reason: ExclusionReason; distanceM?: number }[];
}

/**
 * SPEC §7 step 5. Checks run in a fixed order and the first failing check is
 * the reported reason: requester, already_asked, stale_location, out_of_radius,
 * no_device, paused, cooldown. Eligible candidates are ranked by distance.
 */
export function selectResponders(input: SelectInput): SelectResult {
  const { place, nowMs, config, radiusM, count, requesterId } = input;
  const alreadyAsked = new Set(input.excludeIds);
  const eligible: { userId: string; distanceM: number; source: "gps" | "demo" }[] = [];
  const excluded: SelectResult["excluded"] = [];

  for (const c of input.candidates) {
    if (c.userId === requesterId) {
      excluded.push({ userId: c.userId, reason: "requester" });
      continue;
    }
    const distanceM = haversineM(place.lat, place.lng, c.lat, c.lng);
    const reject = (reason: ExclusionReason) => excluded.push({ userId: c.userId, reason, distanceM });

    if (alreadyAsked.has(c.userId)) reject("already_asked");
    else if (nowMs - c.capturedAtMs > config.LOCATION_MAX_AGE_S * 1000) reject("stale_location");
    else if (distanceM > radiusM) reject("out_of_radius");
    else if (!c.hasActiveDevice) reject("no_device");
    else if (c.notificationsPaused) reject("paused");
    else if (
      c.lastPromptedAtMs !== null &&
      nowMs - c.lastPromptedAtMs < config.RESPONDER_COOLDOWN_S * 1000
    ) {
      reject("cooldown");
    } else eligible.push({ userId: c.userId, distanceM, source: c.source });
  }

  eligible.sort((a, b) => a.distanceM - b.distanceM);
  return { selected: eligible.slice(0, Math.max(0, count)), excluded };
}

/**
 * How many new people to ask. Returns 0 while the current group still has
 * time to answer. A later wave is the same size as the first, never the
 * rest of the cap at once.
 */
export function nextWaveCount(input: {
  alreadyAsked: number;
  stillWaiting: number;
  maxRecipients: number;
  waveSize: number;
  msSinceLastWave: number;
  expandAfterMs: number;
}): number {
  const room = Math.max(0, input.maxRecipients - input.alreadyAsked);
  if (room === 0 || input.waveSize <= 0) return 0;
  if (input.alreadyAsked === 0) return Math.min(input.waveSize, room);
  const everyoneAnswered = input.stillWaiting <= 0;
  const timedOut = input.msSinceLastWave >= input.expandAfterMs;
  if (!everyoneAnswered && !timedOut) return 0;
  return Math.min(input.waveSize, room);
}
