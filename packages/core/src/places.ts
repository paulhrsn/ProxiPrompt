import { haversineM } from "./geo";

export interface CatalogPlace {
  id: string;
  name: string;
  category: string;
  lat: number;
  lng: number;
  address: string;
  community: string;
  aliases: string[];
}

/** Curated Ann Arbor catalog (SPEC §5). Approximate coordinates; used when Google Places is unavailable. */
export const CATALOG_PLACES: readonly CatalogPlace[] = [
  { id: "shapiro-undergraduate-library", name: "Shapiro Undergraduate Library", category: "library", lat: 42.2757, lng: -83.7382, address: "919 S University Ave, Ann Arbor, MI", community: "umich-annarbor", aliases: ["shapiro", "ugli", "undergrad library"] },
  { id: "hatcher-graduate-library", name: "Hatcher Graduate Library", category: "library", lat: 42.2763, lng: -83.7385, address: "913 S University Ave, Ann Arbor, MI", community: "umich-annarbor", aliases: ["hatcher", "grad library"] },
  { id: "michigan-union", name: "Michigan Union", category: "student_union", lat: 42.2750, lng: -83.7413, address: "530 S State St, Ann Arbor, MI", community: "umich-annarbor", aliases: ["michigan union", "the union"] },
  { id: "duderstadt-center", name: "Duderstadt Center", category: "library", lat: 42.2909, lng: -83.7168, address: "2281 Bonisteel Blvd, Ann Arbor, MI", community: "umich-annarbor", aliases: ["duderstadt", "dude"] },
  { id: "pierpont-commons", name: "Pierpont Commons", category: "student_union", lat: 42.2915, lng: -83.7163, address: "2101 Bonisteel Blvd, Ann Arbor, MI", community: "umich-annarbor", aliases: ["pierpont"] },
  { id: "ross-school-of-business", name: "Ross School of Business", category: "academic", lat: 42.2733, lng: -83.7388, address: "701 Tappan Ave, Ann Arbor, MI", community: "umich-annarbor", aliases: ["ross", "ross school"] },
  { id: "ccrb", name: "Central Campus Recreation Building", category: "gym", lat: 42.2756, lng: -83.7316, address: "401 Washtenaw Ave, Ann Arbor, MI", community: "umich-annarbor", aliases: ["ccrb", "central campus rec"] },
  { id: "ims", name: "Intramural Sports Building", category: "gym", lat: 42.2696, lng: -83.7399, address: "606 E Hoover Ave, Ann Arbor, MI", community: "umich-annarbor", aliases: ["ims", "intramural"] },
  { id: "nccrb", name: "North Campus Recreation Building", category: "gym", lat: 42.2928, lng: -83.7137, address: "2375 Hubbard Rd, Ann Arbor, MI", community: "umich-annarbor", aliases: ["nccrb", "north campus rec"] },
  { id: "south-quad-dining", name: "South Quad Dining", category: "dining", lat: 42.2735, lng: -83.7425, address: "600 E Madison St, Ann Arbor, MI", community: "umich-annarbor", aliases: ["south quad"] },
  { id: "mosher-jordan-dining", name: "Mosher-Jordan Dining", category: "dining", lat: 42.2779, lng: -83.7300, address: "200 Observatory St, Ann Arbor, MI", community: "umich-annarbor", aliases: ["mosher", "mojo"] },
  { id: "east-quad-dining", name: "East Quad Dining", category: "dining", lat: 42.2731, lng: -83.7347, address: "701 E University Ave, Ann Arbor, MI", community: "umich-annarbor", aliases: ["east quad"] },
  { id: "the-diag", name: "The Diag", category: "park", lat: 42.2767, lng: -83.7409, address: "500 S State St, Ann Arbor, MI", community: "umich-annarbor", aliases: ["diag"] },
  { id: "zingermans-delicatessen", name: "Zingerman's Delicatessen", category: "restaurant", lat: 42.2829, lng: -83.7478, address: "422 Detroit St, Ann Arbor, MI", community: "umich-annarbor", aliases: ["zingerman", "zingermans"] },
  { id: "blake-transit-center", name: "Blake Transit Center", category: "transit", lat: 42.2800, lng: -83.7488, address: "328 S Fifth Ave, Ann Arbor, MI", community: "umich-annarbor", aliases: ["blake", "transit center"] },
  { id: "michigan-stadium", name: "Michigan Stadium", category: "stadium", lat: 42.2658, lng: -83.7487, address: "1201 S Main St, Ann Arbor, MI", community: "umich-annarbor", aliases: ["stadium", "big house"] },
];

export const DEFAULT_COMMUNITY = "umich-annarbor";

export function resolveCatalogPlace(text: string): CatalogPlace | undefined {
  const t = (text || "").toLowerCase();
  let best: CatalogPlace | undefined;
  let bestLen = 0;
  for (const p of CATALOG_PLACES) {
    for (const term of [p.name.toLowerCase(), ...p.aliases]) {
      if (t.includes(term) && term.length > bestLen) {
        best = p;
        bestLen = term.length;
      }
    }
  }
  return best;
}

export function findCatalogPlace(id: string): CatalogPlace | undefined {
  return CATALOG_PLACES.find((p) => p.id === id);
}

/** A catalog name is only offered inside this radius. */
const NAMED_WITHIN_M = 400;
/** A second building is a real alternative when it is this close to the first. */
const AMBIGUOUS_GAP_M = 80;

export interface LocationDescription {
  coords: string;
  /** Nearest catalog places inside the naming radius, nearest first. At most two. */
  places: CatalogPlace[];
  /** True when the two nearest buildings are too close to pick a winner. */
  ambiguous: boolean;
  label: string;
}

/**
 * Name a GPS fix from the catalog without claiming one building when two are
 * about equally close. The coordinates themselves are unchanged.
 */
export function describeLocation(lat: number, lng: number, places: readonly CatalogPlace[] = CATALOG_PLACES): LocationDescription {
  const coords = `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
  const ranked = places
    .map((place) => ({ place, distanceM: haversineM(lat, lng, place.lat, place.lng) }))
    .filter((row) => row.distanceM < NAMED_WITHIN_M)
    .sort((a, b) => a.distanceM - b.distanceM);
  const first = ranked[0];
  const second = ranked[1];
  if (!first) return { coords, places: [], ambiguous: false, label: coords };
  const ambiguous = !!second && second.distanceM - first.distanceM < AMBIGUOUS_GAP_M && second.distanceM < Math.max(first.distanceM * 1.45, first.distanceM + 45);
  if (ambiguous && second) {
    return {
      coords,
      places: [first.place, second.place],
      ambiguous: true,
      label: `Between ${first.place.name} and ${second.place.name} (${coords})`,
    };
  }
  return { coords, places: [first.place], ambiguous: false, label: `Near ${first.place.name} (${coords})` };
}
