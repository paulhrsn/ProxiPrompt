import webpush from "web-push";

let configured = false;

export function initPush(): boolean {
  const pub = process.env.VAPID_PUBLIC_KEY?.trim();
  const priv = process.env.VAPID_PRIVATE_KEY?.trim();
  const subject = process.env.VAPID_SUBJECT?.trim() || "mailto:team@proxiprompt.local";
  if (!pub || !priv) {
    console.warn("VAPID keys missing — push notifications disabled");
    configured = false;
    return false;
  }
  webpush.setVapidDetails(subject, pub, priv);
  configured = true;
  return true;
}

export function pushEnabled(): boolean {
  return configured;
}

export async function sendPush(
  sub: { endpoint: string; p256dh: string; auth: string },
  payload: { title: string; body: string; url: string; tag?: string },
): Promise<"sent" | "gone" | "error"> {
  if (!configured) return "error";
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload),
      { TTL: 120 },
    );
    return "sent";
  } catch (e: unknown) {
    const status = (e as { statusCode?: number }).statusCode;
    if (status === 404 || status === 410) return "gone";
    console.warn("push failed", status, (e as Error).message);
    return "error";
  }
}
