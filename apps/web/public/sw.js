self.addEventListener("install", (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open("pp-v2").then((c) => c.addAll(["/", "/manifest.webmanifest", "/logo.png"])));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(Promise.all([
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith("pp-v") && key !== "pp-v2").map((key) => caches.delete(key)))),
    self.clients.claim(),
  ]));
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request).then((r) => r || caches.match("/"))),
  );
});

self.addEventListener("push", (e) => {
  let data = { title: "ProxiPrompt", body: "New update", url: "/", tag: "pp" };
  try {
    data = { ...data, ...e.data.json() };
  } catch {
    if (e.data) data.body = e.data.text();
  }
  e.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      tag: data.tag,
      data: { url: data.url },
      icon: "/logo.png",
    }),
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = e.notification.data?.url || "/";
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const c of clients) {
        c.navigate(url);
        return c.focus();
      }
      return self.clients.openWindow(url);
    }),
  );
});
