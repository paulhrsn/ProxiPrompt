import type { Conn } from "./spacetime";

/** Remove both browser delivery and the old identity's server registration before switching. */
export async function detachPush(conn: Conn): Promise<void> {
  if (!("serviceWorker" in navigator)) return;
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  const endpoint = sub?.endpoint ?? localStorage.getItem("pp.pushEndpoint");
  if (!endpoint) return;
  localStorage.setItem("pp.pushEndpoint", endpoint);
  if (sub && !await sub.unsubscribe()) {
    throw new Error("Could not stop this device's notifications. Try again before signing out.");
  }
  // An expired or already transferred endpoint may be absent from this account's view.
  const owns = [...conn.db.myDevices.iter()].some(d => d.endpoint === endpoint && d.active);
  if (owns) await conn.reducers.deactivateDevice({ endpoint });
  localStorage.removeItem("pp.pushEndpoint");
}

/** Restore an existing, already permitted subscription for the newly signed-in identity. */
export async function restorePush(conn: Conn): Promise<void> {
  if (!("serviceWorker" in navigator) || !("Notification" in window) || Notification.permission !== "granted") return;
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg || !("PushManager" in window)) return;
  let sub = await reg.pushManager.getSubscription();
  const key = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined;
  if (!sub && key && localStorage.getItem("pp.pushEnabled") === "1") {
    sub = await reg.pushManager.subscribe({userVisibleOnly:true, applicationServerKey:urlBase64ToUint8Array(key)});
  }
  if (sub) await registerPush(conn, sub);
}

async function registerPush(conn: Conn, sub: PushSubscription) {
  const json = sub.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) throw new Error("Incomplete push subscription");
  await conn.reducers.registerDevice({endpoint:json.endpoint, p256Dh:json.keys.p256dh,
    auth:json.keys.auth, userAgent:navigator.userAgent.slice(0,300)});
  localStorage.setItem("pp.pushEnabled", "1");
  localStorage.setItem("pp.pushEndpoint", json.endpoint);
}

export async function enablePush(conn: Conn): Promise<string> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return "This browser cannot receive Web Push.";
  const reg = await navigator.serviceWorker.register("/sw.js");
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return "Notifications were not granted.";
  const key = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined;
  if (!key) return "VITE_VAPID_PUBLIC_KEY is not set. Generate keys and restart the web app.";
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(key),
  });
  await registerPush(conn, sub);
  return "Notifications enabled.";
}

function urlBase64ToUint8Array(base64: string) {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}
