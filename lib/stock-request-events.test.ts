import { describe, expect, it } from "vitest"
import { describeRequestEvent } from "@/lib/stock-request-events"

describe("describeRequestEvent", () => {
  it("describes a submission", () => {
    expect(describeRequestEvent({ event_type: "submitted", payload: { line_count: 2 } })).toEqual({
      title: "Submitted",
      detail: "2 lines",
    })
  })

  it("explains a rejection with its reason and note", () => {
    expect(
      describeRequestEvent({
        event_type: "rejected",
        payload: { reason_code: "no_atlas_task", note: "Link points at the wrong project" },
      })
    ).toEqual({ title: "Rejected", detail: "No Atlas task — Link points at the wrong project" })
  })

  it("lists issued serials and what is left", () => {
    const partial = describeRequestEvent({
      event_type: "units_issued",
      payload: { count: 1, serials: ["SN1"], outstanding_after: 2 },
    })
    expect(partial).toEqual({ title: "1 unit issued", detail: "SN1 · 2 still outstanding" })
    const full = describeRequestEvent({
      event_type: "units_issued",
      payload: { count: 2, serials: ["SN1", "SN2"], outstanding_after: 0 },
    })
    expect(full.detail).toBe("SN1, SN2 · Fully issued")
  })

  it("describes invoice changes", () => {
    expect(
      describeRequestEvent({ event_type: "invoice_set", payload: { new_status: "invoiced", new_invoice_number: "INV-9" } })
    ).toEqual({ title: "Invoice updated", detail: "Invoice INV-9" })
  })

  it("survives unknown events and bad payloads", () => {
    expect(describeRequestEvent({ event_type: "something_new", payload: null })).toEqual({
      title: "something new",
      detail: null,
    })
    expect(describeRequestEvent({ event_type: "cancelled", payload: "oops" })).toEqual({
      title: "Cancelled",
      detail: null,
    })
  })
})
