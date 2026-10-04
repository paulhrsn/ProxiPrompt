// Pure logic for the simulated neighbors (scripts/demo-neighbors.ts): who the bots are, how busy a
// place plausibly is at a given hour, which option a bot picks for each survey control, and what
// seed Live Pulse posts say. No I/O and no clock: the caller passes `hour` and `rng`, so every
// function here is deterministic under test.

export interface ControlOption {
  value: string;
  label: string;
  ordinal: number;
}
export interface Control {
  dimension_key: string;
  label: string;
  options: ControlOption[];
}

export interface Persona {
  username: string;
  placeId: string;
}

/** Order matters: the first 8 give the default spread (3 Shapiro, 2 Duderstadt, Union, CCRB, a dining hall). */
export const PERSONAS: readonly Persona[] = [
  { username: "maya_sim", placeId: "shapiro-undergraduate-library" },
  { username: "dev_sim", placeId: "shapiro-undergraduate-library" },
  { username: "priya_sim", placeId: "shapiro-undergraduate-library" },
  { username: "jordan_sim", placeId: "duderstadt-center" },
  { username: "sam_sim", placeId: "duderstadt-center" },
  { username: "lena_sim", placeId: "michigan-union" },
  { username: "theo_sim", placeId: "ccrb" },
  { username: "ana_sim", placeId: "east-quad-dining" },
  { username: "kai_sim", placeId: "hatcher-graduate-library" },
  { username: "noor_sim", placeId: "pierpont-commons" },
  { username: "eli_sim", placeId: "south-quad-dining" },
  { username: "zoe_sim", placeId: "the-diag" },
];

export const PRESENCE_KEY = "other:place_part";
const FREEFORM_KEY = "other:answer";

type Band = [from: number, to: number, level: number];
function band(hour: number, bands: Band[], fallback: number): number {
  const h = ((Math.floor(hour) % 24) + 24) % 24;
  for (const [a, b, level] of bands) if (h >= a && h < b) return level;
  return fallback;
}

/** How crowded a kind of place plausibly is at a local hour, 0 (empty) to 1 (packed). */
export function busyness(category: string, hour: number): number {
  switch (category) {
    case "library":
      return band(hour, [[0, 6, 0.1], [6, 9, 0.25], [9, 12, 0.55], [12, 17, 0.7], [17, 20, 0.55], [20, 23, 0.4]], 0.2);
    case "dining":
      return band(hour, [[7, 9, 0.7], [11, 14, 0.85], [17, 20, 0.85], [9, 11, 0.3], [14, 17, 0.2]], 0.08);
    case "gym":
      return band(hour, [[6, 9, 0.6], [16, 21, 0.85], [9, 16, 0.4]], 0.1);
    case "student_union":
      return band(hour, [[11, 15, 0.75], [8, 11, 0.5], [15, 20, 0.6]], 0.2);
    case "park":
      return band(hour, [[10, 18, 0.55], [8, 10, 0.35], [18, 21, 0.35]], 0.1);
    case "transit":
      return band(hour, [[7, 10, 0.7], [15, 19, 0.7], [10, 15, 0.45]], 0.2);
    default:
      return band(hour, [[10, 18, 0.6]], 0.25);
  }
}

const BUSY_LIKE = new Set(["crowd_level", "line_length", "wait_time", "noise_level", "atmosphere"]);
const ROOM_LIKE = new Set(["seating_availability", "equipment_availability", "parking_availability"]);

/** Where on the low-to-high ordinal scale this dimension plausibly sits (0..1), or null for no prior. */
function targetLevel(key: string, busy: number): number | null {
  if (BUSY_LIKE.has(key)) return busy;
  if (ROOM_LIKE.has(key)) return 1 - busy;
  switch (key) {
    case "event_status":
      return busy * 0.4;
    case "food_availability":
      return 0.75 - 0.3 * busy;
    case "open_status":
      return 1;
    case "cleanliness":
      return 0.75;
    case "temperature":
      return 0.5;
    case "worth_it":
      return 0.6;
    default:
      return null;
  }
}

const SIGMA = 0.2;
const FLOOR = 0.04;

function weightedPick<T>(items: T[], weights: number[], rng: () => number): T {
  const total = weights.reduce((a, b) => a + b, 0);
  let roll = rng() * total;
  for (let i = 0; i < items.length; i++) {
    roll -= weights[i];
    if (roll < 0) return items[i];
  }
  return items[items.length - 1];
}

function pickOption(control: Control, busy: number, rng: () => number): string {
  const opts = [...control.options].sort((a, b) => a.ordinal - b.ordinal);
  if (opts.length === 1) return opts[0].value;
  if (control.dimension_key === FREEFORM_KEY) {
    const w: Record<string, number> = { yes: 0.45, no: 0.35, unsure: 0.2 };
    if (opts.every((o) => o.value in w)) return weightedPick(opts, opts.map((o) => w[o.value]), rng).value;
  }
  const target = targetLevel(control.dimension_key, busy);
  if (target == null) return weightedPick(opts, opts.map(() => 1), rng).value;
  const weights = opts.map((_, i) => {
    const level = i / (opts.length - 1);
    return Math.exp(-((level - target) ** 2) / (2 * SIGMA ** 2)) + FLOOR;
  });
  return weightedPick(opts, weights, rng).value;
}

const NOTES: Record<string, string[]> = {
  library: [
    "Mostly heads-down studying in here.",
    "Found a spot on the second floor, pretty calm.",
    "A few group tables are loud, the rest is fine.",
    "Someone is on a call near the entrance.",
    "Outlets by the windows are taken.",
  ],
  dining: [
    "Line is moving at a decent pace.",
    "The grill station has the longest line.",
    "Plenty of tables over by the windows.",
    "Just got here, it is filling up.",
  ],
  gym: [
    "Racks are mostly free, cardio floor is busier.",
    "Peak time crowd just walked in.",
    "Bench area has a short wait.",
  ],
  student_union: [
    "Lots of people grabbing lunch.",
    "Study tables upstairs are mostly free.",
    "A student org has a table set up near the entrance.",
  ],
  default: ["Just checked, this is what I see.", "Looks about like this right now.", "Quick look around, hope that helps."],
};

export interface ChooseInput {
  controls: Control[];
  placeCategory: string;
  /** Local hour 0-23 at the place. */
  hour: number;
  rng: () => number;
}
export interface ChosenAnswer {
  answers: Record<string, string>;
  note: string;
  /** True when the bot declined with `not_here` (answers then holds only the presence key). */
  pass: boolean;
}

const PASS_CHANCE = 0.04;
const NOTE_CHANCE = 0.35;

/**
 * Pick what a plausible human at this place would answer, the way the web AnswerForm submits:
 * every visible control answered, the presence control left out unless the person passes, in
 * which case only `{ "other:place_part": "not_here" }` is sent.
 */
export function chooseAnswer({ controls, placeCategory, hour, rng }: ChooseInput): ChosenAnswer {
  const presence = controls.find((c) => c.dimension_key === PRESENCE_KEY);
  const passOption = presence?.options.find((o) => o.value === "not_here");
  const passRoll = rng();
  if (presence && passOption && passRoll < PASS_CHANCE) {
    return { answers: { [PRESENCE_KEY]: passOption.value }, note: "", pass: true };
  }
  const busy = busyness(placeCategory, hour);
  const answers: Record<string, string> = {};
  for (const c of controls) {
    if (c.dimension_key === PRESENCE_KEY || c.options.length === 0) continue;
    answers[c.dimension_key] = pickOption(c, busy, rng);
  }
  let note = "";
  if (Object.keys(answers).length > 0 && rng() < NOTE_CHANCE) {
    const pool = NOTES[placeCategory] ?? NOTES.default;
    note = pool[Math.min(pool.length - 1, Math.floor(rng() * pool.length))];
  }
  return { answers, note, pass: false };
}

const POSTS: Record<string, string[]> = {
  library: [
    "Main floor is quiet right now, plenty of single desks open.",
    "Group study rooms are all booked but the open tables are mostly empty.",
    "Pretty full downstairs, upper floors have seats.",
    "Outlet seats by the windows are gone, rest of the floor is calm.",
  ],
  dining: [
    "Line is short right now, grab food before the rush.",
    "Lunch crowd just hit, about a 10 minute wait at the grill.",
    "Tables are open but the main line is long.",
  ],
  gym: [
    "Squat racks are free, cardio machines are mostly taken.",
    "Pretty empty right now, no waits on equipment.",
    "Packed after classes, bench has a short line.",
  ],
  student_union: [
    "Food court is busy, study tables upstairs are open.",
    "Quiet in here this afternoon, lots of couches free.",
  ],
  park: ["Sunny and lots of people on the grass, easy to find a spot.", "Pretty chill out here, a few people on benches."],
  transit: ["Buses are running on time, short wait at the platform.", "Crowded platform, next bus is a few minutes out."],
  default: ["Pretty normal crowd here right now.", "Not too busy, easy to find a spot."],
};

/** A short, plausible Live Pulse report for a place of this category. */
export function seedPostText(category: string, _hour: number, rng: () => number): string {
  const pool = POSTS[category] ?? POSTS.default;
  return pool[Math.min(pool.length - 1, Math.floor(rng() * pool.length))];
}
