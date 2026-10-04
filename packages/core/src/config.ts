export interface CoreConfig {
  FIRST_WAVE: number;
  MAX_RECIPIENTS: number;
  EXPAND_AFTER_S: number;
  JOB_DEADLINE_S: number;
  /** Responses are still accepted (as observations) until this many seconds after job start. */
  LATE_ACCEPT_S: number;
  RESPONDER_COOLDOWN_S: number;
  PROMPT_EXPIRY_S: number;
  LOCATION_MAX_AGE_S: number;
  SUFFICIENT_SCORE: number;
  /** Requesters who answered neighbors recently go first and reach more people (SPEC §7). */
  RECIPROCAL_PRIORITY: boolean;
}

/** Timing config, SPEC §7 (and §4 for location age). */
export function getConfig(demoMode: boolean): CoreConfig {
  return demoMode
    ? {
        FIRST_WAVE: 10,
        MAX_RECIPIENTS: 20,
        EXPAND_AFTER_S: 10,
        JOB_DEADLINE_S: 30,
        LATE_ACCEPT_S: 120,
        RESPONDER_COOLDOWN_S: 60,
        PROMPT_EXPIRY_S: 600,
        LOCATION_MAX_AGE_S: 21600,
        SUFFICIENT_SCORE: 0.6,
        RECIPROCAL_PRIORITY: true,
      }
    : {
        FIRST_WAVE: 10,
        MAX_RECIPIENTS: 20,
        EXPAND_AFTER_S: 30,
        JOB_DEADLINE_S: 120,
        LATE_ACCEPT_S: 600,
        RESPONDER_COOLDOWN_S: 600,
        PROMPT_EXPIRY_S: 600,
        LOCATION_MAX_AGE_S: 1800,
        SUFFICIENT_SCORE: 0.6,
        RECIPROCAL_PRIORITY: true,
      };
}
