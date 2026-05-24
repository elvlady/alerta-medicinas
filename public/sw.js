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
