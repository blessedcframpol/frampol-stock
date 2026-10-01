import { describe, expect, it } from "vitest"
import {
  canMarkRequestInvoiced,
  lineRequiresSerialAssignment,
  linesBlockingServiced,
} from "@/lib/stock-request-rules"

describe("lineRequiresSerialAssignment", () => {
  it("is true when requires_serial is true", () => {
    expect(lineRequiresSerialAssignment({ requires_serial: true })).toBe(true)
  })

  it("is false when requires_serial is false", () => {
    expect(lineRequiresSerialAssignment({ requires_serial: false })).toBe(false)
  })

  it("does not infer from the product name", () => {
    expect(
      lineRequiresSerialAssignment({
        requires_serial: false,
      })
    ).toBe(false)
  })
})

describe("linesBlockingServiced", () => {
  it("0 of 2 assigned blocks a serial-tracked line", () => {
    const blocking = linesBlockingServiced(
      [
        {
          id: "l1",
          product_name: "Starlink Standard Kit v4",
          quantity_requested: 2,
          requires_serial: true,
        },
      ],
      { l1: 0 }
    )
    expect(blocking).toEqual([
      { lineId: "l1", productName: "Starlink Standard Kit v4", assigned: 0, required: 2 },
    ])
  })

  it("1 of 2 assigned blocks", () => {
    const blocking = linesBlockingServiced(
      [{ id: "l1", product_name: "Widget", quantity_requested: 2, requires_serial: true }],
      { l1: 1 }
    )
    expect(blocking).toEqual([{ lineId: "l1", productName: "Widget", assigned: 1, required: 2 }])
  })

  it("2 of 2 assigned passes", () => {
    expect(
      linesBlockingServiced(
        [{ id: "l1", product_name: "Widget", quantity_requested: 2, requires_serial: true }],
        { l1: 2 }
      )
    ).toEqual([])
  })

  it("a stocked non-Starlink line blocks serviced once requires_serial is true", () => {
    const line = {
      id: "fg",
      product_name: "FortiGate 50G",
      quantity_requested: 1,
      requires_serial: true,
    }
    expect(linesBlockingServiced([line], { fg: 0 })).toEqual([
      { lineId: "fg", productName: "FortiGate 50G", assigned: 0, required: 1 },
    ])
    expect(linesBlockingServiced([{ ...line, requires_serial: false }], { fg: 0 })).toEqual([])
  })

  it("requires_serial false with 0 assigned passes even if the name contains starlink", () => {
    expect(
      linesBlockingServiced(
        [
          {
            id: "l1",
            product_name: "Starlink Kit",
            quantity_requested: 2,
            requires_serial: false,
          },
        ],
        { l1: 0 }
      )
    ).toEqual([])
  })

  it("mixed multi-line request names the correct blocking serial-tracked line", () => {
    const blocking = linesBlockingServiced(
      [
        { id: "fg", product_name: "FortiGate 50G", quantity_requested: 1, requires_serial: false },
        {
          id: "sl",
          product_name: "Access Point",
          quantity_requested: 3,
          requires_serial: true,
        },
        { id: "sl2", product_name: "Starlink Mini", quantity_requested: 1, requires_serial: true },
      ],
      { fg: 0, sl: 1, sl2: 1 }
    )
    expect(blocking).toEqual([
      {
        lineId: "sl",
        productName: "Access Point",
        assigned: 1,
        required: 3,
      },
    ])
  })
})

describe("canMarkRequestInvoiced", () => {
  it("0 of 2 blocks invoicing", () => {
    expect(
      canMarkRequestInvoiced({
        lines: [{ id: "l1", product_name: "Widget", quantity_requested: 2, requires_serial: true }],
        assignedCountByLineId: { l1: 0 },
      })
    ).toEqual({
      ok: false,
      message: 'Serial-tracked line "Widget" needs all kit serials assigned (0/2) before invoicing.',
    })
  })

  it("1 of 2 blocks invoicing", () => {
    const result = canMarkRequestInvoiced({
      lines: [{ id: "l1", product_name: "Widget", quantity_requested: 2, requires_serial: true }],
      assignedCountByLineId: { l1: 1 },
    })
    expect(result.ok).toBe(false)
    expect(result.message).toContain("(1/2)")
  })

  it("2 of 2 passes", () => {
    expect(
      canMarkRequestInvoiced({
        lines: [{ id: "l1", product_name: "Widget", quantity_requested: 2, requires_serial: true }],
        assignedCountByLineId: { l1: 2 },
      })
    ).toEqual({ ok: true })
  })

  it("a stocked non-Starlink line blocks invoicing once requires_serial is true", () => {
    const line = {
      id: "fg",
      product_name: "FortiGate 50G",
      quantity_requested: 1,
      requires_serial: true,
    }
    expect(canMarkRequestInvoiced({ lines: [line], assignedCountByLineId: { fg: 0 } }).ok).toBe(false)
    expect(
      canMarkRequestInvoiced({
        lines: [{ ...line, requires_serial: false }],
        assignedCountByLineId: { fg: 0 },
      })
    ).toEqual({ ok: true })
  })

  it("requires_serial false with 0 assigned passes", () => {
    expect(
      canMarkRequestInvoiced({
        lines: [
          { id: "l1", product_name: "FortiGate 50G", quantity_requested: 2, requires_serial: false },
        ],
        assignedCountByLineId: { l1: 0 },
      })
    ).toEqual({ ok: true })
  })

  it("mixed multi-line names the correct blocking line", () => {
    const result = canMarkRequestInvoiced({
      lines: [
        { id: "fg", product_name: "FortiGate 50G", quantity_requested: 1, requires_serial: false },
        {
          id: "sl",
          product_name: "Access Point",
          quantity_requested: 3,
          requires_serial: true,
        },
      ],
      assignedCountByLineId: { fg: 0, sl: 1 },
    })
    expect(result.ok).toBe(false)
    expect(result.message).toContain("Access Point")
    expect(result.message).toContain("(1/3)")
  })
})
