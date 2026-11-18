/* NT3 — Fram Stock service worker (Web Push). */
/* eslint-disable no-restricted-globals */

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting())
})

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim())
})

async function hasFocusedFramClient() {
  const clientsList = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  })
  return clientsList.some((c) => {
    try {
      if (typeof c.url !== "string" || c.url.length === 0) return false
      // Visible + focused Fram Stock tab → in-app toast only (no OS pop-up).
      // Background/hidden tabs must still get showNotification.
      const visible = c.visibilityState === "visible"
      return c.focused === true && visible
    } catch {
      return false
    }
  })
}

self.addEventListener("push", (event) => {
  event.waitUntil(
    (async () => {
      let data = {
        title: "Fram Stock",
        body: "Notification",
        href: "/requests",
        tag: "fram-stock",
      }
      try {
        if (event.data) {
          const parsed = event.data.json()
          data = { ...data, ...parsed }
        }
      } catch {
        try {
          const text = event.data ? event.data.text() : ""
          if (text) data.body = text.slice(0, 120)
        } catch {
          /* ignore */
        }
      }

      async function broadcast(action) {
        console.log("NT3_SW:" + action, data.tag || "")
        const clientsList = await self.clients.matchAll({
          type: "window",
          includeUncontrolled: true,
        })
        for (const client of clientsList) {
          try {
            client.postMessage({ type: "NT3_SW", action, tag: data.tag || null })
          } catch {
            /* ignore */
          }
        }
      }

      if (await hasFocusedFramClient()) {
        // Tab focused → in-app toast only; skip OS pop-up.
        await broadcast("skip_focused")
        return
      }

      await self.registration.showNotification(data.title || "Fram Stock", {
        body: data.body || "",
        tag: data.tag || "fram-stock",
        data: { href: data.href || "/requests" },
      })
      await broadcast("show")
    })(),
  )
})

self.addEventListener("notificationclick", (event) => {
  event.notification.close()
  const href =
    (event.notification.data && event.notification.data.href) || "/requests"
  const path = typeof href === "string" && href.startsWith("/") ? href : "/requests"

  event.waitUntil(
    (async () => {
      const clientsList = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      })
      for (const client of clientsList) {
        if ("focus" in client) {
          await client.focus()
          if ("navigate" in client) {
            try {
              await client.navigate(path)
              return
            } catch {
              /* fall through */
            }
          }
          // Same-origin postMessage fallback
          try {
            client.postMessage({ type: "fram-stock:navigate", href: path })
          } catch {
            /* ignore */
          }
          return
        }
      }
      if (self.clients.openWindow) {
        await self.clients.openWindow(path)
      }
    })(),
  )
})
