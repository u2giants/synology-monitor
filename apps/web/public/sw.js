// Service Worker for push notifications

self.addEventListener("push", (event) => {
  const data = event.data?.json() ?? {};

  const options = {
    body: data.message || "New alert from NAS Monitor",
    icon: "/icon-192.png",
    badge: "/badge-72.png",
    tag: data.id || "smon-alert",
    data: {
      url: data.url || "/",
    },
    actions: [
      { action: "view", title: "View" },
      { action: "dismiss", title: "Dismiss" },
    ],
  };

  event.waitUntil(
    self.registration.showNotification(
      data.title || "NAS Monitor Alert",
      options
    )
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  if (event.action === "dismiss") return;

  const url = event.notification.data?.url || "/";
  event.waitUntil(clients.openWindow(url));
});
