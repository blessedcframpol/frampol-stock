import { describe, expect, it } from "vitest"
import {
  applyCloudKeyToAwaiting,
  applySuccessfulSerial,
  buildEmptySlots,
  consumeScanBuffer,
  enqueueScans,
  filledScansForIssue,
  issueButtonLabel,
  removeSlotSerial,
  takeNextScan,
  type IssueScanSlot,
  type PreviewIssueScanResult,
} from "@/lib/issue-scan"

const lines = [
  { id: "L1", product_name: "Starlink Standard Kit v4", quantity_requested: 2 },
  { id: "L2", product_name: "FortiGate 50G", quantity_requested: 1 },
]

describe("issue-scan buffer", () => {
  it("splits Enter and Tab terminated scans and keeps the rest", () => {
    expect(consumeScanBuffer("KIT111\nKIT222\npartial")).toEqual({
      complete: ["KIT111", "KIT222"],
      rest: "partial",
    })
    expect(consumeScanBuffer("KIT111\tKIT222\t")).toEqual({
      complete: ["KIT111", "KIT222"],
      rest: "",
    })
    expect(consumeScanBuffer("no-terminator")).toEqual({ complete: [], rest: "no-terminator" })
  })

  it("queues rapid scans in order", () => {
    const q = enqueueScans([], ["A", "B"])
    expect(takeNextScan(q)).toEqual({ next: "A", rest: ["B"] })
    expect(takeNextScan(["B", "C"]).next).toBe("B")
  })
})

describe("issue-scan slots", () => {
  it("builds one empty slot per outstanding unit", () => {
    const slots = buildEmptySlots(lines, { L1: 1, L2: 0 })
    expect(slots).toHaveLength(2)
    expect(slots.map((s) => s.lineId)).toEqual(["L1", "L2"])
  })

  it("fills the next slot and switches to cloud-key mode when needed", () => {
    const slots = buildEmptySlots(lines, {})
    const preview: PreviewIssueScanResult = {
      ok: true,
      serial: "FGT50G1",
      line_id: "L2",
      product_id: "P2",
      product_name: "FortiGate 50G",
      needs_cloud_key: true,
      cloud_key_prompt: "Scan the cloud key for FortiGate 50G",
    }
    const applied = applySuccessfulSerial(slots, preview)
    expect(applied?.mode).toBe("cloud_key")
    expect(applied?.slots.find((s) => s.lineId === "L2")?.status).toBe("awaiting_cloud_key")
    const withKey = applyCloudKeyToAwaiting(applied!.slots, "CK-99")
    expect(withKey.ok).toBe(true)
    expect(withKey.slots.find((s) => s.lineId === "L2")).toMatchObject({
      status: "ok",
      cloudKey: "CK-99",
      serial: "FGT50G1",
    })
  })

  it("rejects a duplicate by leaving slots unchanged for applyFailedSerial path", () => {
    let slots = buildEmptySlots(lines, {})
    const preview: Extract<PreviewIssueScanResult, { ok: true }> = {
      ok: true,
      serial: "KIT1",
      line_id: "L1",
      product_id: "P1",
      product_name: "Starlink Standard Kit v4",
      needs_cloud_key: false,
    }
    slots = applySuccessfulSerial(slots, preview)!.slots
    expect(slots.filter((s) => s.serial === "KIT1")).toHaveLength(1)
    const cleared = removeSlotSerial(slots, slots.find((s) => s.serial === "KIT1")!.id)
    expect(cleared.find((s) => s.id.startsWith("L1-0"))?.status).toBe("empty")
  })

  it("labels partial issue with a confirm message", () => {
    expect(issueButtonLabel(2, 3)).toEqual({
      label: "Issue 2 of 3",
      needsConfirm: true,
      confirmMessage: "Issue 2 of 3? The request stays open for 1.",
    })
    expect(issueButtonLabel(3, 3).needsConfirm).toBe(false)
  })

  it("collects filled scans for issue_units", () => {
    const slots: IssueScanSlot[] = [
      {
        id: "a",
        lineId: "L1",
        productId: "P1",
        productName: "X",
        serial: "S1",
        cloudKey: null,
        status: "ok",
        reason: null,
      },
      {
        id: "b",
        lineId: "L1",
        productId: "P1",
        productName: "X",
        serial: null,
        cloudKey: null,
        status: "empty",
        reason: null,
      },
    ]
    expect(filledScansForIssue(slots)).toEqual([{ serial: "S1", lineId: "L1", cloudKey: null }])
  })

  it("fills a slot by product_id when line_id differs (dev preview remap)", () => {
    const slots = buildEmptySlots(
      [{ id: "fixture-L1", product_id: "P1", product_name: "Starlink Standard Kit v4", quantity_requested: 1 }],
      {},
    )
    const applied = applySuccessfulSerial(slots, {
      ok: true,
      serial: "KIT1",
      line_id: "server-line-uuid",
      product_id: "P1",
      product_name: "Starlink Standard Kit v4",
      needs_cloud_key: false,
    })
    expect(applied?.slots[0]?.serial).toBe("KIT1")
    expect(applied?.slots[0]?.lineId).toBe("fixture-L1")
  })
})
