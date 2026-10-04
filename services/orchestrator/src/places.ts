import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CATALOG_PLACES, DEFAULT_COMMUNITY, haversineM, type CatalogPlace } from "@proxiprompt/core";

const CAMPUS = { lat: 42.278, lng: -83.738 };
const CAMPUS_M = 30_000;

export type PlaceHit = CatalogPlace;

export function catalogHits(query: string): PlaceHit[] {
  const t = query.trim().toLowerCase();
  if (!t) return [];
  return CATALOG_PLACES.filter((p) => `${p.name} ${p.aliases.join(" ")} ${p.address}`.toLowerCase().includes(t)).slice(0, 6);
}

export function mergePlaces(local: PlaceHit[], remote: PlaceHit[]): PlaceHit[] {
  const seen = new Set(local.map((p) => p.id));
  return [...local, ...remote.filter((p) => p.id && !seen.has(p.id))].slice(0, 8);
}

export function placesApiKey(): string {
  const fromEnv = process.env.GOOGLE_PLACES_API_KEY || process.env.GOOGLE_MAPS_API_KEY || process.env.VITE_GOOGLE_MAPS_API_KEY;
  if (fromEnv?.trim()) return fromEnv.trim();
  try {
    const file = join(dirname(fileURLToPath(import.meta.url)), "../../../apps/web/.env");
    const line = readFileSync(file, "utf8").split("\n").find((row) => row.startsWith("VITE_GOOGLE_MAPS_API_KEY="));
    return line?.slice("VITE_GOOGLE_MAPS_API_KEY=".length).trim().replace(/^["']|["']$/g, "") ?? "";
  } catch {
    return "";
  }
}

interface GooglePlace {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  location?: { latitude?: number; longitude?: number };
  primaryType?: string;
}

export function hitsFromGoogle(places: GooglePlace[]): PlaceHit[] {
  const out: PlaceHit[] = [];
  for (const p of places) {
    const lat = p.location?.latitude;
    const lng = p.location?.longitude;
    const name = p.displayName?.text?.trim();
    if (!p.id || !name || lat == null || lng == null) continue;
    const nearCampus = haversineM(lat, lng, CAMPUS.lat, CAMPUS.lng) <= CAMPUS_M;
    out.push({
      id: p.id,
      name,
      category: (p.primaryType || "place").slice(0, 40),
      lat,
      lng,
      address: (p.formattedAddress || "").slice(0, 200),
      community: nearCampus ? DEFAULT_COMMUNITY : "other",
      aliases: [],
    });
  }
  return out;
}

async function googlePlaces(query: string, key: string): Promise<PlaceHit[]> {
  const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": key,
      "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress,places.location,places.primaryType",
    },
    body: JSON.stringify({
      textQuery: query,
      maxResultCount: 5,
      locationBias: {
        circle: { center: { latitude: CAMPUS.lat, longitude: CAMPUS.lng }, radius: 25000 },
      },
    }),
  });
  if (!res.ok) throw new Error(`places ${res.status}`);
  const data = (await res.json()) as { places?: GooglePlace[] };
  return hitsFromGoogle(data.places ?? []);
}

/** Catalog matches first. Google Places is added when a key is set; otherwise the catalog is the whole list. */
export async function searchPlaces(query: string): Promise<PlaceHit[]> {
  const local = catalogHits(query);
  const key = placesApiKey();
  if (!key || query.trim().length < 2) return local;
  try {
    return mergePlaces(local, await googlePlaces(query.trim(), key));
  } catch (e) {
    console.warn("places lookup failed", (e as Error).message);
    return local;
  }
}
