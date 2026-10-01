/**
 * Status × movement type → resulting status.
 * Twin of public.movement_result_status. scripts/verify-movement-transitions.mjs
 * calls the SQL function for every pair and fails if it disagrees with this table.
 * Transfer keeps the current status, including a unit already out on POC or rental.
 * Reversal is not a forward movement. Nothing in this table produces Maintenance:
 * only an inbound reversal (app.quick_scan_reversal) puts a unit there.
 * A loaner is issued In Stock → Sold; Sale Return is how that unit comes back.
 */

export const ITEM_STATUSES = [
  "In Stock",
  "Sold",
  "POC",
  "Rented",
  "Maintenance",
  "RMA Hold",
  "Disposed",
  "Pending Inspection",
]

export const MOVEMENT_TYPES = [
  "Inbound",
  "Sale",
  "POC Out",
  "POC Return",
  "Rental Return",
  "Sale Return",
  "Transfer",
  "Dispose",
  "Rentals",
  "Decommissioned",
  "Inspection Pass",
  "Inspection Fail",
  "Remediation Loaner Issue",
  "Reversal",
]

/** @type {Record<string, Record<string, string>>} */
export const MOVEMENT_RESULT = {
  "In Stock": {
    Sale: "Sold",
    "POC Out": "POC",
    Rentals: "Rented",
    Dispose: "Disposed",
    Transfer: "In Stock",
    "Remediation Loaner Issue": "Sold",
  },
  Sold: {
    "Sale Return": "RMA Hold",
    Decommissioned: "Pending Inspection",
  },
  POC: {
    Sale: "Sold",
    "POC Return": "In Stock",
    Decommissioned: "Pending Inspection",
    Transfer: "POC",
  },
  Rented: {
    "Rental Return": "In Stock",
    Decommissioned: "Pending Inspection",
    Transfer: "Rented",
  },
  Maintenance: {
    Inbound: "In Stock",
    Dispose: "Disposed",
    Transfer: "Maintenance",
  },
  "RMA Hold": {
    Inbound: "In Stock",
    Dispose: "Disposed",
    Transfer: "RMA Hold",
  },
  Disposed: {},
  "Pending Inspection": {
    "Inspection Pass": "In Stock",
    "Inspection Fail": "RMA Hold",
    Dispose: "Disposed",
    Transfer: "Pending Inspection",
  },
}

/** Resulting status, or null when the pair is not allowed. */
export function movementResult(status, type) {
  const next = MOVEMENT_RESULT[status]?.[type]
  return next ?? null
}
