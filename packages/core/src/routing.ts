import type { CoreConfig } from "./config";
import { haversineM } from "./geo";

/**
 * A demo pin is the center of a chosen building. Adjacent catalog buildings
 * (Duderstadt and Pierpont, Shapiro and Hatcher) are about 70 m apart, so a
 * demo location only matches the building it was dropped on. 60 m still
 * covers someone placed a few dozen meters from that building's pin.
 */
export const DEMO_MATCH_M = 60;

/**
 * Floor on how much closer another building must be before we exclude someone for being
 * in it. Phones under-report error indoors, so never trust an accuracy figure tighter
 * than this.
 */
export const GPS_CONFIDENCE_FLOOR_M = 20;

/**
 * True when another catalog building is nearer than the target by more than the GPS
 * uncertainty. Within the uncertainty the reading cannot settle which building someone is
 * in, so they stay eligible (ranked last) and the prompt asks them to confirm instead.
 */
function confidentlyElsewhere(c: Candidate, distanceM: number): boolean {
  if (c.nearestOtherBuildingM === undefined) return false;
  const slack = Math.max(c.accuracyM ?? 0, GPS_CONFIDENCE_FLOOR_M);
  return distanceM - c.nearestOtherBuildingM > slack;
}

export interface Candidate {
  userId: string;
  lat: number;
  lng: number;
  source: "gps" | "demo";
  capturedAtMs: number;
  hasActiveDevice: boolean;
  notificationsPaused: boolean;
  lastPromptedAtMs: number | null;
  /** Reported GPS accuracy in metres. Sets how much closer another building must be
   * before we believe the person is in it rather than the target. */
  accuracyM?: number;
  /**
   * Distance to the nearest catalog building OTHER than the target place. Adjacent campus
   * buildings sit 70-80 m apart, inside GPS error, so comparing this against the distance
   * to the target is the only way to tell "inside Duderstadt" from "inside Pierpont".
   * Undefined means unknown, which is treated as no evidence either way.
   */
  nearestOtherBuildingM?: number;
  /**
   * The building this person explicitly said they are in. Unlike `atTargetBuilding` this
   * is a statement, not an inference, so it is trusted over the coordinates: a claim on
   * another building excludes them outright (see `wrong_building`).
   */
  claimedPlaceId?: string | null;
}

export type ExclusionReason =
  | "requester"
  | "stale_location"
  | "out_of_radius"
  | "no_device"
  | "paused"
  | "cooldown"
  | "already_asked"
  | "wrong_building";

export interface SelectInput {
  candidates: Candidate[];
  place: { id?: string; lat: number; lng: number };
  nowMs: number;
  config: CoreConfig;
  radiusM: number;
  /** Max recipients to select in this wave. */
  count: number;
  /** Users already asked for this job. */
  excludeIds: string[];
  /**
   * Every requester whose query is attached to this job, not just the first.
   * One job can serve several queries (see findAttachableJob), and the module
   * rejects a whole batch if any recipient is one of those requesters.
   */
  requesterIds: string[];
}

export interface SelectResult {
  selected: { userId: string; distanceM: number; source: "gps" | "demo"; atTargetBuilding: boolean }[];
  excluded: { userId: string; reason: ExclusionReason; distanceM?: number }[];
}

/**
 * SPEC §7 step 5. Checks run in a fixed order and the first failing check is
 * the reported reason: requester, already_asked, wrong_building, stale_location,
 * out_of_radius, no_device, paused, cooldown. Eligible candidates are ranked with
 * people inside the target building first, then by distance.
 */
export function selectResponders(input: SelectInput): SelectResult {
  const { place, nowMs, config, radiusM, count } = input;
  const alreadyAsked = new Set(input.excludeIds);
  const requesters = new Set(input.requesterIds.filter(Boolean));
  const eligible: SelectResult["selected"] = [];
  const excluded: SelectResult["excluded"] = [];

  for (const c of input.candidates) {
    if (requesters.has(c.userId)) {
      excluded.push({ userId: c.userId, reason: "requester" });
      continue;
    }
    const distanceM = haversineM(place.lat, place.lng, c.lat, c.lng);
    const reject = (reason: ExclusionReason) => excluded.push({ userId: c.userId, reason, distanceM });

    if (alreadyAsked.has(c.userId)) reject("already_asked");
    // A claim on a different building is the person telling us they cannot see this place.
    else if (place.id && c.claimedPlaceId && c.claimedPlaceId !== place.id) reject("wrong_building");
    // No claim, but another building is closer by more than the GPS uncertainty: the fix is
    // confidently not inside the target, so asking them is asking about the wrong building.
    else if (!c.claimedPlaceId && confidentlyElsewhere(c, distanceM)) reject("wrong_building");
    else if (nowMs - c.capturedAtMs > config.LOCATION_MAX_AGE_S * 1000) reject("stale_location");
    else if (distanceM > (c.source === "demo" ? Math.min(radiusM, DEMO_MATCH_M) : radiusM)) reject("out_of_radius");
    else if (!c.hasActiveDevice) reject("no_device");
    else if (c.notificationsPaused) reject("paused");
    else if (
      c.lastPromptedAtMs !== null &&
      nowMs - c.lastPromptedAtMs < config.RESPONDER_COOLDOWN_S * 1000
    ) {
      reject("cooldown");
    } else {
      // A claim on the target place outranks any coordinate-based guess about the building.
      const claimedTarget = !!place.id && c.claimedPlaceId === place.id;
      eligible.push({
        userId: c.userId,
        distanceM,
        source: c.source,
        atTargetBuilding:
          claimedTarget ||
          c.nearestOtherBuildingM === undefined ||
          distanceM <= c.nearestOtherBuildingM,
      });
    }
  }

  // Candidates who read as being inside the target building come first; distance breaks ties.
  eligible.sort((a, b) => {
    if (a.atTargetBuilding !== b.atTargetBuilding) return a.atTargetBuilding ? -1 : 1;
    return a.distanceM - b.distanceM;
  });
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
