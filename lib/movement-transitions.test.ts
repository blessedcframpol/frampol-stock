import { describe, expect, it } from "vitest"
import type { ItemStatus, TransactionType } from "@/lib/data"
import { ITEM_STATUSES, MOVEMENT_TYPES, movementResult } from "@/lib/movement-transitions.mjs"
import { validateMovementForItem } from "@/lib/supabase/movement-utils"

describe("movement matrix", () => {
  it("allows Sale from POC and keeps every other pair aligned with validateMovementForItem", () => {
    for (const status of ITEM_STATUSES) {
      for (const type of MOVEMENT_TYPES) {
        const result = movementResult(status, type)
        const reason = validateMovementForItem(
          type as TransactionType,
          {
            id: "INV-1",
            serialNumber: "SN-1",
            name: "Kit",
            vendor: "Starlink",
            dateAdded: "2026-01-01",
            location: "Warehouse A",
            status: status as ItemStatus,
          },
          {}
        )
        if (result) {
          expect(reason, `${type} from ${status}`).toBeNull()
        } else {
          expect(reason, `${type} from ${status}`).toEqual(expect.any(String))
        }
      }
    }
  })

  it("never sends a unit into Maintenance", () => {
    for (const status of ITEM_STATUSES) {
      if (status === "Maintenance") continue
      for (const type of MOVEMENT_TYPES) {
        expect(movementResult(status, type), `${type} from ${status}`).not.toBe("Maintenance")
      }
    }
  })

  it("records In Stock, POC, and rental conversion as Sale sources", () => {
    expect(movementResult("POC", "Sale")).toBe("Sold")
    expect(movementResult("In Stock", "Sale")).toBe("Sold")
    expect(movementResult("Rented", "Sale")).toBe("Sold")
  })
})
