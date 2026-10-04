import { describe, expect, it } from "vitest";
import { getConfig } from "../src/config";

describe("getConfig", () => {
  it("normal mode matches SPEC §7", () => {
    expect(getConfig(false)).toEqual({
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
    });
  });

  it("demo mode matches SPEC §7", () => {
    expect(getConfig(true)).toEqual({
      FIRST_WAVE: 10,
      MAX_RECIPIENTS: 20,
      EXPAND_AFTER_S: 30,
      JOB_DEADLINE_S: 60,
      LATE_ACCEPT_S: 120,
      RESPONDER_COOLDOWN_S: 60,
      PROMPT_EXPIRY_S: 600,
      LOCATION_MAX_AGE_S: 21600,
      SUFFICIENT_SCORE: 0.6,
      RECIPROCAL_PRIORITY: true,
    });
  });
});
