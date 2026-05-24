const APP_CACHE = "alerta-medicinas-v45";
const APP_SHELL = [
  "/",
  "/index.html",
  "/manifest.webmanifest?v=45",
  "/styles.css?v=45",
  "/app.js?v=45",
  "/iconos/logo.png",
  "/iconos/android/mipmap-hdpi/ic_launcher.png",
  "/iconos/android/mipmap-xxxhdpi/ic_launcher.png",
  "/iconos/Assets.xcassets/AppIcon.appiconset/180.png",
  "/iconos/playstore.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(APP_CACHE).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys
    .filter((key) => key.startsWith("alerta-medicinas-") && key !== APP_CACHE)
    .map((key) => caches.delete(key)))).then(() => clients.claim()));
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/") || url.pathname === "/sw.js") return;

  if (request.mode === "navigate") {
    event.respondWith(fetch(request).then((response) => {
      if (response.ok) {
        const copy = response.clone();
        caches.open(APP_CACHE).then((cache) => cache.put("/", copy));
      }
      return response;
    }).catch(async () => (await caches.match("/")) || (await caches.match("/index.html"))));
    return;
  }

  event.respondWith(caches.match(request).then((cached) => {
    if (cached) return cached;
    return fetch(request).then((response) => {
      if (response.ok && ["image", "script", "style", "manifest"].includes(request.destination)) {
        const copy = response.clone();
        caches.open(APP_CACHE).then((cache) => cache.put(request, copy));
      }
      return response;
    }).catch(async () => caches.match(url.pathname));
  }));
});

self.addEventListener("push", (event) => {
  let payload = {
    title: "Recordatorio de medicina",
    body: "Toca para ver tus medicinas.",
    url: "/",
    tag: "medicine-reminder",
  };

  if (event.data) {
    try {
      payload = { ...payload, ...event.data.json() };
    } catch {
      payload.body = event.data.text();
    }
  }

  event.waitUntil(self.registration.showNotification(payload.title, {
    body: payload.body,
    icon: payload.icon || "/iconos/android/mipmap-xxxhdpi/ic_launcher.png",
    badge: payload.badge || "/iconos/android/mipmap-hdpi/ic_launcher.png",
    tag: payload.tag,
    renotify: true,
    data: { url: payload.url || "/" },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data && event.notification.data.url ? event.notification.data.url : "/";
  event.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
    for (const client of clientList) {
      if (client.url.endsWith(url) && "focus" in client) {
        return client.focus();
      }
    }
    if (clients.openWindow) {
      return clients.openWindow(url);
    }
    return null;
  }));
});
