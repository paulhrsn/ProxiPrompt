import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { CATALOG_PLACES, haversineM } from "@proxiprompt/core";
import { list, useDb } from "./spacetime";
import { restorePush } from "./push";

type Point = { lat: number; lng: number };
type Claim = Point & { id: string };
interface LocationState {
  demo: string; setDemo: (value: string) => void;
  gpsFix: Point | null; gpsError: string;
  claim: Claim | null; setClaim: (value: Claim | null) => void;
}
const Context = createContext<LocationState | null>(null);

export function LocationProvider({ children }: { children: ReactNode }) {
  const { conn, tick } = useDb();
  const ready = !!conn && list(conn.db.myProfile.iter()).length > 0;
  void tick;
  const [demo, selectDemo] = useState(localStorage.getItem("pp.demoPlace") ?? "");
  const [gpsFix, setGpsFix] = useState<Point | null>(null);
  const [gpsError, setGpsError] = useState("");
  const [claim, setClaim] = useState<Claim | null>(loadPlaceClaim);
  function setDemo(next: string) {
    if (next) localStorage.setItem("pp.demoPlace", next);
    else localStorage.removeItem("pp.demoPlace");
    setGpsFix(null); setGpsError(""); selectDemo(next);
  }

  useEffect(() => {
    if (conn && ready) void restorePush(conn).catch(err => console.warn("Notification registration failed", err));
  }, [conn, ready]);

  useEffect(() => {
    if (!conn || !ready) return;
    let closed = false;
    let watch: number | undefined;
    const foreground = () => !closed && document.visibilityState !== "hidden";
    const error = (err: unknown) => { if (!closed) setGpsError(err instanceof Error ? err.message : String(err)); };
    function savePosition(pos: GeolocationPosition) {
      if (!foreground()) return;
      const lat = pos.coords.latitude, lng = pos.coords.longitude;
      const age = Date.now() - pos.timestamp;
      if (age > 60000) return; // Never turn an old GPS fix into a fresh one.
      setGpsFix({ lat, lng }); setGpsError("");
      const stillHere = claim && haversineM(claim.lat, claim.lng, lat, lng) <= CLAIM_VALID_M;
      void conn!.reducers.updateLocation({ lat, lng,
        accuracyM: Number.isFinite(pos.coords.accuracy) ? pos.coords.accuracy : 50,
        source: "gps", claimedPlaceId: stillHere ? claim.id : "" }).catch(error);
    }
    function refresh() {
      if (!foreground()) return;
      void conn!.reducers.heartbeat({ active: true }).catch(error);
      if (demo) {
        const place = CATALOG_PLACES.find(p => p.id === demo);
        if (place) void conn!.reducers.updateLocation({ lat: place.lat, lng: place.lng,
          accuracyM: 15, source: "demo", claimedPlaceId: place.id }).catch(error);
      } else if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(savePosition,
          err => { if (foreground()) setGpsError(err.message || "Location permission was denied"); },
          { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
      } else setGpsError("This browser has no GPS");
    }
    function visibility() {
      if (foreground()) {
        refresh();
        if (!demo && navigator.geolocation && watch === undefined) {
          watch = navigator.geolocation.watchPosition(savePosition,
            err => { if (foreground()) setGpsError(err.message || "Location permission was denied"); },
            { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
        }
      } else {
        if (watch !== undefined) navigator.geolocation.clearWatch(watch);
        watch = undefined;
        // Keep the last heartbeat for the worker's two-minute grace period. A connected
        // background tab can receive a prompt while the user switches to the asker.
        // Do not renew it here: stale tabs expire, and disconnect/logout removes it.
      }
    }
    visibility();
    const timer = setInterval(refresh, 30000);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      closed = true; clearInterval(timer);
      document.removeEventListener("visibilitychange", visibility);
      if (watch !== undefined) navigator.geolocation.clearWatch(watch);
      void conn.reducers.heartbeat({ active: false }).catch(() => {});
    };
  }, [conn, ready, demo, claim]);
  return <Context.Provider value={{ demo, setDemo, gpsFix, gpsError, claim, setClaim }}>{children}</Context.Provider>;
}

export function useLocation() {
  const state = useContext(Context);
  if (!state) throw new Error("LocationProvider is missing");
  return state;
}

/** A claimed building only applies while you are still near where you claimed it. */
export const CLAIM_VALID_M = 80;

const PLACE_CLAIM_KEY = "pp.placeClaim";

function loadPlaceClaim(): { id: string; lat: number; lng: number } | null {
  try {
    const raw = localStorage.getItem(PLACE_CLAIM_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { id?: unknown; lat?: unknown; lng?: unknown };
    if (typeof parsed.id !== "string" || typeof parsed.lat !== "number" || typeof parsed.lng !== "number") return null;
    return { id: parsed.id, lat: parsed.lat, lng: parsed.lng };
  } catch {
    return null;
  }
}

export function savePlaceClaim(
  next: { id: string; lat: number; lng: number } | null,
  setClaim: (value: { id: string; lat: number; lng: number } | null) => void,
) {
  setClaim(next);
  if (!next) localStorage.removeItem(PLACE_CLAIM_KEY);
  else localStorage.setItem(PLACE_CLAIM_KEY, JSON.stringify(next));
}
