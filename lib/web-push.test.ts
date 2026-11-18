import { describe, expect, it } from "vitest"
import {
  buildPushPayload,
  desktopPushGroupForType,
  desktopPushTypeLabel,
  prefsAllowType,
} from "@/lib/web-push"

describe("web-push helpers", () => {
  it("maps types to groups", () => {
    expect(desktopPushGroupForType("request_submitted")).toBe("new_requests")
    expect(desktopPushGroupForType("request_unclaimed_reminder")).toBe("reminders")
    expect(desktopPushGroupForType("request_units_issued")).toBe("my_request_updated")
    expect(desktopPushGroupForType("pending_role")).toBeNull()
  })

  it("builds privacy-safe payload", () => {
    const p = buildPushPayload({
      notificationId: "n1",
      type: "request_submitted",
      requestNumber: "REQ-9",
      requestId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    })
    expect(p.title).toBe("REQ-9 — New request")
    expect(p.body).toBe("New request")
    expect(p.href).toBe("/requests/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee")
    expect(p.title.toLowerCase()).not.toContain("client")
  })

  it("respects prefs", () => {
    const prefs = {
      enabled: true,
      newRequests: true,
      reminders: false,
      myRequestUpdated: true,
    }
    expect(prefsAllowType(prefs, "request_submitted")).toBe(true)
    expect(prefsAllowType(prefs, "request_unclaimed_reminder")).toBe(false)
    expect(prefsAllowType({ ...prefs, enabled: false }, "request_submitted")).toBe(false)
    expect(desktopPushTypeLabel("request_rejected")).toBe("Request rejected")
  })
})
